import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=500;",
    );
    const version = this.one("PRAGMA user_version")?.user_version ?? 0;
    if (version === 0)
      this.db.exec(
        readFileSync(
          fileURLToPath(
            new URL(
              "../../docs/engineering_v0.5/database/001_initial.sql",
              import.meta.url,
            ),
          ),
          "utf8",
        ),
      );
    else if (version !== 1) throw Error("Unsupported database version");
    // Runtime additive migration. Frozen design DDL remains unchanged.
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS runtime_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at_ms INTEGER NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS runtime_session_meta(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),locale TEXT NOT NULL,run_purpose TEXT NOT NULL,start_wall_ms INTEGER) STRICT;
   CREATE TABLE IF NOT EXISTS runtime_display_bindings(session_id TEXT NOT NULL REFERENCES sessions(session_id),record_key TEXT NOT NULL,public_record_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(session_id,record_key)) STRICT;
   CREATE TABLE IF NOT EXISTS runtime_export_artifacts(export_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(session_id),artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json))) STRICT;
   INSERT OR IGNORE INTO runtime_schema_migrations VALUES(1,'private_runtime_snapshots_and_display_lookup',0);`);
  }
  one(sql: string, ...args: any[]): any {
    return this.db.prepare(sql).get(...args);
  }
  all(sql: string, ...args: any[]): any[] {
    return this.db.prepare(sql).all(...args);
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  insert(table: string, data: Record<string, any>) {
    const keys = Object.keys(data);
    this.run(
      `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
      ...keys.map((k) => data[k] ?? null),
    );
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
