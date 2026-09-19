/** Unity names precompressed build files explicitly in its loader manifest. */
export function unityAssetHeaders(fileName: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  let logicalName = fileName.toLowerCase();
  if (logicalName.endsWith(".gz") || logicalName.endsWith(".br")) {
    headers["Content-Encoding"] = logicalName.endsWith(".gz") ? "gzip" : "br";
    logicalName = logicalName.slice(0, -3);
  }
  if (logicalName.endsWith(".wasm"))
    headers["Content-Type"] = "application/wasm";
  else if (logicalName.endsWith(".js"))
    headers["Content-Type"] = "application/javascript; charset=utf-8";
  else if (logicalName.endsWith(".json"))
    headers["Content-Type"] = "application/json; charset=utf-8";
  else if (logicalName.endsWith(".data") || logicalName.endsWith(".unityweb"))
    // .unityweb is decompressed by Unity's JS fallback, not by HTTP.
    headers["Content-Type"] = "application/octet-stream";
  return headers;
}

export function isUnityAssetRequest(url: string): boolean {
  let pathname = url.split("?")[0] ?? "";
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Malformed URLs are rejected elsewhere; never treat /unity as an SPA route.
  }
  return pathname === "/unity" || pathname.startsWith("/unity/");
}
