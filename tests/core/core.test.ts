import { afterEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  createGameService,
  DomainError,
  type GameService,
  type Clock,
} from "../../server/core/service.js";
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
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});
function setup(caseId: "A" | "B" = "A", dbPath = ":memory:") {
  const clock = new FakeClock();
  const svc = createGameService({ clock, dbPath, selectCase: () => caseId });
  services.push(svc);
  const boot = svc.read("getBootstrap") as P.BootstrapView;
  const create = {
    profileId: "SINGLE_PLAYER_REFERENCE",
    runPurpose: "design_preview",
    locale: "zh-CN",
    contentVersionId: boot.profiles[0]!.contentVersionId,
  };
  const made = svc.execute("createSession", create, {
    idempotencyKey: randomUUID(),
  }) as P.SessionCreated;
  const sid = made.sessionId;
  const get = () => svc.read("getSession", sid) as P.SessionProjection;
  const command = (op: any, payload: any, extra: any = {}) => {
    const v = get();
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
        ...extra,
      },
    ) as any;
  };
  const advance = (n: number) => {
    clock.advance(n);
    svc.tick(sid);
    return get();
  };
  command("startSession", { acknowledgeDesignPreview: true });
  advance(30000);
  return { svc, clock, sid, get, command, advance, made };
}
function task(
  x: ReturnType<typeof setup>,
  role: "analyst" | "liaison",
  targetId: string,
) {
  const o = x.get().taskOptions.find((t) => t.targetId === targetId)!;
  return x.command("createTask", {
    taskKind: "investigate_and_report",
    targetRole: role,
    targetId,
    topicId: o.topicId,
    investigationKind: o.investigationKind,
    sourceReportId: null,
    reasonAnnotation: null,
  }) as P.TaskAccepted;
}
function action(
  x: ReturnType<typeof setup>,
  actionId: string,
  waitDurationMs: number | null = null,
) {
  return x.command("commitAction", {
    actionId,
    waitDurationMs,
    reason: "",
    reasonAnnotation: null,
    basedOnAdviceJobId: null,
    referencedReportIds: [],
    cancelPendingInvestigations: true,
  }) as P.ActionAccepted;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
describe("SQLite authoritative core", () => {
  it("runs case A all three main decisions including market partial out-and-back, then seals arrival", () => {
    const x = setup();
    expect(x.get().sceneId).toBe("E1");
    action(x, "E1_MAIN");
    x.advance(65000);
    expect(x.get().sceneId).toBe("E2");
    action(x, "E2_MAIN");
    let v = x.advance(35000);
    expect(v.location.routeId).toBe("R04");
    expect(v.location.progressPermille).toBe(200);
    v = x.advance(20000);
    expect(v.location.routeId).toBe("R04");
    expect(v.location.progressPermille).toBe(200);
    x.advance(190000);
    expect(x.get().sceneId).toBe("E3");
    action(x, "E3_BRIDGE");
    v = x.advance(105000);
    expect(v.lifecycle).toBe("sealed");
    const o = x.svc.read("getOutcome", x.sid) as P.OutcomeView;
    expect(o.taskSuccess).toBe(true);
    expect(o.sealedAtMissionMs).toBe(445000);
    expect(o.pendingTasks.inspection).toBe("pending");
    expect(o.handoffCompletedAtMissionMs).toBeNull();
  });
  it("case B bridge refusal stays in E3 with same quotas; ford clears actual conditional manifest hold", () => {
    const x = setup("B");
    action(x, "E1_BYPASS");
    x.advance(130000);
    action(x, "E2_MAIN");
    x.advance(75000);
    const quota = x.get().uploadQuota;
    action(x, "E3_BRIDGE");
    x.advance(20000);
    expect(x.get().sceneId).toBe("E3");
    expect(x.get().uploadQuota).toEqual(quota);
    expect(
      x.get().actionOptions.find((a) => a.actionId === "E3_BRIDGE")?.available,
    ).toBe(false);
    action(x, "E3_FORD");
    x.advance(140000);
    expect(x.get().location.nodeId).toBe("N10");
    expect(x.get().pendingTasks.manifest).toBe("pending");
    x.advance(20000);
    expect(x.get().pendingTasks.manifest).toBe("completed");
    x.advance(60000);
    const o = x.svc.read("getOutcome", x.sid) as P.OutcomeView;
    expect(o.taskSuccess).toBe(true);
    expect(o.sealedAtMissionMs).toBe(475000);
  });
  it("two roles observe concurrently on one clock, and same-role second task cannot take resources", () => {
    const x = setup();
    task(x, "analyst", "gate_drone");
    task(x, "liaison", "gate_agency");
    expect(() => task(x, "analyst", "service_drone")).toThrow(DomainError);
    let v = x.advance(15000);
    expect(v.reports).toHaveLength(1);
    expect(v.activeTasks).toHaveLength(1);
    v = x.advance(15000);
    expect(v.reports).toHaveLength(2);
    expect(v.missionTimeMs).toBe(60000);
    expect(v.resources.find((r) => r.channel === "drone")?.spent).toBe(1);
  });
  it("WAIT leaves investigation active and permits other-role tasks without double charging time", () => {
    const x = setup();
    task(x, "analyst", "gate_drone");
    action(x, "WAIT", 15000);
    task(x, "liaison", "gate_agency");
    const v = x.advance(15000);
    expect(v.phase).toBe("scene");
    expect(v.activeOperation).toBeNull();
    expect(v.activeTasks).toHaveLength(1);
    expect(v.reports).toHaveLength(1);
    expect(v.missionTimeMs).toBe(45000);
  });
  it("leaving cancels unfinished tasks, releases report reservation and retains spent channel", () => {
    const x = setup();
    const t = task(x, "analyst", "gate_drone");
    action(x, "E1_MAIN");
    const v = x.get();
    expect(v.activeTasks).toHaveLength(0);
    expect(v.reportQuotas.find((q) => q.role === "analyst")).toMatchObject({
      used: 0,
      reserved: 0,
      remaining: 3,
    });
    expect(v.resources.find((r) => r.channel === "drone")).toMatchObject({
      remaining: 2,
      spent: 1,
    });
    expect(x.svc.read("getTask", x.sid, t.task.taskId)).toMatchObject({
      status: "cancelled",
      failureCode: "scene_left",
    });
    x.advance(65000);
    expect(
      x.get().resources.find((r) => r.channel === "drone")?.remaining,
    ).toBe(2);
  });
  it("cached success precedes CAS, different content same key conflicts, catch-up survives rejected stale command", () => {
    const x = setup();
    const before = x.get();
    const key = randomUUID();
    const body = {
      expectedStateVersion: before.stateVersion,
      expectedSceneId: "E1",
      payload: {
        taskKind: "investigate_and_report",
        targetRole: "analyst",
        topicId: "gate_status",
        targetId: "gate_drone",
        investigationKind: "drone_observe",
        sourceReportId: null,
        reasonAnnotation: null,
      },
    };
    const meta = {
      sessionId: x.sid,
      runEpoch: before.runEpoch,
      idempotencyKey: key,
    };
    const first = x.svc.execute("createTask", body, meta);
    x.clock.advance(30000);
    expect(x.svc.execute("createTask", body, meta)).toEqual(first);
    expect(x.svc.lastExecutionReplayed).toBe(true);
    expect(() =>
      x.svc.execute(
        "createTask",
        { ...body, payload: { ...body.payload, targetId: "service_drone" } },
        meta,
      ),
    ).toThrowError(/请求键/);
    expect(() =>
      x.svc.execute(
        "commitAction",
        {
          expectedStateVersion: before.stateVersion,
          expectedSceneId: "E1",
          payload: {},
        },
        { ...meta, idempotencyKey: randomUUID() },
      ),
    ).toThrow(DomainError);
    expect(x.get().reports).toHaveLength(1);
    expect(x.get().resources.find((r) => r.channel === "drone")?.spent).toBe(1);
  });
  it("batch upload is all-or-none and AI only gets explicitly uploaded cards", async () => {
    const x = setup();
    task(x, "analyst", "gate_drone");
    task(x, "liaison", "gate_agency");
    x.advance(30000);
    const [r] = x.get().reports;
    expect(() =>
      x.command("uploadReports", {
        items: [
          { reportId: r!.reportId, expectedRevision: r!.revision },
          { reportId: randomUUID(), expectedRevision: 1 },
        ],
      }),
    ).toThrow(DomainError);
    expect(x.get().uploadQuota?.used).toBe(0);
    x.command("uploadReports", {
      items: [{ reportId: r!.reportId, expectedRevision: r!.revision }],
    });
    expect(x.get().sceneUploads).toHaveLength(1);
    expect(x.get().unuploadedReportIds).toHaveLength(1);
    await settle();
    expect(x.get().latestAdviceJob?.mode).toBe("offline_template");
    expect(x.get().latestAdviceJob?.attemptCount).toBe(0);
    expect(JSON.stringify(x.get())).not.toMatch(
      /privateCaseId|hiddenRootId|explosionCause/,
    );
  });
  it("channel resources are shared across scenes and never reset on entry", () => {
    const x = setup();
    task(x, "analyst", "gate_satellite");
    x.advance(10000);
    action(x, "E1_MAIN");
    x.advance(65000);
    expect(
      x.get().resources.find((r) => r.channel === "satellite")?.remaining,
    ).toBe(1);
    task(x, "analyst", "market_satellite");
    x.advance(10000);
    expect(
      x.get().resources.find((r) => r.channel === "satellite")?.remaining,
    ).toBe(0);
    expect(() => task(x, "analyst", "market_satellite")).toThrow(DomainError);
  });
  it("mission deadline preserves a partial route location and refuses post-terminal gameplay", () => {
    const x = setup();
    for (let i = 0; i < 6; i++) {
      action(x, "WAIT", 60000);
      x.advance(60000);
    }
    action(x, "E1_MAIN");
    x.advance(65000);
    action(x, "E2_MAIN");
    x.advance(145000);
    const o = x.svc.read("getOutcome", x.sid) as P.OutcomeView;
    expect(o.terminationReason).toBe("mission_deadline");
    expect(o.taskSuccess).toBe(false);
    expect(o.finalLocation.nodeId).toBeNull();
    expect(o.finalLocation.routeId).toBe("R03");
    expect(() => action(x, "WAIT", 15000)).toThrow(DomainError);
  });
  it("medical status is stable at 479999 ms and changes to priority transfer exactly at 480000 ms", () => {
    const x = setup();
    expect(x.get().medical.status).toBe("stable");
    expect(x.get().medical.note).toContain("稳定");
    const before = x.advance(449999);
    expect(before.missionTimeMs).toBe(479999);
    expect(before.medical.status).toBe("stable");
    const after = x.advance(1);
    expect(after.missionTimeMs).toBe(480000);
    expect(after.medical.status).toBe("target_missed");
    expect(after.medical.note).toContain("需要优先转送");
    expect(after.civilianCount).toBe(20);
    expect(after.lifecycle).toBe("active");
  });
  it("clock samples advance view cursor but neither stateVersion nor game event count", () => {
    const x = setup();
    const old = x.get();
    x.advance(1000);
    const events = x.svc.getEventsSince(x.sid, old.lastViewCursor);
    expect(events.some((e) => e.eventType === "clock.sample")).toBe(true);
    expect(x.get().stateVersion).toBe(old.stateVersion);
    expect(x.get().missionTimeMs).toBe(31000);
  });
  it("subscriptions deliver every future committed view event exactly once beyond one outbox page", () => {
    const x = setup();
    const start = Number(x.get().lastViewCursor.split(":").at(-1));
    const seen: P.PublicSseEvent[] = [];
    const stop = x.svc.subscribe(x.sid, (e) => seen.push(e));
    const stopBroken = x.svc.subscribe(x.sid, () => {
      throw Error("subscriber failed");
    });
    task(x, "analyst", "gate_drone");
    for (let i = 0; i < 270; i++) x.advance(1000);
    const end = Number(x.get().lastViewCursor.split(":").at(-1));
    expect(end - start).toBeGreaterThan(250);
    expect(seen.map((e) => e.viewSequence)).toEqual(
      Array.from({ length: end - start }, (_, i) => start + i + 1),
    );
    const late: P.PublicSseEvent[] = [];
    const stopLate = x.svc.subscribe(x.sid, (e) => late.push(e));
    x.advance(1000);
    expect(late.map((e) => e.viewSequence)).toEqual([end + 1]);
    stop();
    stopBroken();
    stopLate();
    const length = seen.length;
    x.advance(1000);
    expect(seen).toHaveLength(length);
  });
  for (const question of ["gate_registration", "gate_activity"])
    it(`fresh drone observation respects the declared capability boundary: ${question}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "last-mile-capability-"));
      dirs.push(dir);
      const dbPath = join(dir, "game.sqlite");
      const x = setup("A", dbPath);
      const before = x.get();
      x.svc.execute(
        "recordDisplay",
        {
          observedStateVersion: before.stateVersion,
          observedSceneId: before.sceneId,
          payload: {
            displayKind: "context_displayed",
            reportId: null,
            jobId: null,
            operationId: null,
          },
        },
        {
          sessionId: x.sid,
          runEpoch: before.runEpoch,
          idempotencyKey: randomUUID(),
        },
      );
      x.command("createTask", {
        taskKind: "investigate_and_report",
        targetRole: "analyst",
        topicId: "gate_status",
        targetId: "gate_drone",
        investigationKind: "drone_observe",
        sourceReportId: null,
        reasonAnnotation: {
          reasonCodes: ["no_new_question"],
          declaredQuestionKey: question,
          acknowledgedLimitation: false,
          comparedKnownCosts: false,
        },
      });
      const outcome = x.command("abandonSession", {
        reason: "player_exit",
      }) as P.OutcomeView;
      x.svc.execute(
        "requestEvaluation",
        {
          sealedHash: outcome.sealedHash,
          evaluationConfigId: "EVALUATION_REFERENCE_V1",
        },
        {
          sessionId: x.sid,
          runEpoch: outcome.runEpoch,
          idempotencyKey: randomUUID(),
        },
      );
      const check = new DatabaseSync(dbPath);
      const row = check
        .prepare(
          "SELECT evaluator_input_json FROM agent_jobs WHERE session_id=? AND agent_role='evaluator'",
        )
        .get(x.sid) as { evaluator_input_json: string };
      const input = JSON.parse(row.evaluator_input_json);
      check.close();
      expect(input.bounds.overCaution.supportCandidates).toHaveLength(
        question === "gate_registration" ? 1 : 0,
      );
    });
  it("a persisted terminal session opens through explicit read-only grant and cannot resume", () => {
    const dir = mkdtempSync(join(tmpdir(), "last-mile-core-"));
    dirs.push(dir);
    const db = join(dir, "game.sqlite");
    const x = setup("A", db);
    task(x, "analyst", "gate_drone");
    x.svc.close();
    services.splice(services.indexOf(x.svc), 1);
    const second = createGameService({
      dbPath: db,
      clock: x.clock,
      resumeSessionIds: [x.sid],
    });
    services.push(second);
    const projection = second.read("getSession", x.sid) as P.SessionProjection;
    expect(projection.lifecycle).toBe("sealed");
    expect(second.hasSessionAccess(x.sid, "command")).toBe(false);
    expect(second.read("getOutcome", x.sid)).toMatchObject({
      terminationReason: "technical_interruption",
    });
    const check = new DatabaseSync(db);
    expect(check.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    check.close();
  });
  it("terminal evaluation and export preserve seal and original gameplay event range", async () => {
    const x = setup();
    x.command("createTask", {
      taskKind: "request_report",
      targetRole: "analyst",
      topicId: "roads",
    });
    x.advance(1000);
    const o = x.command("abandonSession", {
      reason: "player_exit",
    }) as P.OutcomeView;
    const e = x.svc.execute(
      "requestEvaluation",
      {
        sealedHash: o.sealedHash,
        evaluationConfigId: "EVALUATION_REFERENCE_V1",
      },
      { sessionId: x.sid, runEpoch: o.runEpoch, idempotencyKey: randomUUID() },
    ) as P.EvaluationAccepted;
    await settle();
    expect(x.svc.read("getEvaluation", x.sid, e.job.jobId)).toMatchObject({
      status: "fallback",
      mode: "offline_template",
    });
    const exportResult = x.svc.execute(
      "createExport",
      {
        sealedHash: o.sealedHash,
        format: "last-mile-review-json",
        includePlayerStatements: false,
      },
      { sessionId: x.sid, runEpoch: o.runEpoch, idempotencyKey: randomUUID() },
    ) as P.ExportAccepted;
    expect(exportResult.export.artifact?.outcome.sealedHash).toBe(o.sealedHash);
    expect(
      exportResult.export.artifact?.replayPages[0]?.decisions,
    ).toHaveLength(1);
    expect(x.svc.read("getOutcome", x.sid)).toEqual(o);
  });
});

describe("authored route matrix and arrival deadline", () => {
  for (const caseId of ["A", "B"] as const)
    for (const gate of ["E1_MAIN", "E1_BYPASS"])
      for (const market of ["E2_MAIN", "E2_BYPASS"])
        for (const river of ["E3_BRIDGE", "E3_FORD"]) {
          it(`${caseId} ${gate} / ${market} / ${river} resolves authored durations without skipping a scene`, () => {
            const x = setup(caseId);
            const gateMs =
              gate === "E1_BYPASS" ? 130000 : caseId === "A" ? 65000 : 155000;
            action(x, gate);
            x.advance(gateMs);
            expect(x.get().sceneId).toBe("E2");
            const marketMs =
              market === "E2_BYPASS" ? 145000 : caseId === "A" ? 245000 : 75000;
            action(x, market);
            x.advance(marketMs);
            expect(x.get().sceneId).toBe("E3");
            const pendingManifest = gate === "E1_BYPASS",
              pendingInspection = caseId === "A" && market === "E2_MAIN";
            let riverMs =
              river === "E3_BRIDGE"
                ? caseId === "A"
                  ? 105000
                  : 20000
                : 200000 +
                  (pendingManifest ? 20000 : 0) +
                  (pendingInspection ? 25000 : 0);
            action(x, river);
            x.advance(riverMs);
            if (river === "E3_BRIDGE" && caseId === "B") {
              expect(x.get().lifecycle).toBe("active");
              expect(x.get().location.nodeId).toBe("N05");
              expect(x.get().reportQuotas.every((q) => q.used === 0)).toBe(
                true,
              );
              action(x, "E3_FORD");
              const recoveryMs =
                200000 +
                (pendingManifest ? 20000 : 0) +
                (pendingInspection ? 25000 : 0);
              riverMs += recoveryMs;
              x.advance(recoveryMs);
            }
            const expected = 30000 + gateMs + marketMs + riverMs;
            const out = x.svc.read("getOutcome", x.sid) as P.OutcomeView;
            expect(out.sealedAtMissionMs).toBe(Math.min(600000, expected));
            expect(out.taskSuccess).toBe(expected <= 600000);
            expect(out.finalLocation.nodeId === "N07").toBe(expected <= 600000);
            expect(out.handoffCompletedAtMissionMs).toBeNull();
          });
        }
  for (const extra of [0, 1])
    it(`arrival at deadline ${extra === 0 ? "exactly" : "plus one millisecond"}`, () => {
      const x = setup();
      for (let i = 0; i < 4; i++) {
        action(x, "WAIT", 60000);
        x.advance(60000);
      }
      action(x, "WAIT", 15000);
      x.advance(15000);
      x.advance(extra);
      action(x, "E1_MAIN");
      x.advance(65000);
      action(x, "E2_BYPASS");
      x.advance(145000);
      action(x, "E3_BRIDGE");
      x.advance(105000);
      const o = x.svc.read("getOutcome", x.sid) as P.OutcomeView;
      expect(o.sealedAtMissionMs).toBe(600000);
      expect(o.taskSuccess).toBe(extra === 0);
      expect(o.terminationReason).toBe(
        extra === 0 ? "arrived" : "mission_deadline",
      );
    });
  it("five immutable uploads fill quota and tracing produces a new charged report instead of editing original", () => {
    const x = setup();
    x.command("createTask", {
      taskKind: "request_report",
      targetRole: "liaison",
      topicId: "gate_status",
    });
    x.advance(1000);
    const original = x.get().reports[0]!;
    const option = x
      .get()
      .taskOptions.find((t) => t.targetId === "gate_queue.trace")!;
    x.command("createTask", {
      taskKind: "investigate_and_report",
      targetRole: "liaison",
      topicId: option.topicId,
      targetId: option.targetId,
      investigationKind: "provenance_trace",
      sourceReportId: original.reportId,
      reasonAnnotation: null,
    });
    x.advance(15000);
    const trace = x
      .get()
      .reports.find((r) => r.card.statementKind === "provenance")!;
    expect(trace.card.supersedesEvidenceInstanceId).toBe(
      original.evidenceInstanceId,
    );
    expect(trace.revision).toBe(2);
    expect(x.svc.read("getReport", x.sid, original.reportId)).toEqual(original);
    expect(x.get().resources.find((r) => r.channel === "witness")?.spent).toBe(
      1,
    );
    for (let i = 0; i < 3; i++) {
      task(x, "analyst", "gate_drone");
      x.advance(30000);
    }
    x.command("uploadReports", {
      items: x
        .get()
        .reports.map((r) => ({
          reportId: r.reportId,
          expectedRevision: r.revision,
        })),
    });
    expect(x.get().uploadQuota).toMatchObject({ used: 5, remaining: 0 });
    task(x, "liaison", "gate_agency");
    x.advance(15000);
    const sixth = x
      .get()
      .reports.find(
        (r) => !x.get().sceneUploads.some((u) => u.reportId === r.reportId),
      )!;
    expect(() =>
      x.command("uploadReports", {
        items: [{ reportId: sixth.reportId, expectedRevision: sixth.revision }],
      }),
    ).toThrow(DomainError);
    expect(x.get().sceneUploads).toHaveLength(5);
  });
  it("fresh server startup seals an unclosed active session and releases outstanding report reservations", () => {
    const dir = mkdtempSync(join(tmpdir(), "last-mile-recovery-"));
    dirs.push(dir);
    const db = join(dir, "game.sqlite");
    const x = setup("B", db);
    task(x, "analyst", "gate_drone");
    // The old service is deliberately not closed: a new constructor sees durable active rows, as after a killed process.
    const recovered = createGameService({
      dbPath: db,
      clock: x.clock,
      resumeSessionIds: [x.sid],
    });
    services.push(recovered);
    const view = recovered.read("getSession", x.sid) as P.SessionProjection;
    expect(view.lifecycle).toBe("sealed");
    expect(view.activeTasks).toHaveLength(0);
    expect(view.reportQuotas.find((q) => q.role === "analyst")).toMatchObject({
      reserved: 0,
      remaining: 3,
    });
    expect(view.resources.find((r) => r.channel === "drone")?.spent).toBe(1);
    expect(recovered.hasSessionAccess(x.sid, "command")).toBe(false);
  });
});

describe("graceful shutdown catches up due authoritative events", () => {
  for (const extra of [-1, 0])
    it(`closing ${extra === 0 ? "at" : "one millisecond before"} arrival preserves the actual boundary`, () => {
      const dir = mkdtempSync(join(tmpdir(), "last-mile-close-arrival-"));
      dirs.push(dir);
      const dbPath = join(dir, "game.sqlite");
      const x = setup("A", dbPath);
      action(x, "E1_MAIN");
      x.advance(65000);
      action(x, "E2_BYPASS");
      x.advance(145000);
      action(x, "E3_BRIDGE");
      // No tick or read between advancing the clock and closing the service.
      x.clock.advance(105000 + extra);
      x.svc.close();
      const check = new DatabaseSync(dbPath);
      const row = check
        .prepare("SELECT outcome_json FROM terminal_seals WHERE session_id=?")
        .get(x.sid) as { outcome_json: string };
      const outcome = JSON.parse(row.outcome_json) as P.OutcomeView;
      expect(check.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      check.close();
      expect(outcome.taskSuccess).toBe(extra === 0);
      expect(outcome.sealedAtMissionMs).toBe(345000 + extra);
      expect(outcome.terminationReason).toBe(
        extra === 0 ? "arrived" : "technical_interruption",
      );
      expect(outcome.finalLocation.nodeId).toBe(extra === 0 ? "N07" : null);
    });
  for (const extra of [-1, 0])
    it(`closing ${extra === 0 ? "at" : "one millisecond before"} the mission deadline processes only due events`, () => {
      const dir = mkdtempSync(join(tmpdir(), "last-mile-close-deadline-"));
      dirs.push(dir);
      const dbPath = join(dir, "game.sqlite");
      const x = setup("B", dbPath);
      x.clock.advance(570000 + extra);
      x.svc.close();
      const check = new DatabaseSync(dbPath);
      const row = check
        .prepare("SELECT outcome_json FROM terminal_seals WHERE session_id=?")
        .get(x.sid) as { outcome_json: string };
      const outcome = JSON.parse(row.outcome_json) as P.OutcomeView;
      expect(
        check
          .prepare(
            "SELECT COUNT(*) AS n FROM sessions WHERE lifecycle IN ('briefing','running')",
          )
          .get(),
      ).toEqual({ n: 0 });
      check.close();
      expect(outcome.taskSuccess).toBe(false);
      expect(outcome.sealedAtMissionMs).toBe(600000 + extra);
      expect(outcome.terminationReason).toBe(
        extra === 0 ? "mission_deadline" : "technical_interruption",
      );
      expect(outcome.medical.status).toBe("target_missed");
      expect(outcome.medical.note).toContain("优先转送");
    });
});
