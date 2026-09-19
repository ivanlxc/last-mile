import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createStore,
  StorageError,
  type Store,
} from "../../server/core/store.js";
import {
  createGameService,
  type GameService,
  type GameServiceOptions,
} from "../../server/core/service.js";
import {
  createAiService,
  MockProvider,
  advisorFallback,
  type AdvisorInput,
  type ProviderRequest,
  type ProviderResult,
} from "../../server/ai/index.js";
import type * as P from "../../docs/engineering_v0.5/contracts/public.types.js";

const services: GameService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) await service.close();
  vi.restoreAllMocks();
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
async function eventually(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await settle();
  }
  throw new Error("Background operation did not settle");
}
const success = (request: ProviderRequest): ProviderResult => ({
  ok: true,
  value: advisorFallback(request.input as AdvisorInput, "en-US"),
  usage: null,
  providerRequestId: null,
});
async function setup(
  options: {
    provider?: MockProvider;
    cloud?: Partial<NonNullable<GameServiceOptions["cloud"]>>;
    wrapStore?: (store: Store) => Store;
    onStorageFailure?: () => void;
  } = {},
) {
  const base = await createStore({ dbPath: ":memory:" });
  const store = options.wrapStore?.(base) ?? base;
  let elapsed = 0;
  const service = await createGameService({
    store,
    selectCase: () => "A",
    clock: { nowMs: () => 1800000000000 + elapsed, monotonicMs: () => elapsed },
    cloud: {
      maxActiveSessions: 5,
      maxSessionsPerPlayerPerDay: 3,
      maxModelAttemptsPerDay: 100,
      maxConcurrentModelJobs: 2,
      ...options.cloud,
    },
    agents: createAiService({ env: {}, provider: options.provider }),
    onStorageFailure: options.onStorageFailure,
  });
  services.push(service);
  const players = Array.from({ length: 6 }, () => randomUUID());
  for (const player of players)
    await base.insert("cloud_players", {
      player_id: player,
      created_at_ms: 1800000000000,
    });
  const boot = (await service.read("getBootstrap")) as P.BootstrapView;
  const body = {
    profileId: "SINGLE_PLAYER_REFERENCE",
    runPurpose: "design_preview",
    locale: "en-US",
    contentVersionId: boot.profiles[0]!.contentVersionId,
  };
  const create = async (
    playerId = players[0]!,
    idempotencyKey = randomUUID(),
  ) =>
    (await service.execute("createSession", body, {
      playerId,
      idempotencyKey,
    })) as P.SessionCreated;
  const command = async (
    session: P.SessionCreated,
    playerId: string,
    op: any,
    payload: unknown,
  ) => {
    const view = (await service.read(
      "getSession",
      session.sessionId,
    )) as P.SessionProjection;
    return service.execute(
      op,
      {
        expectedStateVersion: view.stateVersion,
        expectedSceneId: view.sceneId,
        payload,
      },
      {
        playerId,
        sessionId: session.sessionId,
        runEpoch: view.runEpoch,
        idempotencyKey: randomUUID(),
      },
    );
  };
  return {
    service,
    store: base,
    players,
    create,
    command,
    body,
    advance(ms: number) {
      elapsed += ms;
    },
  };
}

