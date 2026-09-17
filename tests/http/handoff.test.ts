import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, connect, type Socket } from "node:net";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { listenForHandoff } from "../../server/http/handoff.js";
import { loadHttpConfig } from "../../server/http/config.js";
import { createHttpApp } from "../../server/http/app.js";
import type { GameService } from "../../server/core/service.js";
import { ContractRegistry } from "../../server/http/contracts.js";

const origin = "https://handoff.example";
const base = loadHttpConfig({
  LAST_MILE_ROOT: process.cwd(),
  LAST_MILE_MODE: "cloud",
  DATABASE_URL: "postgres://not-used.invalid/test",
  LAST_MILE_PUBLIC_ORIGIN: origin,
  LAST_MILE_INVITE_CODE: "never-published-invite",
  LAST_MILE_COOKIE_SECRET: "never-published-secret".repeat(3),
});
const listeners: Array<{ close(): Promise<void> }> = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const s of listeners.splice(0)) await s.close();
});
async function freePort() {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    s.close((e) => (e ? reject(e) : resolve())),
  );
  return port;
}
async function fixture() {
  const port = await freePort();
  const listener = await listenForHandoff({ ...base, port, host: "127.0.0.1" });
  listeners.push(listener);
  const send = (
    path: string,
    method = "GET",
    headers: Record<string, string> = {},
    body?: string,
  ) =>
    new Promise<{
      status: number;
      headers: Record<string, unknown>;
      body: string;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: { host: "handoff.example", ...headers },
        },
        (res) => {
          let value = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (value += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: value,
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  return { port, listener, send };
}
describe("bounded Render handoff listener", () => {
  it("shows the wait page for external homepage navigation but denies cross-site APIs and embeds", async () => {
    const f = await fixture();
    const navigation = {
      accept: "text/html",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    const response = await f.send("/", "GET", navigation);
    expect(response.status).toBe(503);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Preparing the next deployment");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect((await f.send("/api/v1/access", "GET", navigation)).status).toBe(
      403,
    );
    expect(
      (await f.send("/", "GET", { ...navigation, "sec-fetch-dest": "iframe" }))
        .status,
    ).toBe(403);
    expect((await f.send("/", "POST", navigation)).status).toBe(403);
  });
  it("reports only platform liveness; all game APIs remain unavailable without issuing identities", async () => {
    const f = await fixture();
    const live = await f.send("/_platform/health");
    expect(live.status).toBe(200);
    expect(JSON.parse(live.body)).toEqual({ status: "handoff" });
    expect(live.headers.connection).toBe("close");
    const contract = new ContractRegistry(process.cwd());
    for (const path of [
      "/api/v1/health",
      "/api/v1/access",
      "/api/v1/bootstrap",
      "/api/v1/my-sessions",
      "/api/v1/sessions/" + randomUUID() + "/events",
    ]) {
      const r = await f.send(path);
      expect(r.status).toBe(503);
      expect(r.headers["retry-after"]).toBe("2");
      expect(r.headers["set-cookie"]).toBeUndefined();
      expect(contract.errors("Problem", JSON.parse(r.body))).toEqual([]);
      expect(r.body).not.toMatch(
        /never-published|postgres:|storageReady.*true|modelConfigured/,
      );
    }
    const post = await f.send(
      "/api/v1/access",
      "POST",
      { origin, "content-type": "application/json" },
      JSON.stringify({
        inviteCode: "never-published-invite",
        padding: "x".repeat(70000),
      }),
    );
    expect(post.status).toBe(503);
    expect(post.headers["set-cookie"]).toBeUndefined();
  });
  it("enforces exact Host and Origin before even platform liveness", async () => {
    const f = await fixture();
    for (const headers of [
      { host: "evil.example" },
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { host: "evil.example", "x-forwarded-host": "handoff.example" },
    ] as Array<Record<string, string>>)
      expect((await f.send("/_platform/health", "GET", headers)).status).toBe(
        403,
      );
  });
  it("serves an English-default bilingual wait page with refresh, no scripts, and no external resources", async () => {
    const f = await fixture();
    const r = await f.send("/", "GET", { accept: "text/html" });
    expect(r.status).toBe(503);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.headers["retry-after"]).toBe("2");
    expect(r.body).toContain('<html lang="en">');
    expect(r.body).toContain('http-equiv="refresh" content="2"');
    expect(r.body).toContain('lang="zh-CN"');
    expect(r.body).not.toMatch(/<script|src=|href=|https:\/\//i);
    expect(r.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
  });
  it("closes idle and partial-header connections once and immediately releases the listening port", async () => {
    const f = await fixture();
    const socket = connect(f.port, "127.0.0.1");
    const socketErrors: NodeJS.ErrnoException[] = [];
    socket.on("error", (error: NodeJS.ErrnoException) =>
      socketErrors.push(error),
    );
    sockets.push(socket);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("GET / HTTP/1.1\r\nHost:");
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    const first = f.listener.close();
    expect(f.listener.close()).toBe(first);
    await first;
    await closed;
    expect(socketErrors.every((error) => error.code === "ECONNRESET")).toBe(
      true,
    );
    const replacement = await listenForHandoff({
      ...base,
      port: f.port,
      host: "127.0.0.1",
    });
    listeners.push(replacement);
    expect((await f.send("/_platform/health")).status).toBe(200);
  });
  it("refuses local-mode use; normal app platform liveness does not read game or storage state", async () => {
    await expect(
      listenForHandoff(loadHttpConfig({ LAST_MILE_ROOT: process.cwd() })),
    ).rejects.toThrow("cloud mode");
    const read = vi.fn(async () => {
      throw new Error("must not query");
    });
    const app = await createHttpApp({
      service: { launchId: randomUUID(), read } as unknown as GameService,
      config: {
        ...loadHttpConfig({ LAST_MILE_ROOT: process.cwd() }),
        clientDir: "/__no_client__",
      },
    });
    try {
      const r = await app.inject({
        url: "/_platform/health",
        headers: { host: "127.0.0.1:3111" },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ status: "ready" });
      expect(read).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
