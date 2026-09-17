import { afterEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createGameService,
  type GameService,
  type Clock,
} from "../../server/core/service.js";
import type * as P from "../../docs/engineering_v0.5/contracts/public.types.js";
import {
  createAiService,
  MockProvider,
  advisorFallback,
  evaluatorFallback,
  type AdvisorInput,
  type AdvisorOutput,
  type EvaluatorInput,
  type ReasonAnnotation,
} from "../../server/ai/index.js";
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
afterEach(async () => {
  for (const s of services.splice(0)) await s.close();
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const annotation = (
  reasonCodes: ReasonAnnotation["reasonCodes"],
  declaredQuestionKey: string | null = null,
): ReasonAnnotation => ({
  reasonCodes,
  declaredQuestionKey,
  acknowledgedLimitation: false,
  comparedKnownCosts: false,
});
async function setup() {
  const advisorInputs: AdvisorInput[] = [],
    evaluations: EvaluatorInput[] = [];
  const clock = new FakeClock();
  const provider = new MockProvider(async (req) => {
    let value: unknown;
    if (req.role === "advisor") {
      const input = req.input as AdvisorInput;
      advisorInputs.push(structuredClone(input));
      const result: AdvisorOutput = advisorFallback(input, "zh-CN");
      if (input.evidence.length) {
        result.summary = "测试模型仅依据已上传引用提供建议。";
        result.claims = input.evidence.map((e, i) => ({
          claimId: `claim-${i + 1}`,
          kind: "evidenceObservation",
          text: e.text,
          citations: [
            { kind: "evidence", refId: e.instanceId, revision: e.revision },
          ],
        }));
        result.recommendation = {
          actionId: input.publicTask.actions.find((a) => a.actionId !== "WAIT")!
            .actionId,
          rationale: "这是依据已上传资料生成的测试建议。",
          claimRefs: result.claims.map((c) => c.claimId),
          conditions: [],
        };
      }
      value = result;
    } else {
      const input = req.input as EvaluatorInput;
      evaluations.push(structuredClone(input));
      value = evaluatorFallback(input, "zh-CN");
    }
    return { ok: true, value, usage: null, providerRequestId: null };
  });
  const svc = await createGameService({
    clock,
    dbPath: ":memory:",
    selectCase: () => "A",
    agents: createAiService({ provider, env: {} }),
  });
  services.push(svc);
  const boot = (await svc.read("getBootstrap")) as P.BootstrapView;
  const made = (await svc.execute(
    "createSession",
    {
      profileId: "SINGLE_PLAYER_REFERENCE",
      runPurpose: "design_preview",
      locale: "zh-CN",
      contentVersionId: boot.profiles[0]!.contentVersionId,
    },
    { idempotencyKey: randomUUID() },
  )) as P.SessionCreated;
  const sid = made.sessionId,
    get = async () =>
      (await svc.read("getSession", sid)) as P.SessionProjection;
  const command = async (op: any, payload: any) => {
    const v = await get();
    return (await svc.execute(
      op,
      {
        expectedStateVersion: v.stateVersion,
        expectedSceneId: v.sceneId,
        payload,
      },
      { sessionId: sid, runEpoch: v.runEpoch, idempotencyKey: randomUUID() },
    )) as any;
  };
  const advance = async (ms: number) => {
    clock.advance(ms);
    await svc.tick(sid);
  };
  const receipt = async (
    displayKind: P.DisplayReceiptRequest["payload"]["displayKind"],
    ids: Partial<P.DisplayReceiptRequest["payload"]> = {},
  ) => {
    const v = await get();
    return await svc.execute(
      "recordDisplay",
      {
        observedStateVersion: v.stateVersion,
        observedSceneId: v.sceneId,
        payload: {
          displayKind,
          reportId: null,
          jobId: null,
          operationId: null,
          ...ids,
        },
      },
      { sessionId: sid, runEpoch: v.runEpoch, idempotencyKey: randomUUID() },
    );
  };
  const task = async (
    targetId: string,
    reasonAnnotation: ReasonAnnotation | null = null,
  ) => {
    const o = (await get()).taskOptions.find((o) => o.targetId === targetId)!;
    return await command("createTask", {
      taskKind: "investigate_and_report",
      targetRole: o.targetRole,
      targetId,
      topicId: o.topicId,
      investigationKind: o.investigationKind,
      sourceReportId: null,
      reasonAnnotation,
    });
  };
  const openAndUpload = async (report: P.ReportView) => {
    await receipt("report_opened", { reportId: report.reportId });
    await command("uploadReports", {
      items: [{ reportId: report.reportId, expectedRevision: report.revision }],
    });
    await settle();
    const job = (await get()).latestAdviceJob!;
    expect(job.status).toBe("succeeded");
    await receipt("advice_displayed", { jobId: job.jobId });
    return job;
  };
  const decide = async (actionId: string, reasonAnnotation: ReasonAnnotation) =>
    await command("commitAction", {
      actionId,
      waitDurationMs: null,
      reason: "",
      reasonAnnotation,
      basedOnAdviceJobId: null,
      referencedReportIds: [],
      cancelPendingInvestigations: true,
    });
  const evaluate = async () => {
    const outcome = (await command("abandonSession", {
      reason: "player_exit",
    })) as P.OutcomeView;
    await svc.execute(
      "requestEvaluation",
      {
        sealedHash: outcome.sealedHash,
        evaluationConfigId: "EVALUATION_REFERENCE_V1",
      },
      {
        sessionId: sid,
        runEpoch: outcome.runEpoch,
        idempotencyKey: randomUUID(),
      },
    );
    await settle();
    expect(evaluations).toHaveLength(1);
    return evaluations[0]!;
  };
  await command("startSession", { acknowledgeDesignPreview: true });
  await advance(30000);
  // Async storage permits the automatic E1 analysis to finish between reads and
  // commands. Start the behavior scenario from its settled, visible baseline.
  for (let i = 0; i < 100; i++) {
    const job = (await get()).latestAdviceJob;
    if (job && !["queued", "running"].includes(job.status)) break;
    await settle();
  }
  expect((await get()).latestAdviceJob?.status).toBe("succeeded");
  return {
    svc,
    sid,
    get,
    command,
    advance,
    receipt,
    task,
    openAndUpload,
    decide,
    evaluate,
    advisorInputs,
    evaluations,
  };
}
describe("AI boundaries through legal authoritative domain events", () => {
  it("can observe complacency with shown uncertainty, affordable check and explicit AI-only reason", async () => {
    const x = await setup();
    await x.command("createTask", {
      taskKind: "request_report",
      targetRole: "analyst",
      topicId: "roads",
    });
    await x.advance(1000);
    await x.openAndUpload((await x.get()).reports[0]!);
    await x.receipt("context_displayed");
    await x.decide("E1_MAIN", annotation(["ai_said_so"]));
    const e = await x.evaluate();
    expect(e.bounds.complacency.eligibleOpportunities).toBe(1);
    expect(e.bounds.complacency.supportCandidates).toHaveLength(1);
    expect(e.contexts.every((c) => c.controllerKind === "human")).toBe(true);
    expect(JSON.stringify(e)).not.toMatch(
      /hiddenRootId|privateCaseId|taskSuccess|endingText/,
    );
  });
  it("can observe distrust with displayed current supporting evidence and explicit past-error-only rejection", async () => {
    const x = await setup();
    await x.task("gate_agency");
    await x.advance(15000);
    await x.openAndUpload((await x.get()).reports[0]!);
    await x.receipt("context_displayed");
    await x.decide("E1_BYPASS", annotation(["prior_ai_error_only"]));
    const e = await x.evaluate();
    expect(e.bounds.distrust.eligibleOpportunities).toBe(1);
    expect(e.bounds.distrust.supportCandidates).toHaveLength(1);
  });
  it("can observe over-caution only after disclosed channel limitation and explicit no-new-question", async () => {
    const x = await setup();
    await x.receipt("context_displayed");
    await x.task(
      "gate_satellite",
      annotation(["no_new_question"], "gate_registration"),
    );
    const e = await x.evaluate();
    expect(e.bounds.overCaution.eligibleOpportunities).toBe(1);
    expect(e.bounds.overCaution.supportCandidates).toHaveLength(1);
  });
  it.each([
    { question: "gate_registration", expected: 1 },
    { question: "gate_activity", expected: 0 },
  ])(
    "drone refresh does not erase a disclosed capability limit for $question",
    async ({ question, expected }) => {
      const x = await setup();
      await x.receipt("context_displayed");
      await x.task("gate_drone", annotation(["no_new_question"], question));
      const e = await x.evaluate();
      expect(e.bounds.overCaution.supportCandidates).toHaveLength(expected);
    },
  );
  it("does not score an old displayed recommendation after a new authorized context supersedes it", async () => {
    const x = await setup();
    await x.command("createTask", {
      taskKind: "request_report",
      targetRole: "analyst",
      topicId: "roads",
    });
    await x.advance(1000);
    const old = await x.openAndUpload((await x.get()).reports[0]!);
    await x.command("askAdvisor", {
      expectedInboxVersion: (await x.get()).inboxVersion,
      questionKind: "uncertainties",
      text: null,
      uploadBatch: [],
    });
    await settle();
    expect((await x.get()).latestAdviceJob!.jobId).not.toBe(old.jobId);
    // The new result is deliberately not acknowledged as displayed.
    await x.receipt("context_displayed");
    await x.decide("E1_MAIN", annotation(["ai_said_so"]));
    const e = await x.evaluate();
    expect(e.bounds.complacency.supportCandidates).toHaveLength(0);
    expect(e.contexts.at(-1)!.displayedAdviceId).toBeNull();
  });
  it("does not give Advisor unuploaded cards, private state, time progression or a prior scene snapshot", async () => {
    const x = await setup();
    await settle();
    const first = x.advisorInputs.at(-1)!;
    expect(first.evidence).toHaveLength(0);
    await x.task("gate_agency");
    await x.advance(15000);
    await settle();
    expect(x.advisorInputs.at(-1)!.inputHash).toBe(first.inputHash);
    expect(x.advisorInputs.at(-1)!.evidence).toHaveLength(0);
    await x.openAndUpload((await x.get()).reports[0]!);
    const uploaded = x.advisorInputs.at(-1)!;
    expect(uploaded.evidence).toHaveLength(1);
    expect(uploaded.evidence[0]!.text).toContain("电子登记在线");
    expect(JSON.stringify(uploaded)).not.toMatch(
      /missionTimeMs|receivedAtMissionMs|validUntilMissionMs|hiddenRootId|privateCaseId|medical|resourceBalance|remaining/,
    );
    await x.decide("E1_MAIN", annotation(["evidence_supported"]));
    await x.advance(65000);
    await settle();
    const next = x.advisorInputs.at(-1)!;
    expect(next.sceneId).toBe("E2");
    expect(next.evidence).toHaveLength(0);
    expect(next.statements).toHaveLength(0);
  });
});
