import type { IncomingHttpHeaders } from "node:http";

// Cached public HTML must not reuse a response from another fetch context.
export const requestContextVary =
  "Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest";

/** Opening a shared game link is safe: the shell grants no identity or game data.
 * Keep APIs, subresources, embedded pages and local-mode entry outside this exception.
 * Host and explicit Origin validation still applies at the caller.
 */
export function isPublicDocumentNavigation(
  mode: "local" | "cloud",
  method: string,
  url: string,
  headers: IncomingHttpHeaders,
): boolean {
  const path = url.split("?")[0];
  return (
    mode === "cloud" &&
    (method === "GET" || method === "HEAD") &&
    (path === "/" || path === "/index.html") &&
    headers["sec-fetch-mode"] === "navigate" &&
    headers["sec-fetch-dest"] === "document"
  );
}
