import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";
import { createStore, type Store } from "../../server/core/store.js";
import type { GameService } from "../../server/core/service.js";
import { ContractRegistry } from "../../server/http/contracts.js";

const root = process.cwd();
const origin = "https://last-mile.example";
const invite = "test-invitation-code-2026";
const env = {
  LAST_MILE_ROOT: root,
  LAST_MILE_MODE: "cloud",
  DATABASE_URL: "postgres://example.invalid/test",
  LAST_MILE_PUBLIC_ORIGIN: origin,
  LAST_MILE_INVITE_CODE: invite,
  LAST_MILE_COOKIE_SECRET: "s".repeat(48),
};
const config = { ...loadHttpConfig(env), clientDir: "/__no_client__" };
const headers = { host: "last-mile.example", origin };
const examples = JSON.parse(
  readFileSync("docs/engineering_v0.5/contracts/examples.json", "utf8"),
);
const contracts = new ContractRegistry(root);
const apps: FastifyInstance[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await Promise.all(stores.splice(0).map((s) => s.close()));
});
function fakeService(): GameService {
  return {
    launchId: randomUUID(),
    lastExecutionReplayed: false,
    execute: vi.fn(async () => ({})),
    executeWithMeta: vi.fn(async () => ({ result: {}, replayed: false })),
    read: vi.fn(async (op) =>
      op === "getHealth"
        ? { ...examples.HealthView, storageReady: true }
        : op === "getBootstrap"
          ? examples.BootstrapView
          : examples.SessionProjection,
    ),
    getSessionLocale: vi.fn(async () => "en-US" as const),
    hasSessionAccess: vi.fn(async () => true),
    hasPlayerSessionAccess: vi.fn(async () => false),
    listPlayerSessions: vi.fn(async () => []),
    getEventsSince: vi.fn(async () => []),
    subscribe: vi.fn(async () => () => {}),
    tick: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    startScheduler: () => () => {},
  };
}
async function setup(store?: Store, service = fakeService()) {
  if (!store) {
    store = await createStore({ dbPath: ":memory:" });
    stores.push(store);
  }
  const app = await createHttpApp({
    service,
    store,
    config,
    launchToken: "shared-local-token-is-forbidden",
  });
  apps.push(app);
  return { app, store, service };
}
async function enter(app: FastifyInstance, extra: Record<string, string> = {}) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/access",
    headers: { ...headers, ...extra },
    payload: { inviteCode: invite },
  });
  expect(r.statusCode, r.body).toBe(200);
  return String(r.headers["set-cookie"]).split(";")[0]!;
}

