import { Client, types } from "pg";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { postgresSql, safeInteger } from "./postgres-sql.js";
import { StorageError, safeStorageError } from "./postgres-errors.js";
import type {
  Driver,
  StoreOptions,
  StoreResult,
  StoreHealth,
} from "./store.js";

// Stable application namespace; PostgreSQL advisory locks are database scoped.
const LOCK_NAMESPACE = 1279349581;
const ENGINE_LEASE = 1;
const WRITE_TRANSACTION = 2;
/** Remote databases always use certificate + hostname verification. */
export function strictPostgresUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol))
      throw new Error();
    if (parsed.hostname.includes("-pooler."))
      throw new StorageError("POSTGRES_DIRECT_CONNECTION_REQUIRED");
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
      parsed.hostname,
    );
    const mode = parsed.searchParams.get("sslmode");
    if (mode === "no-verify" || (!loopback && mode === "disable"))
      throw new StorageError("POSTGRES_TLS_REQUIRED");
    if (!loopback || (mode && mode !== "disable")) {
      parsed.searchParams.set("sslmode", "verify-full");
      parsed.searchParams.delete("uselibpqcompat");
      parsed.searchParams.delete("ssl");
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("INVALID_DATABASE_URL");
  }
}
export class PostgresDriver implements Driver {
  readonly dialect = "postgres" as const;
  private client: Client | undefined;
  private broken = true;
  private stopped = false;
  private inTransaction = false;
  private connecting = false;
  private readonly url: string;
  private readonly lockWaitMs: number;
  constructor(options: StoreOptions) {
    this.url = strictPostgresUrl(options.databaseUrl!);
    this.lockWaitMs = options.startupLockTimeoutMs ?? 5000;
    if (
      !Number.isSafeInteger(this.lockWaitMs) ||
      this.lockWaitMs < 0 ||
      this.lockWaitMs > 30000
    )
      throw new StorageError("INVALID_STARTUP_LOCK_TIMEOUT");
  }
  health(): StoreHealth {
    return {
      dialect: this.dialect,
      status: this.stopped
        ? "closed"
        : this.broken || this.connecting
          ? "unavailable"
          : "ready",
    };
  }
  private async connect(): Promise<void> {
    if (this.stopped) throw new StorageError("STORAGE_CLOSED");
    if (!this.broken && this.client) return;
    if (this.inTransaction) throw new StorageError("STORAGE_CONNECTION_LOST");
    this.connecting = true;
    const previous = this.client;
    this.client = undefined;
    if (previous) await previous.end().catch(() => {});
    const client = new Client({
      connectionString: this.url,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      query_timeout: 20000,
      keepAlive: true,
      application_name: "last-mile-engine",
      // No rejectUnauthorized override: use pg's strict TLS verification.
      types: {
        getTypeParser(oid: number, format?: "text" | "binary") {
          if (oid === 20 && format !== "binary") return safeInteger;
          return types.getTypeParser(oid, format);
        },
      },
    });
    client.on("error", () => {
      if (this.client === client) this.broken = true;
    });
    client.on("end", () => {
      if (this.client === client) this.broken = true;
    });
    try {
      await client.connect();
      const deadline = performance.now() + this.lockWaitMs;
      for (;;) {
        const result = await client.query(
          "SELECT pg_try_advisory_lock($1,$2) AS locked",
          [LOCK_NAMESPACE, ENGINE_LEASE],
        );
        if (result.rows[0]?.locked === true) break;
        if (performance.now() >= deadline)
          throw new StorageError("ENGINE_ALREADY_RUNNING");
        await delay(Math.min(100, Math.max(1, deadline - performance.now())));
      }
      await client.query("SET search_path TO public");
      this.client = client;
      this.broken = false;
    } catch (error) {
      await client.end().catch(() => {});
      this.broken = true;
      throw safeStorageError(error);
    } finally {
      this.connecting = false;
    }
  }
  private async query(
    sql: string,
    args: unknown[] = [],
  ): Promise<{ rows: any[]; rowCount: number | null }> {
    await this.connect();
    try {
      return await this.client!.query(sql, args);
    } catch (error) {
      const e = error as { code?: string; message?: string };
      if (
        !e.code ||
        /^(08|57P0)/.test(e.code) ||
        /^(ECONN|ETIMEDOUT|EPIPE)/.test(e.code)
      )
        this.broken = true;
      throw safeStorageError(error);
    }
  }
  async initialize(): Promise<void> {
    await this.connect();
    try {
      await this.begin();
      const exists = await this.query(
        "SELECT to_regclass('public.schema_migrations') AS existing",
      );
      if (!exists.rows[0]?.existing)
        await this.query(
          readFileSync(
            new URL("./migrations/001_postgres.sql", import.meta.url),
            "utf8",
          ),
        );
      else {
        const version = await this.query(
          "SELECT MAX(version) AS version FROM schema_migrations",
        );
        if (version.rows[0]?.version !== 1)
          throw new StorageError("UNSUPPORTED_DATABASE_VERSION");
      }
      await this.query(
        readFileSync(
          new URL("./migrations/002_postgres_runtime.sql", import.meta.url),
          "utf8",
        ),
      );
      await this.commit();
    } catch (error) {
      await this.rollback();
      throw safeStorageError(error);
    }
  }
  async all(sql: string, args: unknown[]): Promise<any[]> {
    return (await this.query(postgresSql(sql), args)).rows;
  }
  async run(sql: string, args: unknown[]): Promise<StoreResult> {
    const result = await this.query(postgresSql(sql), args);
    return { changes: result.rowCount ?? 0 };
  }
  async begin(): Promise<void> {
    await this.connect();
    await this.query("BEGIN");
    this.inTransaction = true;
    try {
      await this.query("SELECT pg_advisory_xact_lock($1,$2)", [
        LOCK_NAMESPACE,
        WRITE_TRANSACTION,
      ]);
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }
  async commit(): Promise<void> {
    try {
      await this.query("COMMIT");
    } finally {
      this.inTransaction = false;
    }
  }
  async rollback(): Promise<void> {
    try {
      if (this.inTransaction && !this.broken) await this.query("ROLLBACK");
    } finally {
      this.inTransaction = false;
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.broken = true;
    const client = this.client;
    this.client = undefined;
    // Closing the dedicated connection releases its engine lease, including on
    // a failed transaction. Never issue an unlock on an unrelated new connection.
    if (client) await client.end().catch(() => {});
  }
}
