/** Errors are intentionally free of URLs, SQL parameters and driver detail. */
export class StorageError extends Error {
  constructor(
    readonly code: string,
    readonly sqlState?: string,
  ) {
    super(code);
    this.name = "StorageError";
  }
}
export function safeStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e?.code === "string" ? e.code : "";
  const message = typeof e?.message === "string" ? e.message : "";
  // Application trigger exceptions contain only fixed uppercase identifiers.
  if (/^[A-Z][A-Z0-9_]{2,100}$/.test(message)) return new StorageError(message);
  if (
    code === "40001" ||
    code === "40P01" ||
    code === "55P03" ||
    /database is locked/i.test(message)
  )
    return new StorageError(
      "STORAGE_BUSY",
      /^[0-9A-Z]{5}$/.test(code) ? code : undefined,
    );
  if (/^23/.test(code) || /constraint failed/i.test(message))
    return new StorageError(
      "STORAGE_CONSTRAINT",
      /^23[0-9A-Z]{3}$/.test(code) ? code : undefined,
    );
  return new StorageError(
    "STORAGE_UNAVAILABLE",
    /^[0-9A-Z]{5}$/.test(code) ? code : undefined,
  );
}
