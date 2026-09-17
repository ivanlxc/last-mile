import { StorageError } from "./postgres-errors.js";

/** Translate only the SQLite syntax used by the core; values remain parameters. */
export function postgresSql(source: string): string {
  let sql = source.trim().replace(/;\s*$/, "");
  const ignore = /^INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
  const replace = /^INSERT\s+OR\s+REPLACE\s+INTO\b/i.test(sql);
  if (
    replace &&
    !/^INSERT\s+OR\s+REPLACE\s+INTO\s+runtime_display_bindings\b/i.test(sql)
  )
    throw new StorageError("UNSUPPORTED_SQLITE_REPLACE");
  sql = sql.replace(/^INSERT\s+OR\s+(IGNORE|REPLACE)\s+INTO\b/i, "INSERT INTO");
  sql = sql.replace(
    /json_extract\(([^,()]+),\s*'\$\.([A-Za-z0-9_]+)'\)/g,
    (_, value: string, key: string) => `(${value}::json ->> '${key}')`,
  );
  // The scanner does not substitute question marks inside quoted text/comments.
  let out = "",
    parameter = 0;
  for (let i = 0; i < sql.length;) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += sql[i++];
      while (i < sql.length) {
        const next = sql[i++]!;
        out += next;
        if (next === quote) {
          if (sql[i] === quote) {
            out += sql[i++];
            continue;
          }
          break;
        }
      }
    } else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      out += sql.slice(i, end === -1 ? sql.length : end + 1);
      i = end === -1 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new StorageError("INVALID_SQL_COMMENT");
      out += sql.slice(i, end + 2);
      i = end + 2;
    } else {
      out += ch === "?" ? `$${++parameter}` : ch;
      i++;
    }
  }
  if (ignore) out += " ON CONFLICT DO NOTHING";
  if (replace)
    out +=
      " ON CONFLICT (session_id,record_key) DO UPDATE SET public_record_id=EXCLUDED.public_record_id,revision=EXCLUDED.revision";
  return out;
}
export function safeInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new StorageError("STORAGE_UNSAFE_INTEGER");
  return number;
}
