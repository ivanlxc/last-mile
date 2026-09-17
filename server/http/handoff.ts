import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import type { HttpConfig } from "./config.js";

const waitingPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="2"><title>LAST MILE · Preparing the next deployment</title>
<style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111b17;color:#e8e7da;font:16px/1.8 system-ui,sans-serif}main{max-width:560px;padding:40px 28px}small{color:#dfb779;letter-spacing:.18em}h1{font-size:34px;line-height:1.2;font-weight:550}p{color:#b9c6ba}hr{border:0;border-top:1px solid #ffffff20;margin:28px 0}</style></head>
<body><main><small>LAST MILE</small><h1>Preparing the next deployment.</h1><p>The game is briefly unavailable while the server changes over. This page refreshes automatically. No new missions or model requests are being started here.</p><hr><section lang="zh-CN"><h2>服务正在交接</h2><p>游戏暂时不可用，页面会自动刷新。此等待入口不会创建新任务或调用模型。</p></section></main></body></html>`;

/** Call only after a real Render startup attempt reports ENGINE_ALREADY_RUNNING.
 * This listener provides process liveness, never database/game readiness.
 * It cannot access a Store, GameService, credentials, sessions, or AI provider.
 */
export async function listenForHandoff(
  config: HttpConfig,
): Promise<{ close(): Promise<void> }> {
  if (config.mode !== "cloud")
    throw new Error("Render handoff requires cloud mode");
  const server = createServer(
    {
      maxHeaderSize: 16 * 1024,
      requestTimeout: 5000,
      headersTimeout: 5000,
      keepAliveTimeout: 1000,
    },
    (req, res) => {
      res.setHeader("Connection", "close");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      const host =
        typeof req.headers.host === "string"
          ? req.headers.host.toLowerCase()
          : "";
      const origin = req.headers.origin;
      if (
        !config.allowedHosts.has(host) ||
        (origin !== undefined &&
          (typeof origin !== "string" || !config.allowedOrigins.has(origin))) ||
        req.headers["sec-fetch-site"] === "cross-site"
      ) {
        return problem(req, res, 403);
      }
      const path = (req.url ?? "/").split("?")[0]!;
      if (req.method === "GET" && path === "/_platform/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "handoff" }));
        return;
      }
      if (
        req.method === "GET" &&
        !path.startsWith("/api/") &&
        (req.headers.accept ?? "").includes("text/html")
      ) {
        res.writeHead(503, {
          "Content-Type": "text/html; charset=utf-8",
          "Retry-After": "2",
        });
        res.end(waitingPage);
        return;
      }
      // Reject before reading bodies. Connection: close bounds outstanding input.
      problem(req, res, 503);
    },
  );
  server.maxRequestsPerSocket = 1;
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let closing: Promise<void> | undefined;
  return {
    close() {
      if (!closing)
        closing = new Promise<void>((resolve, reject) => {
          // Stop acceptance before dropping existing sockets; calling twice reuses the promise.
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      return closing;
    },
  };
}

function problem(
  _req: IncomingMessage,
  res: ServerResponse,
  status: 403 | 503,
): void {
  const code = status === 403 ? "CAPABILITY_DENIED" : "SERVICE_UNAVAILABLE";
  const detail =
    status === 403
      ? "This request origin is not permitted."
      : "The game engine is changing over. Try again shortly.";
  res.writeHead(status, {
    "Content-Type": "application/problem+json",
    ...(status === 503 ? { "Retry-After": "2" } : {}),
  });
  res.end(
    JSON.stringify({
      type: `urn:last-mile:problem:${code.toLowerCase().replaceAll("_", "-")}`,
      title: detail,
      status,
      code,
      requestId: randomUUID(),
      retryable: status === 503,
      currentStateVersion: null,
      detail,
      violations: [],
    }),
  );
}
