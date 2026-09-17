import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import type { GameService } from "../../server/core/service.js";
import { createHttpApp } from "../../server/http/app.js";
import { ContractRegistry } from "../../server/http/contracts.js";
import { loadHttpConfig } from "../../server/http/config.js";

const root = process.cwd();
const contracts = new ContractRegistry(root);
const spec = JSON.parse(
  readFileSync(resolve(root, "docs/engineering_v0.5/api/openapi.json"), "utf8"),
);
const examples = JSON.parse(
  readFileSync(
    resolve(root, "docs/engineering_v0.5/contracts/examples.json"),
    "utf8",
  ),
);
const uuid = "11111111-1111-4111-8111-111111111111";
const token = "t".repeat(64);
const headers = { host: "127.0.0.1:3111", authorization: `Bearer ${token}` };
const config = {
  ...loadHttpConfig({ LAST_MILE_ROOT: root }),
  clientDir: "/__no_client__",
  ssePollMs: 10,
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function example(operationId: string) {
  const op = contracts.operations.find((x) => x.operationId === operationId)!;
  return structuredClone(
    spec.paths[op.path.slice(7)][op.method.toLowerCase()].responses[
      String(op.status)
    ].content["application/json"].example,
  );
}
function fakeService(): GameService {
  return {
    launchId: uuid,
    lastExecutionReplayed: false,
    execute: vi.fn((op) => example(op)),
    read: vi.fn((op) => example(op)),
    getEventsSince: vi.fn(() => []),
    subscribe: vi.fn(() => () => {}),
    hasSessionAccess: vi.fn(() => true),
    startScheduler: vi.fn(() => () => {}),
    tick: vi.fn(),
    close: vi.fn(),
  } as GameService;
}
async function setup(service = fakeService(), override = {}) {
  const app = await createHttpApp({
    service,
    config: { ...config, ...override },
    launchToken: token,
  });
  apps.push(app);
  return { app, service };
}
function pathFor(path: string) {
  return path.replaceAll(/\{[^}]+\}/g, uuid);
}