describe("cloud admission and durable global model limits", () => {
  it("reaps a 15-minute unstarted briefing before admission without attributing a player choice", async () => {
    const x = await setup({ cloud: { maxActiveSessions: 1 } });
    const first = await x.create();
    x.advance(899999);
    await expect(x.create(x.players[1])).rejects.toMatchObject({ status: 429 });
    x.advance(1);
    const second = await x.create(x.players[1]);
    expect(second.sessionId).not.toBe(first.sessionId);
    const outcome = (await x.service.read(
      "getOutcome",
      first.sessionId,
    )) as P.OutcomeView;
    expect(outcome).toMatchObject({
      terminationReason: "technical_interruption",
      sealedAtMissionMs: 0,
      taskSuccess: false,
    });
    expect(outcome.summary).toContain("15 minutes");
    expect(await x.service.listPlayerSessions(x.players[0]!)).toMatchObject([
      { sessionId: first.sessionId, status: "sealed" },
    ]);
    expect(
      (
        await x.store.one(
          "SELECT COUNT(*) AS n FROM sessions WHERE lifecycle='briefing'",
        )
      ).n,
    ).toBe(1);
  });

  it("counts expired briefings toward each owner's UTC daily admission limit, but never counts retries twice", async () => {
    const x = await setup();
    const key = randomUUID();
    const original = await x.create(x.players[0], key);
    expect((await x.create(x.players[0], key)).sessionId).toBe(
      original.sessionId,
    );
    x.advance(900000);
    await x.create();
    x.advance(900000);
    await x.create();
    x.advance(900000);
    await expect(x.create()).rejects.toMatchObject({ status: 429 });
    expect(await x.service.listPlayerSessions(x.players[0]!)).toHaveLength(3);
    x.advance(86400000);
    expect((await x.create()).projection.lifecycle).toBe("created");
  });

  it("charges failed repairs globally before send, refuses the next send atomically, and resets only on the UTC day boundary", async () => {
    let calls = 0;
    const provider = new MockProvider(async () => {
      calls++;
      return { ok: true, value: {}, usage: null, providerRequestId: null };
    });
    const x = await setup({ provider, cloud: { maxModelAttemptsPerDay: 3 } });
    const first = await x.create(x.players[0]);
    await x.command(first, x.players[0]!, "startSession", {
      acknowledgeDesignPreview: true,
    });
    x.advance(30000);
    await x.service.tick();
    await eventually(
      async () =>
        (
          (await x.service.read(
            "getSession",
            first.sessionId,
          )) as P.SessionProjection
        ).latestAdviceJob?.status === "fallback",
    );
    expect(calls).toBe(2);
    const second = await x.create(x.players[1]);
    await x.command(second, x.players[1]!, "startSession", {
      acknowledgeDesignPreview: true,
    });
    x.advance(30000);
    await x.service.tick();
    await eventually(
      async () =>
        (
          (await x.service.read(
            "getSession",
            second.sessionId,
          )) as P.SessionProjection
        ).latestAdviceJob?.status === "fallback",
    );
    expect(calls).toBe(3);
    expect(
      await x.store.all("SELECT attempt_count FROM cloud_daily_usage"),
    ).toEqual([{ attempt_count: 3 }]);
    expect(
      (await x.store.one("SELECT COUNT(*) AS n FROM agent_attempts")).n,
    ).toBe(3);
    const secondView = (await x.service.read(
      "getSession",
      second.sessionId,
    )) as P.SessionProjection;
    expect(secondView.latestAdviceJob).toMatchObject({
      attemptCount: 1,
      error: { code: "MODEL_BUDGET_EXHAUSTED" },
      mode: "offline_template",
    });
    x.advance(86400000);
    await x.service.tick();
    const nextDay = await x.create(x.players[2]);
    await x.command(nextDay, x.players[2]!, "startSession", {
      acknowledgeDesignPreview: true,
    });
    x.advance(30000);
    await x.service.tick();
    await eventually(
      async () =>
        (
          (await x.service.read(
            "getSession",
            nextDay.sessionId,
          )) as P.SessionProjection
        ).latestAdviceJob?.status === "fallback",
    );
    expect(calls).toBe(5);
    expect(
      (
        await x.store.all(
          "SELECT attempt_count FROM cloud_daily_usage ORDER BY day",
        )
      ).map((row) => row.attempt_count),
    ).toEqual([3, 2]);
  });

  it("limits physical in-flight calls to two, including a superseded call, without blocking commands", async () => {
    const releases: Array<() => void> = [];
    let calls = 0,
      active = 0,
      peak = 0;
    const provider = new MockProvider(async (request) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return success(request);
    });
    const x = await setup({ provider });
    const made = await Promise.all(
      x.players.slice(0, 3).map((player) => x.create(player)),
    );
    for (let i = 0; i < made.length; i++)
      await x.command(made[i]!, x.players[i]!, "startSession", {
        acknowledgeDesignPreview: true,
      });
    x.advance(30000);
    await x.service.tick();
    await eventually(() => calls === 2);
    expect(
      (
        await x.store.one(
          "SELECT COUNT(*) AS n FROM agent_jobs WHERE status='queued'",
        )
      ).n,
    ).toBe(1);
    await x.command(made[0]!, x.players[0]!, "commitAction", {
      actionId: "E1_MAIN",
      waitDurationMs: null,
      reason: "",
      reasonAnnotation: null,
      basedOnAdviceJobId: null,
      referencedReportIds: [],
      cancelPendingInvestigations: true,
    });
    await settle();
    expect(calls).toBe(2);
    // Immediate travel has already reached E2 and queued its advisor. The
    // cancelled E1 call still occupies a physical slot until it returns.
    expect(
      (
        await x.store.one(
          "SELECT COUNT(*) AS n FROM agent_jobs WHERE status='queued'",
        )
      ).n,
    ).toBe(2);
    releases[0]!();
    await eventually(() => calls === 3);
    expect(peak).toBe(2);
    releases[1]!();
    releases[2]!();
    await eventually(() => calls === 4);
    expect(peak).toBe(2);
    releases[3]!();
    await eventually(
      async () =>
        (
          await x.store.one(
            "SELECT COUNT(*) AS n FROM agent_jobs WHERE status IN ('queued','running')",
          )
        ).n === 0,
    );
    expect(
      await x.store.one(
        "SELECT status,result_json FROM agent_jobs WHERE session_id=? AND scene_id='E1'",
        made[0]!.sessionId,
      ),
    ).toMatchObject({ status: "cancelled", result_json: null });
    expect(
      (await x.store.one("SELECT attempt_count FROM cloud_daily_usage"))
        .attempt_count,
    ).toBe(4);
  });
});