describe("cloud configuration and persistent invitation access", () => {
  it("fails closed for absent cloud settings and permits only an exact HTTPS origin", () => {
    for (const key of [
      "DATABASE_URL",
      "LAST_MILE_PUBLIC_ORIGIN",
      "LAST_MILE_INVITE_CODE",
      "LAST_MILE_COOKIE_SECRET",
    ]) {
      const invalid: NodeJS.ProcessEnv = { ...env };
      delete invalid[key];
      expect(() => loadHttpConfig(invalid)).toThrow();
    }
    for (const value of [
      "http://last-mile.example",
      "https://last-mile.example/path",
      "https://user:pass@last-mile.example",
      "https://last-mile.example?x=1",
    ])
      expect(() =>
        loadHttpConfig({ ...env, LAST_MILE_PUBLIC_ORIGIN: value }),
      ).toThrow();
    expect(
      loadHttpConfig({
        ...env,
        LAST_MILE_PUBLIC_ORIGIN: undefined,
        RENDER_EXTERNAL_URL: origin,
      }).publicOrigin,
    ).toBe(origin);
    expect(loadHttpConfig(env).host).toBe("0.0.0.0");
    expect(loadHttpConfig({ LAST_MILE_ROOT: root }).host).toBe("127.0.0.1");
    expect(() =>
      loadHttpConfig({ ...env, LAST_MILE_INVITE_CODE: "short" }),
    ).toThrow();
  });
  it("exposes only access status; bootstrap never grants the shared launch cookie in cloud mode", async () => {
    const { app } = await setup();
    const access = await app.inject({ url: "/api/v1/access", headers });
    expect(access.json()).toEqual({ authenticated: false, mode: "cloud" });
    expect(access.headers["set-cookie"]).toBeUndefined();
    for (const extra of [
      {},
      { authorization: "Bearer shared-local-token-is-forbidden" },
      { cookie: "last_mile_launch=shared-local-token-is-forbidden" },
    ]) {
      const r = await app.inject({
        url: "/api/v1/bootstrap",
        headers: { ...headers, ...extra },
      });
      expect(r.statusCode).toBe(401);
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
    const h = await app.inject({
      url: "/api/v1/health",
      headers,
      remoteAddress: "198.51.100.5",
    });
    expect(h.statusCode).toBe(200);
  });
  it("persists distinct hashed visitor credentials and keeps the same identity on repeated access", async () => {
    const { app, store } = await setup();
    const cookie = await enter(app);
    const other = await enter(app);
    expect(cookie).not.toBe(other);
    const rows = await store.all("SELECT * FROM cloud_credentials");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((x) => x.player_id)).size).toBe(2);
    for (const r of rows) {
      expect(r.token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(cookie).not.toContain(r.token_hash);
    }
    expect(JSON.stringify(rows)).not.toContain(
      cookie.split("=")[1]!.split(".")[0],
    );
    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/access",
      headers: { ...headers, cookie },
      payload: { inviteCode: invite },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers["set-cookie"]).toBeUndefined();
    expect(await store.all("SELECT * FROM cloud_players")).toHaveLength(2);
    const boot = await app.inject({
      url: "/api/v1/bootstrap",
      headers: { ...headers, cookie },
    });
    expect(boot.statusCode, boot.body).toBe(200);
    expect(boot.headers["set-cookie"]).toBeUndefined();
    const set = await app.inject({
      method: "POST",
      url: "/api/v1/access",
      headers,
      payload: { inviteCode: invite },
    });
    expect(set.headers["set-cookie"]).toMatch(
      /Path=\/api\/v1; HttpOnly; Secure; SameSite=Strict; Max-Age=1209600/,
    );
    expect(set.body).not.toMatch(/token|playerId|secret|key/i);
  });
  it("retains credentials across an app restart and rejects expiry, tampering, duplicates and key rotation", async () => {
    const first = await setup();
    const cookie = await enter(first.app);
    await first.app.close();
    const second = await setup(first.store);
    expect(
      (
        await second.app.inject({
          url: "/api/v1/access",
          headers: { ...headers, cookie },
        })
      ).json().authenticated,
    ).toBe(true);
    for (const bad of [
      cookie + "x",
      cookie + "; " + cookie,
      cookie.replace(/.$/, "!"),
    ])
      expect(
        (
          await second.app.inject({
            url: "/api/v1/access",
            headers: { ...headers, cookie: bad },
          })
        ).json().authenticated,
      ).toBe(false);
    const rotated = await createHttpApp({
      service: fakeService(),
      store: first.store,
      config: { ...config, cookieSecret: "different".repeat(8) },
    });
    apps.push(rotated);
    expect(
      (
        await rotated.inject({
          url: "/api/v1/access",
          headers: { ...headers, cookie },
        })
      ).json().authenticated,
    ).toBe(false);
    await first.store.run("UPDATE cloud_credentials SET expires_at_ms = ?", 1);
    expect(
      (
        await second.app.inject({
          url: "/api/v1/access",
          headers: { ...headers, cookie },
        })
      ).json().authenticated,
    ).toBe(false);
  });
  it("enforces exact Host/Origin and does not trust forwarded headers", async () => {
    const { app } = await setup();
    for (const h of [
      { host: headers.host },
      { ...headers, origin: "https://evil.example" },
      { ...headers, host: "evil.example", "x-forwarded-host": headers.host },
      { ...headers, "sec-fetch-site": "cross-site" },
    ]) {
      const r = await app.inject({
        method: "POST",
        url: "/api/v1/access",
        headers: h,
        payload: { inviteCode: invite },
      });
      expect(r.statusCode).toBe(403);
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
  });
  it("rejects invalid request fields and never returns the submitted invitation", async () => {
    const { app } = await setup();
    for (const payload of [
      { inviteCode: invite, playerId: randomUUID() },
      {},
      { inviteCode: "x".repeat(257) },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/access",
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(400);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/access",
      headers,
      payload: { inviteCode: "PRIVATE-WRONG-CODE" },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.body).not.toContain("PRIVATE-WRONG-CODE");
    expect(contracts.errors("Problem", invalid.json())).toEqual([]);
  });
  it("bounds invitation attempts per socket peer even when forwarded addresses change", async () => {
    const { app } = await setup();
    for (let i = 0; i < 20; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/access",
            headers: { ...headers, "x-forwarded-for": `192.0.2.${i}` },
            payload: { inviteCode: "wrong" },
          })
        ).statusCode,
      ).toBe(401);
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/access",
      headers: { ...headers, "x-forwarded-for": "203.0.113.9" },
      payload: { inviteCode: invite },
    });
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
    expect(r.headers["set-cookie"]).toBeUndefined();
  });
  it("bounds invitation attempts globally across socket peers", async () => {
    const { app } = await setup();
    for (let i = 0; i < 60; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/access",
            headers,
            remoteAddress: `198.51.100.${i + 1}`,
            payload: { inviteCode: "wrong" },
          })
        ).statusCode,
      ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/access",
          headers,
          remoteAddress: "203.0.113.4",
          payload: { inviteCode: invite },
        })
      ).statusCode,
    ).toBe(429);
  });
});

