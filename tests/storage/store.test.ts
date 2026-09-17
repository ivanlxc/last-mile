import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
} from "vitest";
import { Client } from "pg";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createStore,
  type Store,
  type StoreOptions,
} from "../../server/core/store.js";
import { postgresSql } from "../../server/core/postgres-sql.js";
import { strictPostgresUrl } from "../../server/core/postgres.js";
import {
  a,
  b,
  ids,
  uid,
  seed,
  ledger,
  evidence,
  reportAndUpload,
  manifest,
  advisor,
  seal,
} from "./fixtures.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const pgUrl = process.env.PG_TEST_URL;
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !pgUrl)(
    `${dialect}: asynchronous durable storage`,
    () => {
      let store: Store,
        options: StoreOptions,
        directory: string,
        database: string;
      let admin: Client | undefined;
      beforeAll(async () => {
        if (dialect === "postgres") {
          admin = new Client({ connectionString: pgUrl });
          await admin.connect();
        }
      });
      afterAll(async () => {
        await admin?.end();
      });
      beforeEach(async () => {
        if (dialect === "postgres") {
          database = "last_mile_storage_" + uid().replaceAll("-", "");
          await admin!.query(`CREATE DATABASE ${database}`);
          const url = new URL(pgUrl!);
          url.pathname = "/" + database;
          options = { databaseUrl: url.toString(), startupLockTimeoutMs: 80 };
        } else {
          directory = mkdtempSync(join(tmpdir(), "last-mile-storage-"));
          options = { dbPath: join(directory, "test.sqlite") };
        }
        store = await createStore(options);
        await seed(store);
      });
      afterEach(async () => {
        await store?.close();
        if (dialect === "postgres")
          await admin!.query(`DROP DATABASE ${database} WITH (FORCE)`);
        else if (directory) rmSync(directory, { recursive: true, force: true });
      });

      it("creates every baseline and cloud table and preserves all 117 triggers", async () => {
        const tables = await store.one(
          dialect === "sqlite"
            ? "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'"
            : "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema='public'",
        );
        const triggers = await store.one(
          dialect === "sqlite"
            ? "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'"
            : "SELECT COUNT(*) AS n FROM pg_trigger WHERE NOT tgisinternal",
        );
        expect(tables.n).toBe(44);
        expect(triggers.n).toBe(117);
        expect(await store.one("SELECT COUNT(*) AS n FROM sessions")).toEqual({
          n: 2,
        });
        expect(store.health()).toEqual({ dialect, status: "ready" });
      });
      it("preserves JSON text bytes and safely roundtrips epoch milliseconds", async () => {
        const raw = '{ "z": 1, "a": [2, 3] }',
          stamp = 1_800_000_000_123;
        const id = uid();
        await store.insert("content_versions", {
          content_version_id: id,
          content_hash: "a".repeat(64),
          schema_version: "test",
          registry_json: raw,
          created_at_ms: stamp,
        });
        expect(
          await store.one(
            "SELECT registry_json,created_at_ms FROM content_versions WHERE content_version_id=?",
            id,
          ),
        ).toEqual({ registry_json: raw, created_at_ms: stamp });
        await expect(
          store.one("SELECT CAST(9007199254740992 AS BIGINT) AS n"),
        ).rejects.toMatchObject({ code: "STORAGE_UNSAFE_INTEGER" });
        await expect(
          store.run(
            "INSERT INTO cloud_daily_usage(day,attempt_count) VALUES(?,?)",
            "unsafe",
            Number.MAX_SAFE_INTEGER + 1,
          ),
        ).rejects.toMatchObject({ code: "STORAGE_UNSAFE_INTEGER" });
      });
      it("supports bound question marks, ignore and the targeted display binding upsert", async () => {
        expect(
          await store.one("SELECT '?' AS literal, ? AS value", "value?"),
        ).toEqual({ literal: "?", value: "value?" });
        await store.run(
          "INSERT OR IGNORE INTO cloud_daily_usage(day,attempt_count) VALUES(?,?)",
          "2099-01-01",
          2,
        );
        const ignored = await store.run(
          "INSERT OR IGNORE INTO cloud_daily_usage(day,attempt_count) VALUES(?,?)",
          "2099-01-01",
          9,
        );
        expect(ignored.changes).toBe(0);
        expect(
          await store.one(
            "SELECT attempt_count FROM cloud_daily_usage WHERE day=?",
            "2099-01-01",
          ),
        ).toEqual({ attempt_count: 2 });
        await store.run(
          "INSERT OR REPLACE INTO runtime_display_bindings VALUES(?,?,?,1)",
          a.sessionId,
          "test",
          "first",
        );
        await store.run(
          "INSERT OR REPLACE INTO runtime_display_bindings VALUES(?,?,?,1)",
          a.sessionId,
          "test",
          "second",
        );
        expect(
          await store.one(
            "SELECT public_record_id FROM runtime_display_bindings WHERE session_id=? AND record_key=?",
            a.sessionId,
            "test",
          ),
        ).toEqual({ public_record_id: "second" });
        expect(
          await store.one(
            "SELECT json_extract(?,'$.sceneId') AS scene",
            '{"sceneId":"E1"}',
          ),
        ).toEqual({ scene: "E1" });
      });
      it("serializes unrelated reads behind a transaction across awaits", async () => {
        const entered = latch(),
          release = latch();
        const tx = store.transaction(async () => {
          await store.insert("cloud_players", {
            player_id: "queued",
            created_at_ms: 1,
          });
          entered.resolve();
          await release.promise;
        });
        await entered.promise;
        let readFinished = false;
        const read = store
          .one("SELECT COUNT(*) AS n FROM cloud_players")
          .then((row) => {
            readFinished = true;
            return row;
          });
        await delay(20);
        expect(readFinished).toBe(false);
        release.resolve();
        await tx;
        expect(await read).toEqual({ n: 1 });
      });
      it("rolls back the complete awaited transaction on domain failure", async () => {
        await expect(
          store.transaction(async () => {
            await ledger(store, a.accounts.drone!);
            await delay(1);
            throw new Error("synthetic failure");
          }),
        ).rejects.toThrow("synthetic failure");
        expect(
          await store.one(
            "SELECT available,spent FROM quota_accounts WHERE session_id=? AND account_id=?",
            a.sessionId,
            a.accounts.drone,
          ),
        ).toEqual({ available: 3, spent: 0 });
      });
      it("joins nested transactions and marks a swallowed nested failure rollback-only", async () => {
        await expect(
          store.transaction(async () => {
            await store.insert("cloud_players", {
              player_id: "outer",
              created_at_ms: 1,
            });
            await store
              .transaction(async () => {
                await store.insert("cloud_players", {
                  player_id: "inner",
                  created_at_ms: 1,
                });
                throw new Error("inner fixture failure");
              })
              .catch(() => {});
          }),
        ).rejects.toThrow("inner fixture failure");
        expect(
          await store.one("SELECT COUNT(*) AS n FROM cloud_players"),
        ).toEqual({ n: 0 });
      });
      it("rejects a detached promise that retains a committed transaction context", async () => {
        const gate = latch();
        let detached!: Promise<unknown>;
        await store.transaction(async () => {
          detached = gate.promise.then(() => store.one("SELECT 1 AS n"));
        });
        const assertion = expect(detached).rejects.toMatchObject({
          code: "TX_CONTEXT_EXPIRED",
        });
        gate.resolve();
        await assertion;
        expect(await store.one("SELECT 1 AS n")).toEqual({ n: 1 });
      });
      it("keeps cloud identity, owner binding, creation idempotency and budget durable", async () => {
        const player = uid(),
          token = "b".repeat(64),
          request = uid();
        await store.transaction(async () => {
          await store.insert("cloud_players", {
            player_id: player,
            created_at_ms: 1_800_000_000_000,
          });
          await store.insert("cloud_sessions", {
            session_id: a.sessionId,
            player_id: player,
          });
          await store.insert("cloud_credentials", {
            token_hash: token,
            player_id: player,
            expires_at_ms: 1_900_000_000_000,
          });
          await store.insert("cloud_creation_keys", {
            player_id: player,
            request_id: request,
            session_id: a.sessionId,
            payload_hash: "c".repeat(64),
            response_json: '{ "ok": true }',
            created_at_ms: 1000,
          });
          await store.insert("cloud_daily_usage", {
            day: "2099-01-01",
            attempt_count: 3,
          });
        });
        await expect(
          store.insert("cloud_creation_keys", {
            player_id: player,
            request_id: request,
            session_id: b.sessionId,
            payload_hash: "d".repeat(64),
            response_json: "{}",
            created_at_ms: 1000,
          }),
        ).rejects.toMatchObject({ code: "STORAGE_CONSTRAINT" });
        await store.close();
        store = await createStore(options);
        expect(
          await store.one(
            "SELECT player_id,expires_at_ms FROM cloud_credentials WHERE token_hash=?",
            token,
          ),
        ).toEqual({ player_id: player, expires_at_ms: 1_900_000_000_000 });
        expect(
          await store.one(
            "SELECT response_json FROM cloud_creation_keys WHERE player_id=? AND request_id=?",
            player,
            request,
          ),
        ).toEqual({ response_json: '{ "ok": true }' });
        expect(
          await store.one(
            "SELECT attempt_count FROM cloud_daily_usage WHERE day=?",
            "2099-01-01",
          ),
        ).toEqual({ attempt_count: 3 });
      });
      it("rejects invalid JSON, wrong-session actors, review-profile normal play and immutable mutation", async () => {
        await expect(
          store.insert("content_versions", {
            content_version_id: uid(),
            content_hash: "d".repeat(64),
            schema_version: "x",
            registry_json: "not JSON",
            created_at_ms: 0,
          }),
        ).rejects.toBeDefined();
        await expect(
          store.insert("commands", {
            session_id: a.sessionId,
            request_id: uid(),
            run_epoch: a.runEpoch,
            binding_id: b.actors.commander,
            command_kind: "task",
            payload_hash: "a".repeat(64),
            accepted_state_version: 1,
            response_status: 202,
            response_json: "{}",
            accepted_at_ms: 1000,
          }),
        ).rejects.toMatchObject({ code: "STORAGE_CONSTRAINT" });
        await expect(
          store.insert("sessions", {
            session_id: uid(),
            run_epoch: uid(),
            launch_id: ids.launchId,
            mode: "normal",
            content_hash: ids.contentHash,
            policy_hash: ids.policyHash,
            private_case_id: "fixture",
            created_at_ms: 1000,
            updated_at_ms: 1000,
          }),
        ).rejects.toThrow("POLICY_NOT_APPROVED");
        await expect(
          store.run("UPDATE content_versions SET schema_version='changed'"),
        ).rejects.toThrow("IMMUTABLE_RECORD");
      });
      it("enforces ledger accounting, overdraw, parent limit and rollback atomically", async () => {
        const account = a.accounts["E1:analyst:report"]!;
        const reserved = await ledger(store, account, "reserve", 2);
        await ledger(store, account, "spend", 1, reserved);
        await ledger(store, account, "release", 1, reserved);
        expect(
          await store.one(
            "SELECT available,reserved,spent FROM quota_accounts WHERE session_id=? AND account_id=?",
            a.sessionId,
            account,
          ),
        ).toEqual({ available: 2, reserved: 0, spent: 1 });
        await expect(
          ledger(store, account, "release", 1, reserved),
        ).rejects.toBeDefined();
        await ledger(store, a.accounts.drone!, "spend", 3);
        await expect(ledger(store, a.accounts.drone!)).rejects.toThrow(
          "QUOTA_EXHAUSTED_OR_STALE",
        );
        await expect(
          store.run(
            "UPDATE quota_accounts SET available=1,spent=2 WHERE session_id=? AND account_id=?",
            a.sessionId,
            a.accounts.drone,
          ),
        ).rejects.toThrow("QUOTA_DIRECT_UPDATE_FORBIDDEN");
      });
      it("preserves numeric JSON policy limits and event sequence triggers", async () => {
        await expect(
          store.insert("quota_accounts", {
            session_id: a.sessionId,
            account_id: uid(),
            quota_scope: "scene",
            scene_id: "E1",
            role: "liaison",
            resource: "report",
            capacity: 99,
            available: 99,
          }),
        ).rejects.toThrow("REPORT_CAPACITY_POLICY");
        await expect(
          store.insert("events", {
            session_id: a.sessionId,
            seq: 9,
            event_id: uid(),
            kind: "fixture",
            mission_ms: 0,
            state_version: 1,
            actor_kind: "rules",
            payload_json: "{}",
            recorded_at_ms: 1000,
          }),
        ).rejects.toThrow("EVENT_SEQUENCE_CONFLICT");
        await store.insert("events", {
          session_id: a.sessionId,
          seq: 2,
          event_id: uid(),
          kind: "fixture",
          mission_ms: 0,
          state_version: 1,
          actor_kind: "rules",
          payload_json: "{}",
          recorded_at_ms: 1000,
        });
        expect(
          await store.one(
            "SELECT last_event_seq FROM sessions WHERE session_id=?",
            a.sessionId,
          ),
        ).toEqual({ last_event_seq: 2 });
      });
      it("keeps upload manifests immutable, same-scene and able to use deferred foreign keys", async () => {
        const uploaded = await reportAndUpload(store);
        const m = await manifest(store, [uploaded.uploadId]);
        await expect(
          store.insert("input_manifest_members", {
            session_id: a.sessionId,
            manifest_id: m.manifestId,
            upload_id: uploaded.uploadId,
          }),
        ).rejects.toThrow("MANIFEST_ALREADY_FINALIZED");
        await expect(
          manifest(store, [uploaded.uploadId], "E2"),
        ).rejects.toThrow("MANIFEST_SCENE_MISMATCH");
        await expect(
          store.run(
            "UPDATE evidence_instances SET payload_hash=? WHERE session_id=?",
            "f".repeat(64),
            a.sessionId,
          ),
        ).rejects.toThrow("IMMUTABLE_RECORD");
      });
      it("enforces two attempts, immutable history and the 30-send advisor cap", async () => {
        for (let i = 0; i < 15; i++) {
          const job = await advisor(store);
          await store.run(
            "UPDATE agent_jobs SET status='running' WHERE session_id=? AND job_id=?",
            a.sessionId,
            job,
          );
          for (let attempt = 1; attempt <= 2; attempt++) {
            await store.insert("agent_attempts", {
              session_id: a.sessionId,
              job_id: job,
              attempt_no: attempt,
              request_key: uid(),
              sent_at_ms: 1000,
            });
            await store.run(
              "UPDATE agent_attempts SET status='timeout',finished_at_ms=9000 WHERE session_id=? AND job_id=? AND attempt_no=?",
              a.sessionId,
              job,
              attempt,
            );
          }
          if (i === 0) {
            await expect(
              store.insert("agent_attempts", {
                session_id: a.sessionId,
                job_id: job,
                attempt_no: 3,
                request_key: uid(),
                sent_at_ms: 10000,
              }),
            ).rejects.toThrow("ATTEMPT_NOT_ALLOWED");
            await expect(
              store.run(
                "UPDATE agent_attempts SET status='succeeded' WHERE session_id=? AND job_id=? AND attempt_no=1",
                a.sessionId,
                job,
              ),
            ).rejects.toThrow("ATTEMPT_FINAL");
          }
          await store.run(
            "UPDATE agent_jobs SET status='failed' WHERE session_id=? AND job_id=?",
            a.sessionId,
            job,
          );
        }
        const job = await advisor(store);
        await store.run(
          "UPDATE agent_jobs SET status='running' WHERE session_id=? AND job_id=?",
          a.sessionId,
          job,
        );
        await expect(
          store.insert("agent_attempts", {
            session_id: a.sessionId,
            job_id: job,
            attempt_no: 1,
            request_key: uid(),
            sent_at_ms: 10000,
          }),
        ).rejects.toThrow("ADVISOR_SESSION_CALL_LIMIT");
      });
      it("requires an atomically activated seal and rejects post-terminal gameplay writes", async () => {
        await expect(seal(store, false)).rejects.toBeDefined();
        expect(
          await store.one("SELECT COUNT(*) AS n FROM terminal_seals"),
        ).toEqual({ n: 0 });
        const hash = await seal(store);
        await expect(evidence(store)).rejects.toThrow("SESSION_TERMINAL");
        await expect(
          store.run(
            "UPDATE sessions SET mission_ms=mission_ms+1 WHERE session_id=?",
            a.sessionId,
          ),
        ).rejects.toThrow("SESSION_TERMINAL");
        await expect(
          store.insert("diagnostic_records", {
            session_id: a.sessionId,
            diagnostic_id: uid(),
            category: "postgame_audit",
            recorded_at_ms: 1000,
            payload_json: JSON.stringify({
              sealedHash: "f".repeat(64),
              sessionId: a.sessionId,
              auditId: uid(),
            }),
          }),
        ).rejects.toThrow("POSTGAME_AUDIT_SEAL_MISMATCH");
        const id = uid();
        await store.insert("diagnostic_records", {
          session_id: a.sessionId,
          diagnostic_id: id,
          category: "postgame_audit",
          recorded_at_ms: 1000,
          payload_json: JSON.stringify({
            sealedHash: hash,
            sessionId: a.sessionId,
            auditId: id,
          }),
        });
      });
      it("closes once and refuses subsequent work", async () => {
        await store.close();
        await store.close();
        expect(store.health().status).toBe("closed");
        await expect(store.one("SELECT 1")).rejects.toMatchObject({
          code: "STORAGE_CLOSED",
        });
      });
      if (dialect === "postgres") {
        it("fences another engine and releases its session lease on close", async () => {
          await expect(createStore(options)).rejects.toMatchObject({
            code: "ENGINE_ALREADY_RUNNING",
          });
          await store.close();
          store = await createStore(options);
          expect(store.health().status).toBe("ready");
        });
        it("reconnects after idle disconnect, but only after reacquiring the engine lease", async () => {
          await store.insert("cloud_players", {
            player_id: "retained",
            created_at_ms: 1,
          });
          const pid = (await store.one("SELECT pg_backend_pid() AS pid")).pid;
          await admin!.query("SELECT pg_terminate_backend($1)", [pid]);
          await delay(30);
          expect(store.health().status).toBe("unavailable");
          const competitor = await createStore(options);
          try {
            await expect(store.one("SELECT 1 AS n")).rejects.toMatchObject({
              code: "ENGINE_ALREADY_RUNNING",
            });
          } finally {
            await competitor.close();
          }
          expect(
            await store.one(
              "SELECT player_id FROM cloud_players WHERE player_id=?",
              "retained",
            ),
          ).toEqual({ player_id: "retained" });
          expect(store.health().status).toBe("ready");
        });
        it("does not retry or commit a transaction interrupted by connection loss", async () => {
          await store.insert("cloud_daily_usage", {
            day: "2099-01-01",
            attempt_count: 0,
          });
          let executions = 0;
          await expect(
            store.transaction(async () => {
              executions++;
              await store.run(
                "UPDATE cloud_daily_usage SET attempt_count=attempt_count+1 WHERE day=?",
                "2099-01-01",
              );
              const pid = (await store.one("SELECT pg_backend_pid() AS pid"))
                .pid;
              await admin!.query("SELECT pg_terminate_backend($1)", [pid]);
              await delay(20);
              await store.one("SELECT 1 AS n");
            }),
          ).rejects.toBeDefined();
          expect(executions).toBe(1);
          expect(
            await store.one(
              "SELECT attempt_count FROM cloud_daily_usage WHERE day=?",
              "2099-01-01",
            ),
          ).toEqual({ attempt_count: 0 });
        });
      }
    },
  );
}
describe("migration and adapter safety", () => {
  it("retains a one-to-one named mapping for every frozen trigger", () => {
    const sqlite = readFileSync(
      new URL(
        "../../docs/engineering_v0.5/database/001_initial.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const postgres = readFileSync(
      new URL("../../server/core/migrations/001_postgres.sql", import.meta.url),
      "utf8",
    );
    const names = (text: string) =>
      [...text.matchAll(/^CREATE TRIGGER (\w+)/gm)]
        .map((match) => match[1])
        .sort();
    expect(names(postgres)).toEqual(names(sqlite));
    expect(names(postgres)).toHaveLength(117);
  });
  it("keeps literal question marks and refuses unimplemented replacement semantics", () => {
    expect(postgresSql("SELECT '?', ? AS x -- ?\n/* ? */")).toBe(
      "SELECT '?', $1 AS x -- ?\n/* ? */",
    );
    expect(() =>
      postgresSql("INSERT OR REPLACE INTO sessions VALUES(?)"),
    ).toThrow("UNSUPPORTED_SQLITE_REPLACE");
  });
  it("requires full remote TLS verification, including libpq-compatible URLs", () => {
    for (const query of [
      "",
      "?sslmode=require",
      "?sslmode=require&uselibpqcompat=true",
      "?sslmode=verify-ca",
    ]) {
      const url = new URL(
        strictPostgresUrl("postgres://test@example.invalid/db" + query),
      );
      expect(url.searchParams.get("sslmode")).toBe("verify-full");
      expect(url.searchParams.has("uselibpqcompat")).toBe(false);
    }
    expect(() =>
      strictPostgresUrl("postgres://test@example.invalid/db?sslmode=no-verify"),
    ).toThrow("POSTGRES_TLS_REQUIRED");
    expect(() =>
      strictPostgresUrl("postgres://test@example.invalid/db?sslmode=disable"),
    ).toThrow("POSTGRES_TLS_REQUIRED");
    expect(strictPostgresUrl("postgres://test@127.0.0.1/db")).not.toContain(
      "sslmode",
    );
  });
  it("never exposes credentials through a malformed URL error", async () => {
    await expect(
      createStore({ databaseUrl: "not-a-url-secret-sentinel" }),
    ).rejects.toMatchObject({ message: "INVALID_DATABASE_URL" });
    await expect(
      createStore({
        databaseUrl:
          "postgres://name:secret-sentinel@ep-test-pooler.neon.tech/db",
      }),
    ).rejects.toMatchObject({ message: "POSTGRES_DIRECT_CONNECTION_REQUIRED" });
  });
});
