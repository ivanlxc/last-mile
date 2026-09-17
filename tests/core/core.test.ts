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
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});
async function setup(caseId: "A" | "B" = "A", dbPath = ":memory:") {
  const clock = new FakeClock();
  const svc = await createGameService({
    clock,
    dbPath,
    selectCase: () => caseId,
  });
  services.push(svc);
  const boot = (await svc.read("getBootstrap")) as P.BootstrapView;
  const create = {
    profileId: "SINGLE_PLAYER_REFERENCE",
    runPurpose: "design_preview",
    locale: "zh-CN",
    contentVersionId: boot.profiles[0]!.contentVersionId,
  };
  const made = (await svc.execute("createSession", create, {
    idempotencyKey: randomUUID(),
  })) as P.SessionCreated;
  const sid = made.sessionId;
  const get = async () => {
    // Offline advice now publishes asynchronously, just like a real provider.
    // Freeze test decisions only after those background state changes settle.
    for (let i = 0; i < 100; i++) {
      const view = (await svc.read("getSession", sid)) as P.SessionProjection;
      if (
        !view.latestAdviceJob ||
        !["queued", "running"].includes(view.latestAdviceJob.status)
      )
        return view;
      await settle();
    }
    throw new Error("Offline advice did not settle");
  };
  const command = async (op: any, payload: any, extra: any = {}) => {
    const v = await get();
    return (await svc.execute(
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
    )) as any;
  };
  const advance = async (n: number) => {
    clock.advance(n);
    await svc.tick(sid);
    return await get();
  };
  await command("startSession", { acknowledgeDesignPreview: true });
  await advance(30000);
  return { svc, clock, sid, get, command, advance, made };
}
async function task(
  x: Awaited<ReturnType<typeof setup>>,
  role: "analyst" | "liaison",
  targetId: string,
) {
  const o = (await x.get()).taskOptions.find((t) => t.targetId === targetId)!;
  return (await x.command("createTask", {
    taskKind: "investigate_and_report",
    targetRole: role,
    targetId,
    topicId: o.topicId,
    investigationKind: o.investigationKind,
    sourceReportId: null,
    reasonAnnotation: null,
  })) as P.TaskAccepted;
}
async function action(
  x: Awaited<ReturnType<typeof setup>>,
  actionId: string,
  waitDurationMs: number | null = null,
) {
  return (await x.command("commitAction", {
    actionId,
    waitDurationMs,
    reason: "",
    reasonAnnotation: null,
    basedOnAdviceJobId: null,
    referencedReportIds: [],
    cancelPendingInvestigations: true,
  })) as P.ActionAccepted;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
describe("SQLite authoritative core", () => {
  it("runs case A all three main decisions including market partial out-and-back, then seals arrival", async () => {
    const x = await setup();
    expect((await x.get()).sceneId).toBe("E1");
    await action(x, "E1_MAIN");
    await x.advance(65000);
    expect((await x.get()).sceneId).toBe("E2");
    await action(x, "E2_MAIN");
    let v = await x.advance(35000);
    expect(v.location.routeId).toBe("R04");
    expect(v.location.progressPermille).toBe(200);
    v = await x.advance(20000);
    expect(v.location.routeId).toBe("R04");
    expect(v.location.progressPermille).toBe(200);
    await x.advance(190000);
    expect((await x.get()).sceneId).toBe("E3");
    await action(x, "E3_BRIDGE");
    v = await x.advance(105000);
    expect(v.lifecycle).toBe("sealed");
    const o = (await x.svc.read("getOutcome", x.sid)) as P.OutcomeView;
    expect(o.taskSuccess).toBe(true);
    expect(o.sealedAtMissionMs).toBe(445000);
    expect(o.pendingTasks.inspection).toBe("pending");
    expect(o.handoffCompletedAtMissionMs).toBeNull();
  });
  it("case B bridge refusal stays in E3 with same quotas; ford clears actual conditional manifest hold", async () => {
    const x = await setup("B");
    await action(x, "E1_BYPASS");
    await x.advance(130000);
    await action(x, "E2_MAIN");
    await x.advance(75000);
    const quota = (await x.get()).uploadQuota;
    await action(x, "E3_BRIDGE");
    await x.advance(20000);
    expect((await x.get()).sceneId).toBe("E3");
    expect((await x.get()).uploadQuota).toEqual(quota);
    expect(
      (await x.get()).actionOptions.find((a) => a.actionId === "E3_BRIDGE")
        ?.available,
    ).toBe(false);
    await action(x, "E3_FORD");
    await x.advance(140000);
    expect((await x.get()).location.nodeId).toBe("N10");
    expect((await x.get()).pendingTasks.manifest).toBe("pending");
    await x.advance(20000);
    expect((await x.get()).pendingTasks.manifest).toBe("completed");
    await x.advance(60000);
    const o = (await x.svc.read("getOutcome", x.sid)) as P.OutcomeView;
    expect(o.taskSuccess).toBe(true);
    expect(o.sealedAtMissionMs).toBe(475000);
  });
  it("two roles observe concurrently on one clock, and same-role second task cannot take resources", async () => {
    const x = await setup();
    await task(x, "analyst", "gate_drone");
    await task(x, "liaison", "gate_agency");
    await expect(task(x, "analyst", "service_drone")).rejects.toThrow(
      DomainError,
    );
    let v = await x.advance(15000);
    expect(v.reports).toHaveLength(1);
    expect(v.activeTasks).toHaveLength(1);
    v = await x.advance(15000);
    expect(v.reports).toHaveLength(2);
    expect(v.missionTimeMs).toBe(60000);
    expect(v.resources.find((r) => r.channel === "drone")?.spent).toBe(1);
  });
  it("WAIT leaves investigation active and permits other-role tasks without double charging time", async () => {
    const x = await setup();
    await task(x, "analyst", "gate_drone");
    await action(x, "WAIT", 15000);
    await task(x, "liaison", "gate_agency");
    const v = await x.advance(15000);
    expect(v.phase).toBe("scene");
    expect(v.activeOperation).toBeNull();
    expect(v.activeTasks).toHaveLength(1);
    expect(v.reports).toHaveLength(1);
    expect(v.missionTimeMs).toBe(45000);
  });
  it("leaving cancels unfinished tasks, releases report reservation and retains spent channel", async () => {
    const x = await setup();
    const t = await task(x, "analyst", "gate_drone");
    await action(x, "E1_MAIN");
    const v = await x.get();
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
    expect(await x.svc.read("getTask", x.sid, t.task.taskId)).toMatchObject({
      status: "cancelled",
      failureCode: "scene_left",
    });
    await x.advance(65000);
    expect(
      (await x.get()).resources.find((r) => r.channel === "drone")?.remaining,
    ).toBe(2);
  });
  it("cached success precedes CAS, different content same key conflicts, catch-up survives rejected stale command", async () => {
    const x = await setup();
    const before = await x.get();
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
    const first = await x.svc.execute("createTask", body, meta);
    x.clock.advance(30000);
    expect(await x.svc.execute("createTask", body, meta)).toEqual(first);
    expect(x.svc.lastExecutionReplayed).toBe(true);
    await expect(
      x.svc.execute(
        "createTask",
        { ...body, payload: { ...body.payload, targetId: "service_drone" } },
        meta,
      ),
    ).rejects.toThrowError(/请求键/);
    await expect(
      x.svc.execute(
        "commitAction",
        {
          expectedStateVersion: before.stateVersion,
          expectedSceneId: "E1",
          payload: {},
        },
        { ...meta, idempotencyKey: randomUUID() },
      ),
    ).rejects.toThrow(DomainError);
    expect((await x.get()).reports).toHaveLength(1);
    expect(
      (await x.get()).resources.find((r) => r.channel === "drone")?.spent,
    ).toBe(1);
  });
  it("batch upload is all-or-none and AI only gets explicitly uploaded cards", async () => {
    const x = await setup();
    await task(x, "analyst", "gate_drone");
    await task(x, "liaison", "gate_agency");
    await x.advance(30000);
    const [r] = (await x.get()).reports;
    await expect(
      x.command("uploadReports", {
        items: [
          { reportId: r!.reportId, expectedRevision: r!.revision },
          { reportId: randomUUID(), expectedRevision: 1 },
        ],
      }),
    ).rejects.toThrow(DomainError);
    expect((await x.get()).uploadQuota?.used).toBe(0);
    await x.command("uploadReports", {
      items: [{ reportId: r!.reportId, expectedRevision: r!.revision }],
    });
    expect((await x.get()).sceneUploads).toHaveLength(1);
    expect((await x.get()).unuploadedReportIds).toHaveLength(1);
    await settle();
    expect((await x.get()).latestAdviceJob?.mode).toBe("offline_template");
    expect((await x.get()).latestAdviceJob?.attemptCount).toBe(0);
    expect(JSON.stringify(await x.get())).not.toMatch(
      /privateCaseId|hiddenRootId|explosionCause/,
    );
  });
  it("channel resources are shared across scenes and never reset on entry", async () => {
    const x = await setup();
    await task(x, "analyst", "gate_satellite");
    await x.advance(10000);
    await action(x, "E1_MAIN");
    await x.advance(65000);
    expect(
      (await x.get()).resources.find((r) => r.channel === "satellite")
        ?.remaining,
    ).toBe(1);
    await task(x, "analyst", "market_satellite");
    await x.advance(10000);
    expect(
      (await x.get()).resources.find((r) => r.channel === "satellite")
        ?.remaining,
    ).toBe(0);
    await expect(task(x, "analyst", "market_satellite")).rejects.toThrow(
      DomainError,
    );
  });
  it("mission deadline preserves a partial route location and refuses post-terminal gameplay", async () => {
    const x = await setup();
    for (let i = 0; i < 6; i++) {
      await action(x, "WAIT", 60000);
      await x.advance(60000);
    }
    await action(x, "E1_MAIN");
    await x.advance(65000);
    await action(x, "E2_MAIN");
    await x.advance(145000);
    const o = (await x.svc.read("getOutcome", x.sid)) as P.OutcomeView;
    expect(o.terminationReason).toBe("mission_deadline");
    expect(o.taskSuccess).toBe(false);
    expect(o.finalLocation.nodeId).toBeNull();
    expect(o.finalLocation.routeId).toBe("R03");
    await expect(action(x, "WAIT", 15000)).rejects.toThrow(DomainError);
  });
  it("medical status is stable at 479999 ms and changes to priority transfer exactly at 480000 ms", async () => {
    const x = await setup();
    expect((await x.get()).medical.status).toBe("stable");
    expect((await x.get()).medical.note).toContain("稳定");
    const before = await x.advance(449999);
    expect(before.missionTimeMs).toBe(479999);
    expect(before.medical.status).toBe("stable");
    const after = await x.advance(1);
    expect(after.missionTimeMs).toBe(480000);
    expect(after.medical.status).toBe("target_missed");
    expect(after.medical.note).toContain("需要优先转送");
    expect(after.civilianCount).toBe(20);
    expect(after.lifecycle).toBe("active");
  });
  it("clock samples advance view cursor but neither stateVersion nor game event count", async () => {
    const x = await setup();
    const old = await x.get();
    await x.advance(1000);
    const events = await x.svc.getEventsSince(x.sid, old.lastViewCursor);
    expect(events.some((e) => e.eventType === "clock.sample")).toBe(true);
    expect((await x.get()).stateVersion).toBe(old.stateVersion);
    expect((await x.get()).missionTimeMs).toBe(31000);
  });
  it("subscriptions deliver every future committed view event exactly once beyond one outbox page", async () => {
    const x = await setup();
    const start = Number((await x.get()).lastViewCursor.split(":").at(-1));
    const seen: P.PublicSseEvent[] = [];
    const stop = await x.svc.subscribe(x.sid, (e) => seen.push(e));
    const stopBroken = await x.svc.subscribe(x.sid, () => {
      throw Error("subscriber failed");
    });
    await task(x, "analyst", "gate_drone");
    for (let i = 0; i < 270; i++) await x.advance(1000);
    const end = Number((await x.get()).lastViewCursor.split(":").at(-1));
    expect(end - start).toBeGreaterThan(250);
    expect(seen.map((e) => e.viewSequence)).toEqual(
      Array.from({ length: end - start }, (_, i) => start + i + 1),
    );
    const late: P.PublicSseEvent[] = [];
    const stopLate = await x.svc.subscribe(x.sid, (e) => late.push(e));
    await x.advance(1000);
    expect(late.map((e) => e.viewSequence)).toEqual([end + 1]);
    stop();
    stopBroken();
    stopLate();
    const length = seen.length;
    await x.advance(1000);
    expect(seen).toHaveLength(length);
  });
  for (const question of ["gate_registration", "gate_activity"])
    it(`fresh drone observation respects the declared capability boundary: ${question}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "last-mile-capability-"));
      dirs.push(dir);
      const dbPath = join(dir, "game.sqlite");
      const x = await setup("A", dbPath);
      const before = await x.get();
      await x.svc.execute(
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
      await x.command("createTask", {
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
      const outcome = (await x.command("abandonSession", {
        reason: "player_exit",
      })) as P.OutcomeView;
      await x.svc.execute(
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
  it("a persisted terminal session opens through explicit read-only grant and cannot resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "last-mile-core-"));
    dirs.push(dir);
    const db = join(dir, "game.sqlite");
    const x = await setup("A", db);
    await task(x, "analyst", "gate_drone");
    await x.svc.close();
    services.splice(services.indexOf(x.svc), 1);
    const second = await createGameService({
      dbPath: db,
      clock: x.clock,
      resumeSessionIds: [x.sid],
    });
    services.push(second);
    const projection = (await second.read(
      "getSession",
      x.sid,
    )) as P.SessionProjection;
    expect(projection.lifecycle).toBe("sealed");
    expect(await second.hasSessionAccess(x.sid, "command")).toBe(false);
    expect(await second.read("getOutcome", x.sid)).toMatchObject({
      terminationReason: "technical_interruption",
    });
    const check = new DatabaseSync(db);
    expect(check.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    check.close();
  });
  it("terminal evaluation and export preserve seal and original gameplay event range", async () => {
    const x = await setup();
    await x.command("createTask", {
      taskKind: "request_report",
      targetRole: "analyst",
      topicId: "roads",
    });
    await x.advance(1000);
    const o = (await x.command("abandonSession", {
      reason: "player_exit",
    })) as P.OutcomeView;
    const e = (await x.svc.execute(
      "requestEvaluation",
      {
        sealedHash: o.sealedHash,
        evaluationConfigId: "EVALUATION_REFERENCE_V1",
      },
      { sessionId: x.sid, runEpoch: o.runEpoch, idempotencyKey: randomUUID() },
    )) as P.EvaluationAccepted;
    await settle();
    expect(await x.svc.read("getEvaluation", x.sid, e.job.jobId)).toMatchObject(
      {
        status: "fallback",
        mode: "offline_template",
      },
    );
    const exportResult = (await x.svc.execute(
      "createExport",
      {
        sealedHash: o.sealedHash,
        format: "last-mile-review-json",
        includePlayerStatements: false,
      },
      { sessionId: x.sid, runEpoch: o.runEpoch, idempotencyKey: randomUUID() },
    )) as P.ExportAccepted;
    expect(exportResult.export.artifact?.outcome.sealedHash).toBe(o.sealedHash);
    expect(
      exportResult.export.artifact?.replayPages[0]?.decisions,
    ).toHaveLength(1);
    expect(await x.svc.read("getOutcome", x.sid)).toEqual(o);
  });
});

describe("authored route matrix and arrival deadline", () => {
  for (const caseId of ["A", "B"] as const)
    for (const gate of ["E1_MAIN", "E1_BYPASS"])
      for (const market of ["E2_MAIN", "E2_BYPASS"])
        for (const river of ["E3_BRIDGE", "E3_FORD"]) {
          it(`${caseId} ${gate} / ${market} / ${river} resolves authored durations without skipping a scene`, async () => {
            const x = await setup(caseId);
            const gateMs =
              gate === "E1_BYPASS" ? 130000 : caseId === "A" ? 65000 : 155000;
            await action(x, gate);
            await x.advance(gateMs);
            expect((await x.get()).sceneId).toBe("E2");
            const marketMs =
              market === "E2_BYPASS" ? 145000 : caseId === "A" ? 245000 : 75000;
            await action(x, market);
            await x.advance(marketMs);
            expect((await x.get()).sceneId).toBe("E3");
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
            await action(x, river);
            await x.advance(riverMs);
            if (river === "E3_BRIDGE" && caseId === "B") {
              expect((await x.get()).lifecycle).toBe("active");
              expect((await x.get()).location.nodeId).toBe("N05");
              expect(
                (await x.get()).reportQuotas.every((q) => q.used === 0),
              ).toBe(true);
              await action(x, "E3_FORD");
              const recoveryMs =
                200000 +
                (pendingManifest ? 20000 : 0) +
                (pendingInspection ? 25000 : 0);
              riverMs += recoveryMs;
              await x.advance(recoveryMs);
            }
            const expected = 30000 + gateMs + marketMs + riverMs;
            const out = (await x.svc.read(
              "getOutcome",
              x.sid,
            )) as P.OutcomeView;
            expect(out.sealedAtMissionMs).toBe(Math.min(600000, expected));
            expect(out.taskSuccess).toBe(expected <= 600000);
            expect(out.finalLocation.nodeId === "N07").toBe(expected <= 600000);
            expect(out.handoffCompletedAtMissionMs).toBeNull();
          });
        }
  for (const extra of [0, 1])
    it(`arrival at deadline ${extra === 0 ? "exactly" : "plus one millisecond"}`, async () => {
      const x = await setup();
      for (let i = 0; i < 4; i++) {
        await action(x, "WAIT", 60000);
        await x.advance(60000);
      }
      await action(x, "WAIT", 15000);
      await x.advance(15000);
      await x.advance(extra);
      await action(x, "E1_MAIN");
      await x.advance(65000);
      await action(x, "E2_BYPASS");
      await x.advance(145000);
      await action(x, "E3_BRIDGE");
      await x.advance(105000);
      const o = (await x.svc.read("getOutcome", x.sid)) as P.OutcomeView;
      expect(o.sealedAtMissionMs).toBe(600000);
      expect(o.taskSuccess).toBe(extra === 0);
      expect(o.terminationReason).toBe(
        extra === 0 ? "arrived" : "mission_deadline",
      );
    });
  it("five immutable uploads fill quota and tracing produces a new charged report instead of editing original", async () => {
    const x = await setup();
    await x.command("createTask", {
      taskKind: "request_report",
      targetRole: "liaison",
      topicId: "gate_status",
    });
    await x.advance(1000);
    const original = (await x.get()).reports[0]!;
    const option = (await x.get()).taskOptions.find(
      (t) => t.targetId === "gate_queue.trace",
    )!;
    await x.command("createTask", {
      taskKind: "investigate_and_report",
      targetRole: "liaison",
      topicId: option.topicId,
      targetId: option.targetId,
      investigationKind: "provenance_trace",
      sourceReportId: original.reportId,
      reasonAnnotation: null,
    });
    await x.advance(15000);
    const trace = (await x.get()).reports.find(
      (r) => r.card.statementKind === "provenance",
    )!;
    expect(trace.card.supersedesEvidenceInstanceId).toBe(
      original.evidenceInstanceId,
    );
    expect(trace.revision).toBe(2);
    expect(await x.svc.read("getReport", x.sid, original.reportId)).toEqual(
      original,
    );
    expect(
      (await x.get()).resources.find((r) => r.channel === "witness")?.spent,
    ).toBe(1);
    for (let i = 0; i < 3; i++) {
      await task(x, "analyst", "gate_drone");
      await x.advance(30000);
    }
    await x.command("uploadReports", {
      items: (await x.get()).reports.map((r) => ({
        reportId: r.reportId,
        expectedRevision: r.revision,
      })),
    });
    expect((await x.get()).uploadQuota).toMatchObject({
      used: 5,
      remaining: 0,
    });
    await task(x, "liaison", "gate_agency");
    await x.advance(15000);
    const current = await x.get();
    const sixth = current.reports.find(
      (r) => !current.sceneUploads.some((u) => u.reportId === r.reportId),
    )!;
    await expect(
      x.command("uploadReports", {
        items: [{ reportId: sixth.reportId, expectedRevision: sixth.revision }],
      }),
    ).rejects.toThrow(DomainError);
    expect((await x.get()).sceneUploads).toHaveLength(5);
  });
  it("fresh server startup seals an unclosed active session and releases outstanding report reservations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "last-mile-recovery-"));
    dirs.push(dir);
    const db = join(dir, "game.sqlite");
    const x = await setup("B", db);
    await task(x, "analyst", "gate_drone");
    // The old service is deliberately not closed: a new constructor sees durable active rows, as after a killed process.
    const recovered = await createGameService({
      dbPath: db,
      clock: x.clock,
      resumeSessionIds: [x.sid],
    });
    services.push(recovered);
    const view = (await recovered.read(
      "getSession",
      x.sid,
    )) as P.SessionProjection;
    expect(view.lifecycle).toBe("sealed");
    expect(view.activeTasks).toHaveLength(0);
    expect(view.reportQuotas.find((q) => q.role === "analyst")).toMatchObject({
      reserved: 0,
      remaining: 3,
    });
    expect(view.resources.find((r) => r.channel === "drone")?.spent).toBe(1);
    expect(await recovered.hasSessionAccess(x.sid, "command")).toBe(false);
  });
});

describe("graceful shutdown catches up due authoritative events", () => {
  for (const extra of [-1, 0])
    it(`closing ${extra === 0 ? "at" : "one millisecond before"} arrival preserves the actual boundary`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "last-mile-close-arrival-"));
      dirs.push(dir);
      const dbPath = join(dir, "game.sqlite");
      const x = await setup("A", dbPath);
      await action(x, "E1_MAIN");
      await x.advance(65000);
      await action(x, "E2_BYPASS");
      await x.advance(145000);
      await action(x, "E3_BRIDGE");
      // No tick or read between advancing the clock and closing the service.
      x.clock.advance(105000 + extra);
      await x.svc.close();
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
    it(`closing ${extra === 0 ? "at" : "one millisecond before"} the mission deadline processes only due events`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "last-mile-close-deadline-"));
      dirs.push(dir);
      const dbPath = join(dir, "game.sqlite");
      const x = await setup("B", dbPath);
      x.clock.advance(570000 + extra);
      await x.svc.close();
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
