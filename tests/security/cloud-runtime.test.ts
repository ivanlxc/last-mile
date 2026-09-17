import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";
import {
  createGameService,
  type GameService,
} from "../../server/core/service.js";
import { createStore, type Store } from "../../server/core/store.js";
import { createAiService } from "../../server/ai/index.js";

const origin = "https://last-mile.example";
const invite = "runtime-test-invite-code";
const config = {
  ...loadHttpConfig({
    LAST_MILE_ROOT: process.cwd(),
    LAST_MILE_MODE: "cloud",
    DATABASE_URL: "postgres://example.invalid/test",
    LAST_MILE_PUBLIC_ORIGIN: origin,
    LAST_MILE_INVITE_CODE: invite,
    LAST_MILE_COOKIE_SECRET: "secret".repeat(8),
  }),
  clientDir: "/__no_client__",
};
const headers = { host: "last-mile.example", origin };
const apps: FastifyInstance[] = [],
  services: GameService[] = [],
  stores: Store[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const s of services.splice(0)) await s.close();
  for (const s of stores.splice(0)) await s.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
async function fixture(store?: Store, dbPath = ":memory:") {
  if (!store) {
    store = await createStore({ dbPath });
    stores.push(store);
  }
  const service = await createGameService({
    store,
    cloud: config.limits,
    agents: createAiService({ env: {} }),
    autoTick: false,
    selectCase: () => "A",
  });
  services.push(service);
  const app = await createHttpApp({ service, store, config });
  apps.push(app);
  const enter = async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/access",
      headers,
      payload: { inviteCode: invite },
    });
    expect(r.statusCode, r.body).toBe(200);
    return String(r.headers["set-cookie"]).split(";")[0]!;
  };
  const get = (url: string, cookie: string) =>
    app.inject({ url, headers: { ...headers, cookie } });
  const post = (
    url: string,
    payload: object,
    cookie: string,
    epoch?: string,
    key = randomUUID(),
  ) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        ...headers,
        cookie,
        "idempotency-key": key,
        ...(epoch ? { "x-run-epoch": epoch } : {}),
      },
      payload,
    });
  const create = async (cookie: string, key = randomUUID()) => {
    const boot = await get("/api/v1/bootstrap", cookie);
    expect(boot.statusCode, boot.body).toBe(200);
    const p = boot.json().profiles[0];
    const r = await post(
      "/api/v1/sessions",
      {
        profileId: p.profileId,
        contentVersionId: p.contentVersionId,
        runPurpose: "design_preview",
        locale: "en-US",
      },
      cookie,
      undefined,
      key,
    );
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  };
  return { app, store, service, enter, get, post, create };
}
describe("real async game service with cloud visitor ownership (SQLite test adapter)", () => {
  it("isolates two visitors, preserves creation replay, and restores only the owner's interrupted history after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "last-mile-cloud-restart-"));
    dirs.push(dir);
    const dbPath = join(dir, "game.sqlite");
    const f = await fixture(undefined, dbPath);
    const a = await f.enter(),
      b = await f.enter(),
      key = randomUUID();
    const created = await f.create(a, key);
    const replay = await f.create(a, key);
    expect(replay.sessionId).toBe(created.sessionId);
    const other = await f.create(b, key);
    expect(other.sessionId).not.toBe(created.sessionId);
    const base = `/api/v1/sessions/${created.sessionId}`;
    expect((await f.get(base, b)).statusCode).toBe(404);
    const before = created.projection;
    const started = await f.post(
      base + "/start",
      {
        expectedStateVersion: before.stateVersion,
        expectedSceneId: before.sceneId,
        payload: { acknowledgeDesignPreview: true },
      },
      a,
      created.runEpoch,
    );
    expect(started.statusCode, started.body).toBe(200);
    const historyA = (await f.get("/api/v1/my-sessions", a)).json().sessions;
    expect(historyA.map((s: { sessionId: string }) => s.sessionId)).toEqual([
      created.sessionId,
    ]);
    await f.app.close();
    await f.service.close();
    services.splice(services.indexOf(f.service), 1);
    const restarted = await fixture(undefined, dbPath);
    expect(
      (await restarted.get("/api/v1/access", a)).json().authenticated,
    ).toBe(true);
    const restored = await restarted.get(base, a);
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().lifecycle).toBe("sealed");
    const outcome = await restarted.get(base + "/outcome", a);
    expect(outcome.statusCode, outcome.body).toBe(200);
    expect(outcome.json().terminationReason).toBe("technical_interruption");
    expect((await restarted.get(base, b)).statusCode).toBe(404);
    expect((await restarted.get(base + "/outcome", b)).statusCode).toBe(404);
    const history = (await restarted.get("/api/v1/my-sessions", a)).json()
      .sessions;
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("sealed");
    expect(JSON.stringify(history)).not.toMatch(
      /caseId|world|credential|token/i,
    );
  });
});