describe("async storage failure and idle behavior", () => {
  it("does no scheduler database work when there are no live games or model jobs", async () => {
    let queries = 0,
      idleDisconnected = false;
    const x = await setup({
      wrapStore: (store) =>
        new Proxy(store, {
          get(target, key) {
            if (key === "health")
              return () =>
                idleDisconnected
                  ? { dialect: target.dialect, status: "unavailable" }
                  : target.health();
            const value = Reflect.get(target, key);
            if (["one", "all", "run", "insert"].includes(String(key)))
              return (...args: unknown[]) => {
                queries++;
                return value.apply(target, args);
              };
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    vi.useFakeTimers();
    const before = queries;
    const stop = x.service.startScheduler();
    await vi.advanceTimersByTimeAsync(10000);
    expect(queries).toBe(before);
    idleDisconnected = true;
    expect(await x.service.read("getHealth")).toMatchObject({
      storageReady: true,
    });
    expect(queries).toBe(before);
    stop();
  });

  it("fails stop after a lost COMMIT acknowledgement instead of replaying a committed creation", async () => {
    let failCommit = false;
    const fatal = vi.fn();
    const x = await setup({
      onStorageFailure: fatal,
      wrapStore: (store) =>
        new Proxy(store, {
          get(target, key) {
            if (key === "transaction")
              return async (callback: () => Promise<unknown>) => {
                const result = await target.transaction(callback);
                if (failCommit) {
                  failCommit = false;
                  throw new StorageError("STORAGE_CONNECTION_LOST");
                }
                return result;
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    failCommit = true;
    const key = randomUUID();
    await expect(x.create(x.players[0], key)).rejects.toMatchObject({
      code: "STORAGE_CONNECTION_LOST",
    });
    await settle();
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(
      (await x.store.one("SELECT COUNT(*) AS n FROM cloud_creation_keys")).n,
    ).toBe(1);
    await expect(x.create(x.players[0], key)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      status: 503,
    });
    expect(await x.service.read("getHealth")).toMatchObject({
      storageReady: false,
      status: "degraded",
    });
    expect(
      (await x.store.one("SELECT COUNT(*) AS n FROM cloud_creation_keys")).n,
    ).toBe(1);
  });

  it("does not occupy a model slot when dispatch preparation fails before the running handoff", async () => {
    let failRead = false,
      calls = 0;
    const provider = new MockProvider(async (request) => {
      calls++;
      return success(request);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const x = await setup({
      provider,
      wrapStore: (store) =>
        new Proxy(store, {
          get(target, key) {
            if (key === "one")
              return async (sql: string, ...args: unknown[]) => {
                if (failRead && sql.startsWith("SELECT permitted_input_json")) {
                  failRead = false;
                  throw new StorageError("STORAGE_BUSY");
                }
                return target.one(sql, ...args);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    const game = await x.create();
    await x.command(game, x.players[0]!, "startSession", {
      acknowledgeDesignPreview: true,
    });
    failRead = true;
    x.advance(30000);
    await x.service.tick();
    await eventually(() => log.mock.calls.length > 0);
    expect(calls).toBe(0);
    expect(await x.store.one("SELECT status FROM agent_jobs")).toEqual({
      status: "queued",
    });
    await x.service.tick();
    await eventually(
      async () =>
        (
          (await x.service.read(
            "getSession",
            game.sessionId,
          )) as P.SessionProjection
        ).latestAdviceJob?.status === "succeeded",
    );
    expect(calls).toBe(1);
    expect(
      (await x.store.one("SELECT attempt_count FROM cloud_daily_usage"))
        .attempt_count,
    ).toBe(1);
  });
});