describe("cloud resource ownership and public event boundaries", () => {
  it.each(contracts.operations.filter((op) => op.path.includes("{sessionId}")))(
    "owner check precedes $operationId, including exports and SSE",
    async (op) => {
      const { app, service } = await setup();
      const cookie = await enter(app);
      let url = op.path.replaceAll(/\{[^}]+\}/g, randomUUID());
      if (op.operationId === "getProvenance") url += "?sceneId=E1";
      const r = await app.inject({
        method: op.method,
        url,
        headers: {
          ...headers,
          cookie,
          "idempotency-key": randomUUID(),
          "x-run-epoch": randomUUID(),
        },
        ...(op.request ? { payload: examples[op.request] } : {}),
      });
      expect(r.statusCode, r.body).toBe(404);
      expect(service.read).not.toHaveBeenCalled();
      expect(service.executeWithMeta).not.toHaveBeenCalled();
      expect(service.subscribe).not.toHaveBeenCalled();
      expect(service.hasSessionAccess).not.toHaveBeenCalled();
      expect(service.getSessionLocale).not.toHaveBeenCalled();
    },
  );
  it("lists only the authenticated player's bounded public history and fails closed on private fields", async () => {
    const { app, service, store } = await setup();
    const cookie = await enter(app);
    const player = (await store.one("SELECT player_id FROM cloud_players"))
      .player_id;
    const list = [
      {
        sessionId: randomUUID(),
        locale: "en-US" as const,
        status: "sealed" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    service.listPlayerSessions = vi.fn(async () => list);
    const r = await app.inject({
      url: "/api/v1/my-sessions",
      headers: { ...headers, cookie },
    });
    expect(r.json()).toEqual({ sessions: list });
    expect(service.listPlayerSessions).toHaveBeenCalledWith(player);
    service.listPlayerSessions = vi.fn(async () => [
      { ...list[0]!, caseId: "PRIVATE-CASE" },
    ]);
    const invalid = await app.inject({
      url: "/api/v1/my-sessions",
      headers: { ...headers, cookie },
    });
    expect(invalid.statusCode).toBe(503);
    expect(invalid.body).not.toContain("PRIVATE-CASE");
  });
  it("binds mutations to player identity and keeps idempotency metadata per response", async () => {
    const { app, service, store } = await setup();
    const cookie = await enter(app);
    const player = (await store.one("SELECT player_id FROM cloud_players"))
      .player_id;
    service.executeWithMeta = vi.fn(async (_op, _body, meta) => ({
      result: examples.SessionCreated,
      replayed: meta.idempotencyKey.endsWith("1"),
    }));
    const keys = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const results = await Promise.all(
      keys.map((key) =>
        app.inject({
          method: "POST",
          url: "/api/v1/sessions",
          headers: { ...headers, cookie, "idempotency-key": key },
          payload: examples.CreateSessionRequest,
        }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(results.map((r) => r.headers["idempotency-replayed"])).toEqual([
      "true",
      "false",
    ]);
    for (const call of vi.mocked(service.executeWithMeta).mock.calls)
      expect(call[2].playerId).toBe(player);
  });
  it("bounds SSE to two streams per player and ten globally without per-connection database polling", async () => {
    const { app, service } = await setup();
    service.hasPlayerSessionAccess = vi.fn(async () => true);
    const sid = randomUUID();
    const first = await enter(app);
    const stream = (cookie: string) =>
      app.inject({
        url: `/api/v1/sessions/${sid}/events`,
        headers: { ...headers, cookie },
        payloadAsStream: true,
      });
    expect((await stream(first)).statusCode).toBe(200);
    expect((await stream(first)).statusCode).toBe(200);
    expect((await stream(first)).statusCode).toBe(429);
    for (let i = 0; i < 4; i++) {
      const cookie = await enter(app);
      expect((await stream(cookie)).statusCode).toBe(200);
      expect((await stream(cookie)).statusCode).toBe(200);
    }
    expect((await stream(await enter(app))).statusCode).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(service.getEventsSince).toHaveBeenCalledTimes(10);
    expect(service.subscribe).toHaveBeenCalledTimes(10);
  });
});
