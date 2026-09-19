import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGameService,
  type AgentGateway,
  type Clock,
  type GameService,
  type GameServiceOptions,
  type MutationOperation,
} from "../../server/core/service.js";
import { createStore } from "../../server/core/store.js";
import type * as P from "../../docs/engineering_v0.5/contracts/public.types.js";

class FakeClock implements Clock {
  time = 0;
  nowMs() {
    return 1800000000000 + this.time;
  }
  monotonicMs() {
    return this.time;
  }
  advance(ms: number) {
    this.time += ms;
  }
}
const services: GameService[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(
  caseId: "A" | "B" = "A",
  options: GameServiceOptions = {},
) {
  const clock = new FakeClock();
  const svc = await createGameService({
    dbPath: ":memory:",
    clock,
    selectCase: () => caseId,
    ...options,
  });
  services.push(svc);
  const boot = (await svc.read("getBootstrap")) as P.BootstrapView;
  const made = (await svc.execute(
    "createSession",
    {
      profileId: "SINGLE_PLAYER_REFERENCE",
      runPurpose: "design_preview",
      locale: "en-US",
      contentVersionId: boot.profiles[0]!.contentVersionId,
    },
    { idempotencyKey: randomUUID() },
  )) as P.SessionCreated;
  const sid = made.sessionId;
  const get = async () => {
    for (let i = 0; i < 100; i++) {
      const view = (await svc.read("getSession", sid)) as P.SessionProjection;
      if (
        options.agents ||
        !view.latestAdviceJob ||
        !["queued", "running"].includes(view.latestAdviceJob.status)
      )
        return view;
      await settle();
    }
    throw new Error("Offline advice did not settle");
  };
  const command = async (op: MutationOperation, payload: unknown) => {
    const v = await get();
    return svc.execute(
      op,
      {
        expectedStateVersion: v.stateVersion,
        expectedSceneId: v.sceneId,
        payload,
      },
      {
        sessionId: sid,
        runEpoch: v.runEpoch,
        idempotencyKey: randomUUID(),
      },
    );
  };
  const started = (await command("startSession", {
    acknowledgeDesignPreview: true,
  })) as P.SessionProjection;
  const action = async (
    actionId: string,
    waitDurationMs: number | null = null,
  ) =>
    command("commitAction", {
      actionId,
      waitDurationMs,
      reason: "",
      reasonAnnotation: null,
      basedOnAdviceJobId: null,
      referencedReportIds: [],
      cancelPendingInvestigations: true,
    }) as Promise<P.ActionAccepted>;
  return { svc, sid, clock, get, command, started, action };
}

describe("instant action timing", () => {
  it("starts at the first decision immediately and separates player time from simulation time", async () => {
    const x = await setup();
    expect(x.started).toMatchObject({
      actionTiming: "instant",
      sceneId: "E1",
      phase: "scene",
      activeOperation: null,
      missionTimeMs: 30000,
      playerElapsedMs: 0,
    });
    x.clock.advance(180000);
    await x.svc.tick(x.sid);
    expect(await x.get()).toMatchObject({
      missionTimeMs: 30000,
      playerElapsedMs: 180000,
      sceneId: "E1",
      lifecycle: "active",
    });
  });

  it("returns an acquired report immediately, charges once, and caches the completed response", async () => {
    const x = await setup();
    const before = await x.get();
    const option = before.taskOptions.find((o) => o.targetId === "gate_drone")!;
    const body = {
      expectedStateVersion: before.stateVersion,
      expectedSceneId: before.sceneId,
      payload: {
        taskKind: "investigate_and_report",
        targetRole: option.targetRole,
        targetId: option.targetId,
        topicId: option.topicId,
        investigationKind: option.investigationKind,
        sourceReportId: null,
        reasonAnnotation: null,
      },
    };
    const meta = {
      sessionId: x.sid,
      runEpoch: before.runEpoch,
      idempotencyKey: randomUUID(),
    };
    const accepted = (await x.svc.execute(
      "createTask",
      body,
      meta,
    )) as P.TaskAccepted;
    expect(accepted.task).toMatchObject({
      status: "completed",
      completedAt: new Date(x.clock.nowMs()).toISOString(),
    });
    expect(accepted.task.reportId).not.toBeNull();
    expect(accepted.reservedReportSlots).toBe(0);
    const view = await x.get();
    expect(view).toMatchObject({
      missionTimeMs: before.missionTimeMs + option.cost.knownDurationMs!,
      playerElapsedMs: 0,
      activeTasks: [],
    });
    expect(view.reports.map((r) => r.reportId)).toEqual([
      accepted.task.reportId,
    ]);
    expect(view.resources.find((r) => r.channel === "drone")).toMatchObject({
      remaining: 2,
      spent: 1,
    });
    expect(view.reportQuotas.find((q) => q.role === "analyst")).toMatchObject({
      used: 1,
      reserved: 0,
      remaining: 2,
    });
    expect(await x.svc.execute("createTask", body, meta)).toEqual(accepted);
    expect((await x.get()).reports).toHaveLength(1);
    expect(await x.svc.read("getTask", x.sid, accepted.task.taskId)).toEqual(
      accepted.task,
    );
  });

  it("delivers preloaded briefings without a real one-second delay or a channel charge", async () => {
    const x = await setup();
    const before = await x.get();
    const accepted = (await x.command("createTask", {
      taskKind: "request_report",
      targetRole: "analyst",
      topicId: "gate_status",
    })) as P.TaskAccepted;
    expect(accepted.task.status).toBe("completed");
    expect((await x.get()).missionTimeMs).toBe(before.missionTimeMs + 1000);
    expect((await x.get()).resources).toEqual(before.resources);
    expect(x.clock.time).toBe(0);
  });

  it("resolves every authored hold duration without waiting or choosing another route", async () => {
    const x = await setup();
    for (const duration of [15000, 30000, 60000]) {
      const before = await x.get();
      const result = await x.action("WAIT", duration);
      expect(result.operation).toMatchObject({
        status: "completed",
        operationKind: "wait",
      });
      expect(await x.get()).toMatchObject({
        missionTimeMs: before.missionTimeMs + duration,
        sceneId: "E1",
        phase: "scene",
        activeOperation: null,
        playerElapsedMs: 0,
      });
    }
  });

  it("retains case A detour segments and settles the final outcome inside the route command", async () => {
    const x = await setup();
    await x.action("E1_MAIN");
    expect((await x.get()).sceneId).toBe("E2");
    const market = await x.action("E2_MAIN");
    expect(market.operation.status).toBe("completed");
    expect((await x.get()).sceneId).toBe("E3");
    x.clock.advance(45000);
    const bridge = await x.action("E3_BRIDGE");
    expect(bridge.operation.status).toBe("completed");
    const outcome = (await x.svc.read("getOutcome", x.sid)) as P.OutcomeView;
    expect(outcome).toMatchObject({
      taskSuccess: true,
      sealedAtMissionMs: 445000,
      playerElapsedMs: 45000,
      pendingTasks: { inspection: "pending" },
    });
    expect(outcome.routeIdsTaken).toContain("R04");
    const events = await x.svc.getEventsSince(x.sid);
    const marketSegments = events.filter(
      (e) =>
        e.eventType === "operation.updated" &&
        e.data.operationId === market.operation.operationId,
    );
    expect(marketSegments.length).toBeGreaterThan(3);
    x.clock.advance(600000);
    expect((await x.get()).playerElapsedMs).toBe(45000);
    expect(await x.svc.read("getOutcome", x.sid)).toEqual(outcome);
  });

  it("retains case B bridge refusal, then conditional paperwork on the ford route", async () => {
    const x = await setup("B");
    await x.action("E1_BYPASS");
    await x.action("E2_MAIN");
    const before = await x.get();
    const refused = await x.action("E3_BRIDGE");
    expect(refused.operation.status).toBe("completed");
    const after = await x.get();
    expect(after).toMatchObject({
      sceneId: "E3",
      phase: "scene",
      uploadQuota: before.uploadQuota,
    });
    expect(
      after.actionOptions.find((a) => a.actionId === "E3_BRIDGE")?.available,
    ).toBe(false);
    await x.action("E3_FORD");
    expect(await x.svc.read("getOutcome", x.sid)).toMatchObject({
      taskSuccess: true,
      sealedAtMissionMs: 475000,
      playerElapsedMs: 0,
      pendingTasks: { manifest: "completed" },
    });
  });

  it("does not wait for or advance the wall-clock budget of an actual AI request", async () => {
    let dispatched = 0;
    const agents: AgentGateway = {
      configured: true,
      configHash: "a".repeat(64),
      jobTimeoutMs: { advisor: 60000, evaluator: 60000 },
      async runAdvisor() {
        dispatched++;
        return new Promise(() => {});
      },
      async runEvaluator() {
        return new Promise(() => {});
      },
    };
    const x = await setup("A", { agents });
    for (let i = 0; i < 10 && !dispatched; i++) await settle();
    expect(dispatched).toBe(1);
    const result = await x.action("WAIT", 60000);
    expect(result.operation.status).toBe("completed");
    expect((await x.get()).latestAdviceJob?.status).toBe("running");
    expect(x.clock.time).toBe(0);
  });

  it("rolls back the accepted action, cost and reports if immediate completion fails", async () => {
    const store = await createStore({ dbPath: ":memory:" });
    const x = await setup("A", { store });
    const before = await x.get();
    await store.run(
      "CREATE TRIGGER reject_instant_report BEFORE INSERT ON reports BEGIN SELECT RAISE(ABORT,'TEST_COMPLETION_FAILURE'); END",
    );
    await expect(
      x.command("createTask", {
        taskKind: "request_report",
        targetRole: "analyst",
        topicId: "gate_status",
      }),
    ).rejects.toThrow("TEST_COMPLETION_FAILURE");
    await store.run("DROP TRIGGER reject_instant_report");
    const after = await x.get();
    expect(after).toEqual(before);
    expect(
      await store.one(
        "SELECT COUNT(*) AS n FROM task_requests WHERE session_id=?",
        x.sid,
      ),
    ).toEqual({ n: 0 });
    const accepted = (await x.command("createTask", {
      taskKind: "request_report",
      targetRole: "analyst",
      topicId: "gate_status",
    })) as P.TaskAccepted;
    expect(accepted.task.status).toBe("completed");
    expect((await x.get()).reports).toHaveLength(1);
  });

  it("uses the durable player-time checkpoint after a crash without adding offline time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "last-mile-instant-"));
    dirs.push(dir);
    const dbPath = join(dir, "game.sqlite");
    const store = await createStore({ dbPath });
    const x = await setup("A", { store });
    x.clock.advance(12000);
    await x.action("WAIT", 15000);
    await x.get();
    const saved = JSON.parse(
      (
        await store.one(
          "SELECT world_state_json FROM sessions WHERE session_id=?",
          x.sid,
        )
      ).world_state_json,
    );
    expect(saved).toMatchObject({ mission: 45000, playerElapsedMs: 12000 });
    // Simulate process loss: close only storage, without the service's graceful
    // final clock sample, then recover with a later wall clock and no anchor.
    await store.close();
    services.splice(services.indexOf(x.svc), 1);
    x.clock.advance(3600000);
    const recovered = await createGameService({
      dbPath,
      clock: x.clock,
      resumeSessionIds: [x.sid],
    });
    services.push(recovered);
    expect(await recovered.read("getOutcome", x.sid)).toMatchObject({
      terminationReason: "technical_interruption",
      sealedAtMissionMs: 45000,
      playerElapsedMs: 12000,
    });
    expect(await recovered.read("getSession", x.sid)).toMatchObject({
      lifecycle: "sealed",
      playerElapsedMs: 12000,
    });
  });
});
