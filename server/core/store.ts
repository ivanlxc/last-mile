import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PostgresDriver } from "./postgres.js";
import { safeInteger } from "./postgres-sql.js";
import { StorageError, safeStorageError } from "./postgres-errors.js";
export { StorageError } from "./postgres-errors.js";

export interface StoreOptions {
  dbPath?: string;
  databaseUrl?: string;
  /** Bounded engine lease wait; useful for deploy overlap and isolated tests. */
  startupLockTimeoutMs?: number;
}
export interface StoreResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}
export interface StoreHealth {
  dialect: "sqlite" | "postgres";
  status: "ready" | "unavailable" | "closed";
}
export interface Store {
  readonly dialect: "sqlite" | "postgres";
  one(sql: string, ...args: any[]): Promise<any | undefined>;
  all(sql: string, ...args: any[]): Promise<any[]>;
  run(sql: string, ...args: any[]): Promise<StoreResult>;
  insert(table: string, data: Record<string, any>): Promise<StoreResult>;
  transaction<T>(callback: () => Promise<T> | T): Promise<T>;
  health(): StoreHealth;
  close(): Promise<void>;
}
export interface Driver {
  readonly dialect: "sqlite" | "postgres";
  initialize(): Promise<void>;
  all(sql: string, args: unknown[]): Promise<any[]>;
  run(sql: string, args: unknown[]): Promise<StoreResult>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  health(): StoreHealth;
  close(): Promise<void>;
}
interface TransactionContext {
  active: boolean;
  rollbackOnly: boolean;
  failure: unknown;
}