describe("frozen HTTP contract and authentication", () => {
  it("local bootstrap initializes an HttpOnly cookie; protected reads require it", async () => {
    const { app } = await setup();
    const unauth = await app.inject({
      url: `/api/v1/sessions/${uuid}`,
      headers: { host: headers.host },
    });
    expect(unauth.statusCode).toBe(401);
    const boot = await app.inject({
      url: "/api/v1/bootstrap",
      headers: { host: headers.host },
    });
    expect(boot.statusCode).toBe(200);
    expect(boot.headers["set-cookie"]).toContain("HttpOnly; SameSite=Strict");
    expect(boot.json()).not.toHaveProperty("token");
    const protectedRead = await app.inject({
      url: `/api/v1/sessions/${uuid}`,
      headers: { host: headers.host, cookie: `last_mile_launch=${token}` },
    });
    expect(protectedRead.statusCode).toBe(200);
    expect(contracts.errors("SessionProjection", protectedRead.json())).toEqual(
      [],
    );
  });

  it.each([
    { host: "evil.test:3111" },
    { origin: "https://evil.test" },
    { "sec-fetch-site": "cross-site" },
    { origin: "null" },
  ])("rejects untrusted browser/Host context %j", async (extra) => {
    const { app, service } = await setup();
    const result = await app.inject({
      url: "/api/v1/bootstrap",
      headers: { ...headers, ...extra },
    });
    expect(result.statusCode).toBe(403);
    expect(service.read).not.toHaveBeenCalled();
    expect(contracts.errors("Problem", result.json())).toEqual([]);
    expect(result.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects nonloopback remote requests and a bad explicit bearer even with valid cookie", async () => {
    const { app } = await setup();
    expect(
      (
        await app.inject({
          url: "/api/v1/health",
          headers,
          remoteAddress: "192.168.1.2",
        })
      ).statusCode,
    ).toBe(403);
    const r = await app.inject({
      url: "/api/v1/bootstrap",
      headers: {
        ...headers,
        authorization: "Bearer wrong",
        cookie: `last_mile_launch=${token}`,
      },
    });
    expect(r.statusCode).toBe(401);
  });

  it("allows the explicit Vite proxy origin without requiring CORS", async () => {
    const { app } = await setup();
    const r = await app.inject({
      url: "/api/v1/bootstrap",
      headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it.each(
    contracts.operations.filter((op) => op.operationId !== "streamEvents"),
  )(
    "$operationId routes and validates the exact public response",
    async (op) => {
      const { app } = await setup();
      let url = pathFor(op.path);
      if (op.operationId === "getProvenance") url += "?sceneId=E1";
      const result = await app.inject({
        method: op.method,
        url,
        headers: { ...headers, "idempotency-key": uuid, "x-run-epoch": uuid },
        ...(op.request ? { payload: examples[op.request] } : {}),
      });
      expect(result.statusCode, result.body).toBe(op.status);
      expect(
        contracts.errors(contracts.responseName(op), result.json()),
      ).toEqual([]);
      expect(result.headers["x-request-id"]).toMatch(/^[\da-f-]{36}$/);
      if (op.method === "POST")
        expect(result.headers["idempotency-replayed"]).toBe("false");
    },
  );

  it("rejects unknown client truth, malformed header UUIDs, missing epochs and query fields", async () => {
    const { app, service } = await setup();
    const valid = { ...headers, "idempotency-key": uuid, "x-run-epoch": uuid };
    for (const [url, h, body] of [
      [
        "/api/v1/sessions",
        valid,
        { ...examples.CreateSessionRequest, caseId: "A" },
      ],
      [
        "/api/v1/sessions",
        { ...valid, "idempotency-key": "bad" },
        examples.CreateSessionRequest,
      ],
      [
        `/api/v1/sessions/${uuid}/start`,
        { ...headers, "idempotency-key": uuid },
        examples.StartRequest,
      ],
    ] as const) {
      const result = await app.inject({
        method: "POST",
        url,
        headers: h,
        payload: body,
      });
      expect(result.statusCode, result.body).toBe(400);
    }
    expect(
      (await app.inject({ url: `/api/v1/sessions/${uuid}?caseId=A`, headers }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: "/api/v1/sessions/not-a-uuid", headers }))
        .statusCode,
    ).toBe(400);
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("bounds request bytes and consistently handles invalid JSON", async () => {
    const { app } = await setup();
    const h = {
      ...headers,
      "idempotency-key": uuid,
      "content-type": "application/json",
    };
    const tooLarge = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: h,
      payload: JSON.stringify({ data: "a".repeat(65536) }),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().code).toBe("BODY_TOO_LARGE");
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: h,
      payload: "{bad",
    });
    expect(bad.statusCode).toBe(400);
    expect(contracts.errors("Problem", bad.json())).toEqual([]);
  });

  it("validates successful responses independently and fails closed on accidental private fields", async () => {
    const service = fakeService();
    service.read = vi.fn(() => ({
      ...examples.HealthView,
      modelApiKey: "PRIVATE-SECRET",
      caseId: "B",
    }));
    const { app } = await setup(service);
    const result = await app.inject({ url: "/api/v1/health", headers });
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain("PRIVATE-SECRET");
    expect(result.body).not.toContain("caseId");
    expect(contracts.errors("Problem", result.json())).toEqual([]);
  });

  it("maps domain errors without exposing their private diagnostic text", async () => {
    const service = fakeService();
    service.execute = vi.fn(() => {
      throw Object.assign(new Error("case B / API_KEY=secret"), {
        name: "DomainError",
        code: "STATE_VERSION_CONFLICT",
        status: 409,
        currentStateVersion: 7,
        retryable: false,
      });
    });
    const { app } = await setup(service);
    const result = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { ...headers, "idempotency-key": uuid },
      payload: examples.CreateSessionRequest,
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().currentStateVersion).toBe(7);
    expect(result.body).not.toMatch(/case B|API_KEY|secret/);
  });

  it("SSE uses cookie auth, public cursor IDs and stops cleanly; ambiguous cursor rejected", async () => {
    const service = fakeService();
    const event = examples.SseClockSample;
    service.getEventsSince = vi.fn((_session, cursor) =>
      cursor ? [] : [event],
    );
    const { app } = await setup(service);
    const url = `/api/v1/sessions/${uuid}/events`;
    const response = await app.inject({
      url,
      headers: { host: headers.host, cookie: `last_mile_launch=${token}` },
      payloadAsStream: true,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const wire = await new Promise<string>((resolve, reject) => {
      let text = "";
      const stream = response.stream();
      stream.on("data", (chunk) => {
        text += chunk.toString();
        if (text.includes("event: clock.sample")) resolve(text);
      });
      stream.on("error", reject);
    });
    expect(wire).toContain("retry: 2000");
    expect(wire).toContain(`id: ${event.runEpoch}:${event.viewSequence}`);
    expect(wire).toContain("event: clock.sample");
    expect(wire).not.toMatch(/caseId|source_seq|privateWorld/);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const next = await setup();
    expect(
      (
        await next.app.inject({
          url: `${url}?after=${uuid}:1`,
          headers: { ...headers, "last-event-id": `${uuid}:1` },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("production serves only frontend build files and applies CSP to the shell", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "last-mile-static-"));
    try {
      writeFileSync(
        resolve(dir, "index.html"),
        "<!doctype html><title>LAST MILE</title>",
      );
      const { app } = await setup(undefined, { clientDir: dir });
      const result = await app.inject({
        url: "/",
        headers: { ...headers, accept: "text/html" },
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain("LAST MILE");
      expect(result.headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'",
      );
      expect(
        (
          await app.inject({
            url: "/docs/engineering_v0.5/content/campaign-reference.json",
            headers,
          })
        ).statusCode,
      ).toBe(404);
      const dotfile = await app.inject({ url: "/.env", headers });
      expect(dotfile.statusCode).toBe(403);
      expect(dotfile.json().code).toBe("CAPABILITY_DENIED");
      await app.close();
      apps.splice(apps.indexOf(app), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
