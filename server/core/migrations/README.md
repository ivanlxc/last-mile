# Runtime storage migrations

`createStore({ dbPath?, databaseUrl? })` returns the asynchronous storage adapter. Supplying `databaseUrl` selects PostgreSQL; a connection failure never falls back to SQLite. Without it, local SQLite remains available, including `:memory:` for tests.

## PostgreSQL

- `001_postgres.sql` translates all 35 baseline tables and all 117 named triggers from the frozen `docs/engineering_v0.5/database/001_initial.sql`. The original DDL is unchanged. `tests/storage/generate-postgres.py` reproduces this checked-in translation and records its source SHA-256.
- `002_postgres_runtime.sql` adds the four existing runtime support tables and five durable cloud identity/ownership/usage tables. Both adapters create the same 44 application tables.
- Startup applies the migration transactionally to a dedicated application database. An existing baseline version other than 1 is rejected. Startup does not import historical local SQLite saves into PostgreSQL.
- Circular foreign keys are created after all tables, with their original deferred constraints preserved. Trigger `WHEN` expressions become function-level conditions because PostgreSQL trigger `WHEN` clauses cannot contain the source subqueries.
- JSON remains **TEXT**, preserving exact canonical bytes, hashes, and immutable equality. Integer columns use BIGINT; application decoding rejects values outside JavaScript's safe integer range.

Use a **direct database connection**, not a transaction pooler. The adapter holds a dedicated PostgreSQL connection and a database-scoped session advisory lock for the game engine's lifetime. A second engine retries acquisition for at most five seconds, then fails with `ENGINE_ALREADY_RUNNING`. Do not weaken this fence to accommodate deployment overlap. Single-instance deployment and the platform's real stop/start behavior still require deployment validation.

All adapter operations are serialized. A transaction holds that connection and an advisory transaction lock across awaited calls. AsyncLocalStorage binds nested queries to the transaction; nested transaction failures make the outer transaction rollback-only. Unrelated reads wait outside the transaction. Detached work carrying a completed transaction context is rejected as `TX_CONTEXT_EXPIRED`.

After a lost connection, the next new operation reconnects and reacquires the engine lease. A failed or possibly committed operation is **never automatically repeated**. The caller must retry the same idempotent command key. `health()` is an in-memory status observation; it does not query the database or keep an idle provider awake. Remote URLs use certificate and hostname verification (`sslmode=verify-full`); insecure verification modes are rejected. Driver errors do not expose the connection URL, query parameters, or raw diagnostic details.

## Verification

Run the portable SQLite and SQL translation tests:

```bash
pnpm exec vitest run tests/storage
```

To include PostgreSQL, inject `PG_TEST_URL` for an **isolated test cluster** and run the same command. That role must be able to create and drop temporary databases. Tests create random `last_mile_storage_*` databases and remove only those databases; never point this suite at a production cluster. They cover schema parity, serialized reads, rollback, retained transaction contexts, JSON bytes, safe integers, foreign keys, ledger/attempt limits, manifests, terminal seals, durable cloud data, engine fencing and disconnection recovery.

Local verification is not proof of Render deployment behavior, Neon sleep/cold-start latency, remote TLS routing, provider limits, or internet failure recovery. Those need a separate deployed smoke test using the real hosting configuration.