class QueuedStore implements Store {
  readonly dialect;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<TransactionContext>();
  private accepting = true;
  private closing: Promise<void> | undefined;
  constructor(private readonly driver: Driver) {
    this.dialect = driver.dialect;
  }
  health() {
    return this.driver.health();
  }
  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new StorageError("STORAGE_CLOSED"));
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  private async operation<T>(operation: () => Promise<T>): Promise<T> {
    const tx = this.context.getStore();
    if (!tx) return this.schedule(operation);
    // A background promise spawned in a transaction inherits ALS after commit.
    // It must not accidentally become a new privileged/unsynchronized operation.
    if (!tx.active) throw new StorageError("TX_CONTEXT_EXPIRED");
    if (tx.rollbackOnly) throw new StorageError("TRANSACTION_ROLLBACK_ONLY");
    try {
      return await operation();
    } catch (error) {
      tx.rollbackOnly = true;
      tx.failure = error;
      throw error;
    }
  }
  private values(args: unknown[]): unknown[] {
    return args.map((value) => {
      if (value === undefined) return null;
      if (typeof value === "number" && !Number.isSafeInteger(value))
        throw new StorageError("STORAGE_UNSAFE_INTEGER");
      if (
        typeof value === "bigint" &&
        (value > BigInt(Number.MAX_SAFE_INTEGER) ||
          value < BigInt(Number.MIN_SAFE_INTEGER))
      )
        throw new StorageError("STORAGE_UNSAFE_INTEGER");
      return value;
    });
  }
  async one(sql: string, ...args: unknown[]) {
    return (await this.all(sql, ...args))[0];
  }
  async all(sql: string, ...args: unknown[]) {
    return this.operation(() => this.driver.all(sql, this.values(args)));
  }
  async run(sql: string, ...args: unknown[]) {
    return this.operation(() => this.driver.run(sql, this.values(args)));
  }
  async insert(
    table: string,
    data: Record<string, unknown>,
  ): Promise<StoreResult> {
    const keys = Object.keys(data);
    if (
      ![table, ...keys].every((key) => /^[a-z][a-z0-9_]*$/.test(key)) ||
      !keys.length
    )
      throw new StorageError("INVALID_SQL_IDENTIFIER");
    return this.run(
      `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
      ...keys.map((key) => data[key] ?? null),
    );
  }
  async transaction<T>(callback: () => Promise<T> | T): Promise<T> {
    const current = this.context.getStore();
    if (current) {
      if (!current.active) throw new StorageError("TX_CONTEXT_EXPIRED");
      if (current.rollbackOnly)
        throw new StorageError("TRANSACTION_ROLLBACK_ONLY");
      try {
        return await callback();
      } catch (error) {
        current.rollbackOnly = true;
        current.failure = error;
        throw error;
      }
    }
    return this.schedule(async () => {
      await this.driver.begin();
      const tx: TransactionContext = {
        active: true,
        rollbackOnly: false,
        failure: undefined,
      };
      try {
        const result = await this.context.run(tx, callback);
        tx.active = false;
        if (tx.rollbackOnly) throw tx.failure;
        await this.driver.commit();
        return result;
      } catch (error) {
        tx.active = false;
        await this.driver.rollback().catch(() => {});
        throw error;
      }
    });
  }
  async close(): Promise<void> {
    if (this.context.getStore()?.active)
      throw new StorageError("CLOSE_IN_TRANSACTION");
    if (!this.closing) {
      this.accepting = false;
      this.closing = this.tail.then(() => this.driver.close());
      this.tail = this.closing.catch(() => {});
    }
    return this.closing;
  }
}

const SQLITE_RUNTIME = `
CREATE TABLE IF NOT EXISTS runtime_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS runtime_session_meta(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),locale TEXT NOT NULL,run_purpose TEXT NOT NULL,start_wall_ms INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS runtime_display_bindings(session_id TEXT NOT NULL REFERENCES sessions(session_id),record_key TEXT NOT NULL,public_record_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(session_id,record_key)) STRICT;
CREATE TABLE IF NOT EXISTS runtime_export_artifacts(export_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(session_id),artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json))) STRICT;
INSERT OR IGNORE INTO runtime_schema_migrations VALUES(1,'private_runtime_snapshots_and_display_lookup',0);
CREATE TABLE IF NOT EXISTS cloud_players(player_id TEXT PRIMARY KEY,created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0)) STRICT;
CREATE TABLE IF NOT EXISTS cloud_sessions(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),player_id TEXT NOT NULL REFERENCES cloud_players(player_id)) STRICT;
CREATE INDEX IF NOT EXISTS ix_cloud_sessions_player ON cloud_sessions(player_id);
CREATE TABLE IF NOT EXISTS cloud_creation_keys(player_id TEXT NOT NULL REFERENCES cloud_players(player_id),request_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(session_id),payload_hash TEXT NOT NULL,response_json TEXT NOT NULL CHECK(json_valid(response_json)),created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),PRIMARY KEY(player_id,request_id)) STRICT;
CREATE TABLE IF NOT EXISTS cloud_daily_usage(day TEXT PRIMARY KEY,attempt_count INTEGER NOT NULL CHECK(attempt_count>=0)) STRICT;
CREATE TABLE IF NOT EXISTS cloud_credentials(token_hash TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES cloud_players(player_id),expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=0)) STRICT;
CREATE INDEX IF NOT EXISTS ix_cloud_credentials_player ON cloud_credentials(player_id);
CREATE INDEX IF NOT EXISTS ix_cloud_credentials_expiry ON cloud_credentials(expires_at_ms);
INSERT OR IGNORE INTO runtime_schema_migrations VALUES(2,'durable_cloud_identity_and_usage',0);`;
class SqliteDriver implements Driver {
  readonly dialect = "sqlite" as const;
  private closed = false;
  private db: DatabaseSync;
  constructor(path: string) {
    try {
      if (path !== ":memory:")
        mkdirSync(dirname(resolve(path)), { recursive: true });
      this.db = new DatabaseSync(path);
    } catch (error) {
      throw safeStorageError(error);
    }
  }
  health(): StoreHealth {
    return { dialect: this.dialect, status: this.closed ? "closed" : "ready" };
  }
  async initialize() {
    try {
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=500;",
      );
      const version = this.db
        .prepare("PRAGMA user_version")
        .get()?.user_version;
      if (version === 0)
        this.db.exec(
          readFileSync(
            new URL(
              "../../docs/engineering_v0.5/database/001_initial.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
      else if (version !== 1)
        throw new StorageError("UNSUPPORTED_DATABASE_VERSION");
      this.db.exec("BEGIN IMMEDIATE;" + SQLITE_RUNTIME + "COMMIT;");
    } catch (error) {
      throw safeStorageError(error);
    }
  }
  async all(sql: string, args: any[]) {
    try {
      const statement = this.db.prepare(sql);
      statement.setReadBigInts(true);
      return statement
        .all(...args)
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              typeof value === "bigint" ? safeInteger(value.toString()) : value,
            ]),
          ),
        );
    } catch (error) {
      throw safeStorageError(error);
    }
  }
  async run(sql: string, args: any[]): Promise<StoreResult> {
    try {
      const result = this.db.prepare(sql).run(...args);
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      };
    } catch (error) {
      throw safeStorageError(error);
    }
  }
  async begin() {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw safeStorageError(error);
    }
  }
  async commit() {
    try {
      this.db.exec("COMMIT");
    } catch (error) {
      throw safeStorageError(error);
    }
  }
  async rollback() {
    try {
      this.db.exec("ROLLBACK");
    } catch (error) {
      throw safeStorageError(error);
    }
  }
  async close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
export async function createStore(options: StoreOptions = {}): Promise<Store> {
  const driver =
    options.databaseUrl !== undefined
      ? new PostgresDriver(options)
      : new SqliteDriver(options.dbPath ?? ":memory:");
  try {
    await driver.initialize();
    return new QueuedStore(driver);
  } catch (error) {
    await driver.close().catch(() => {});
    throw safeStorageError(error);
  }
}
