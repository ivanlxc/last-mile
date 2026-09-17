import { afterEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createGameService,
  type GameService,
  type Clock,
  type AgentGateway,
} from "../../server/core/service.js";
import {
  createAiService,
  MockProvider,
  advisorFallback,
  evaluatorFallback,
  advisorInputHash,
  guardAdvice,
  guardEvaluatorInput,
  type AdvisorInput,
  type EvaluatorInput,
  type ProviderRequest,
} from "../../server/ai/index.js";
import { canonical, hash } from "../../server/core/world.js";
import { localizePublic } from "../../server/core/locales/index.js";
import { localizeTree, type Locale } from "../../server/localization.js";
import { publicChannelScopeText } from "../../server/ai/public-checks.js";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";
import { ContractRegistry } from "../../server/http/contracts.js";
import type * as P from "../../docs/engineering_v0.5/contracts/public.types.js";
const services: GameService[] = [];
const temporaryDirs: string[] = [];
afterEach(async () => {
  for (const svc of services.splice(0)) await svc.close();
  for (const dir of temporaryDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const han = (value: unknown) => /[\p{Script=Han}]/u.test(JSON.stringify(value));
class TestClock implements Clock {
  elapsed = 0;
  nowMs() {
    return 1800000000000 + this.elapsed;
  }
  monotonicMs() {
    return this.elapsed;
  }
}
async function setup(
  locale: Locale,
  caseId: "A" | "B" = "A",
  mockLive = false,
  dbPath = ":memory:",
) {
  const clock = new TestClock(),
    advisorInputs: AdvisorInput[] = [],
    evaluatorInputs: EvaluatorInput[] = [];
  const generated: any[] = [];
  const provider = mockLive
    ? new MockProvider(async (request) => {
        const value: any =
          request.role === "advisor"
            ? advisorFallback(request.input as AdvisorInput, locale)
            : evaluatorFallback(request.input as EvaluatorInput, locale);
        if (
          request.role === "advisor" &&
          (request.input as AdvisorInput).evidence.length
        ) {
          const e = (request.input as AdvisorInput).evidence[0]!;
          value.claims = [
            {
              claimId: "claim-1",
              kind: "evidenceObservation",
              text: e.text,
              citations: [
                { kind: "evidence", refId: e.instanceId, revision: e.revision },
              ],
            },
          ];
          value.recommendation = {
            actionId: "E1_MAIN",
            rationale: "Use the cited current report",
            claimRefs: ["claim-1"],
            conditions: [],
          };
        }
        value.summary = "Player quote: 原地等待";
        generated.push(structuredClone(value));
        return { ok: true, value, usage: null, providerRequestId: null };
      })
    : undefined;
  const offline = createAiService({
    provider,
    env: { MODEL_PROVIDER: "offline" },
  });
  const agents: AgentGateway = {
    ...offline,
    runAdvisor: (input, control) => {
      advisorInputs.push(structuredClone(input));
      expect(control.locale).toBe(locale);
      return offline.runAdvisor(input, control);
    },
    runEvaluator: (input, control) => {
      evaluatorInputs.push(structuredClone(input));
      expect(control.locale).toBe(locale);
      return offline.runEvaluator(input, control);
    },
  };
  const svc = await createGameService({
    dbPath,
    clock,
    agents,
    selectCase: () => caseId,
  });
  services.push(svc);
  const bootstrap = (await svc.read("getBootstrap")) as P.BootstrapView;
  const created = (await svc.execute(
    "createSession",
    {
      profileId: "SINGLE_PLAYER_REFERENCE",
      runPurpose: "design_preview",
      locale,
      contentVersionId: bootstrap.profiles[0]!.contentVersionId,
    },
    { idempotencyKey: randomUUID() },
  )) as P.SessionCreated;
  const sid = created.sessionId,
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
    clock.elapsed += ms;
    await svc.tick(sid);
    await settle();
  };
  const receipt = async (
    kind: P.DisplayReceiptRequest["payload"]["displayKind"],
    ids: Partial<P.DisplayReceiptRequest["payload"]> = {},
  ) => {
    const v = await get();
    return await svc.execute(
      "recordDisplay",
      {
        observedStateVersion: v.stateVersion,
        observedSceneId: v.sceneId,
        payload: {
          displayKind: kind,
          reportId: null,
          jobId: null,
          operationId: null,
          ...ids,
        },
      },
      { sessionId: sid, runEpoch: v.runEpoch, idempotencyKey: randomUUID() },
    );
  };
  const task = async (targetId: string, reasonAnnotation: any = null) => {
    const o = (await get()).taskOptions.find((o) => o.targetId === targetId)!;
    return (await command("createTask", {
      taskKind: "investigate_and_report",
      targetRole: o.targetRole,
      topicId: o.topicId,
      targetId,
      investigationKind: o.investigationKind,
      sourceReportId: null,
      reasonAnnotation,
    })) as P.TaskAccepted;
  };
  const action = async (
    actionId: string,
    reason = "",
    declaredQuestionKey: string | null = null,
  ) =>
    (await command("commitAction", {
      actionId,
      waitDurationMs: null,
      reason,
      reasonAnnotation: {
        reasonCodes: ["no_reason"],
        acknowledgedLimitation: false,
        comparedKnownCosts: false,
        declaredQuestionKey,
      },
      basedOnAdviceJobId: null,
      referencedReportIds: [],
      cancelPendingInvestigations: true,
    })) as P.ActionAccepted;
  return {
    svc,
    sid,
    clock,
    get,
    command,
    advance,
    receipt,
    task,
    action,
    created,
    bootstrap,
    advisorInputs,
    evaluatorInputs,
    generated,
  };
}
describe("session-bound backend localization", () => {
  it("defaults public metadata to English and preserves the selected locale across projection refreshes", async () => {
    const x = await setup("en-US"),
      zh = await setup("zh-CN");
    expect(x.bootstrap.defaultLocale).toBe("en-US");
    expect(x.bootstrap.supportedLocales).toEqual(["en-US", "zh-CN"]);
    expect(han(x.bootstrap)).toBe(false);
    expect(x.created.projection.locale).toBe("en-US");
    expect((await x.get()).locale).toBe("en-US");
    expect(han(await x.get())).toBe(false);
    expect((await zh.get()).locale).toBe("zh-CN");
    expect(han(await zh.get())).toBe(true);
    const registry = new ContractRegistry(process.cwd());
    expect(registry.errors("BootstrapView", x.bootstrap)).toEqual([]);
    expect(registry.errors("SessionProjection", await x.get())).toEqual([]);
  });
  it.each(["en-US", "zh-CN"] as const)(
    "%s keeps displayed cards, upload hashes and authorized Advisor evidence consistent",
    async (locale) => {
      const x = await setup(locale);
      await x.command("startSession", { acknowledgeDesignPreview: true });
      await x.advance(30000);
      await x.task("gate_agency");
      await x.advance(15000);
      const report = (await x.get()).reports[0]!,
        read = (await x.svc.read(
          "getReport",
          x.sid,
          report.reportId,
        )) as P.ReportView;
      expect(read).toEqual(report);
      expect(han(report)).toBe(locale === "zh-CN");
      await x.receipt("report_opened", { reportId: report.reportId });
      const upload = (await x.command("uploadReports", {
        items: [
          { reportId: report.reportId, expectedRevision: report.revision },
        ],
      })) as P.UploadView;
      await settle();
      expect(upload.added[0]!.payloadHash).toBe(hash(report.card));
      const input = x.advisorInputs.at(-1)!;
      expect(input.evidence[0]!.text).toBe(report.card.body);
      expect(input.evidence[0]!.sourceLabel).toBe(report.card.sourceLabel);
      expect(input.evidence[0]!.scope).toBe(report.card.observationScope);
      expect(input.inputHash).toBe(advisorInputHash(input));
      expect(input.evidence[0]!.instanceId).toBe(report.evidenceInstanceId);
      expect(input.evidence[0]!.revision).toBe(report.revision);
      expect(han(input)).toBe(locale === "zh-CN");
      const fallback = (await x.get()).latestAdviceJob!;
      expect(fallback.mode).toBe("offline_template");
      expect(han(fallback.result)).toBe(locale === "zh-CN");
      expect((fallback.result as any).recommendation.actionId).toBeNull();
      guardAdvice(input, fallback.result);
    },
  );
  it("keeps bilingual route decisions identical in time, resource cost and outcome", async () => {
    const snapshots = [];
    for (const locale of ["en-US", "zh-CN"] as const) {
      const x = await setup(locale);
      await x.command("startSession", { acknowledgeDesignPreview: true });
      await x.advance(30000);
      for (const [action, duration] of [
        ["E1_MAIN", 65000],
        ["E2_MAIN", 245000],
        ["E3_BRIDGE", 105000],
      ] as const) {
        const accepted = await x.action(action);
        expect(han(accepted)).toBe(locale === "zh-CN");
        await x.advance(duration);
      }
      const outcome = (await x.svc.read("getOutcome", x.sid)) as P.OutcomeView;
      expect(han(outcome)).toBe(locale === "zh-CN");
      if (locale === "en-US")
        expect(outcome.summary).toMatch(
          /Reception Point\. (Handover|Required)/,
        );
      expect((await x.get()).locale).toBe(locale);
      snapshots.push({
        time: outcome.sealedAtMissionMs,
        success: outcome.taskSuccess,
        location: outcome.finalLocation,
        routes: outcome.routeIdsTaken,
        pending: outcome.pendingTasks,
        resources: (await x.get()).resources,
      });
      const replay = (await x.svc.read("getReplay", x.sid)) as P.ReplayView;
      expect(han(replay)).toBe(locale === "zh-CN");
      const accepted = (await x.svc.execute(
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
      )) as P.EvaluationAccepted;
      await settle();
      const input = x.evaluatorInputs[0]!;
      guardEvaluatorInput(input);
      expect(han(input)).toBe(locale === "zh-CN");
      const result = (await x.svc.read(
        "getEvaluation",
        x.sid,
        accepted.job.jobId,
      )) as P.EvaluationJobView;
      expect(han(result)).toBe(locale === "zh-CN");
      expect((result.result as any).sealedHash).toBe(outcome.sealedHash);
      expect((await x.svc.getEventsSince(x.sid)).every((e) => !han(e))).toBe(
        locale === "en-US",
      );
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
  });
  it("preserves verbatim player text even when it exactly matches a fixed translation key", async () => {
    const x = await setup("en-US");
    await x.command("startSession", { acknowledgeDesignPreview: true });
    await x.advance(30000);
    const playerText = "原地等待";
    await x.command("askAdvisor", {
      expectedInboxVersion: (await x.get()).inboxVersion,
      questionKind: "free_text",
      text: playerText,
      uploadBatch: [],
    });
    await settle();
    const input = x.advisorInputs.at(-1)!;
    expect(input.question.text).toBe(playerText);
    expect(input.statements[0]!.text).toBe(playerText);
    await x.command("askAdvisor", {
      expectedInboxVersion: (await x.get()).inboxVersion,
      questionKind: "compare_routes",
      text: playerText,
      uploadBatch: [],
    });
    await settle();
    expect(x.advisorInputs.at(-1)!.question.text).toBe(playerText);
    expect(x.advisorInputs.at(-1)!.statements.at(-1)!.text).toBe(playerText);
    await x.action("E1_MAIN", playerText, playerText);
    await x.advance(65000);
    const outcome = (await x.command("abandonSession", {
      reason: "player_exit",
    })) as P.OutcomeView;
    const replay = (await x.svc.read("getReplay", x.sid)) as P.ReplayView;
    expect(replay.decisions.at(-1)!.reason).toBe(playerText);
    expect(replay.decisions.at(-1)!.reasonAnnotation?.declaredQuestionKey).toBe(
      playerText,
    );
    const exported = (await x.svc.execute(
      "createExport",
      {
        sealedHash: outcome.sealedHash,
        format: "last-mile-review-json",
        includePlayerStatements: true,
      },
      {
        sessionId: x.sid,
        runEpoch: outcome.runEpoch,
        idempotencyKey: randomUUID(),
      },
    )) as P.ExportAccepted;
    expect(
      exported.export.artifact!.replayPages[0]!.playerStatements[0]!.text,
    ).toBe(playerText);
    expect(
      localizeTree(
        {
          reason: playerText,
          reasonText: playerText,
          declaredQuestionKey: playerText,
        },
        "en-US",
      ),
    ).toEqual({
      reason: playerText,
      reasonText: playerText,
      declaredQuestionKey: playerText,
    });
  });
  it("translates every authored public card and channel scope without shipping the dictionary to a client", () => {
    const campaign = JSON.parse(
      readFileSync(
        "docs/engineering_v0.5/content/campaign-reference.json",
        "utf8",
      ),
    );
    for (const c of campaign.cases)
      for (const d of c.evidenceDefinitions) {
        const publicFields = {
          title: d.title,
          body: d.body,
          sourceLabel: d.sourceLabel,
          observationScope: d.observationScope,
          traceResult: d.traceResult,
        };
        expect(
          han(localizePublic(publicFields, "en-US")),
          `Missing translation for ${d.definitionId}`,
        ).toBe(false);
      }
    for (const channel of [
      "satellite",
      "drone",
      "localAgency",
      "witness",
    ] as const) {
      expect(han(publicChannelScopeText(channel, "en-US"))).toBe(false);
      expect(han(publicChannelScopeText(channel, "zh-CN"))).toBe(true);
    }
  });
  it.each(["en-US", "zh-CN"] as const)(
    "%s selects trusted Advisor and Evaluator output language without altering IDs or hashes",
    async (locale) => {
      const requests: ProviderRequest[] = [];
      const provider = new MockProvider(async (request) => {
        requests.push(request);
        return {
          ok: true,
          value:
            request.role === "advisor"
              ? advisorFallback(request.input as AdvisorInput, locale)
              : evaluatorFallback(request.input as EvaluatorInput, locale),
          usage: null,
          providerRequestId: null,
        };
      });
      const ai = createAiService({ provider, env: {} });
      const a = JSON.parse(
        readFileSync("tests/ai/advisor-input.json", "utf8"),
      ) as AdvisorInput;
      a.inputHash = advisorInputHash(a);
      const e = JSON.parse(
        readFileSync("tests/ai/evaluator-input.json", "utf8"),
      ) as EvaluatorInput;
      let count = 0;
      const control = {
        locale,
        isCurrent: () => true,
        beginAttempt: () => ({ attemptNo: ++count, requestKey: randomUUID() }),
        finishAttempt: () => {},
      };
      const ar = await ai.runAdvisor(a, control);
      count = 0;
      const er = await ai.runEvaluator(e, control);
      expect(ar.status).toBe("succeeded");
      expect(er.status).toBe("succeeded");
      expect(requests).toHaveLength(2);
      expect(
        requests.every((r) =>
          r.systemPrompt.includes(`Trusted session language: ${locale}`),
        ),
      ).toBe(true);
      expect(
        requests.some((r) =>
          /Output language is Simplified Chinese|Use clear Simplified Chinese/.test(
            r.systemPrompt,
          ),
        ),
      ).toBe(false);
      expect((ar.result as any).inputHash).toBe(a.inputHash);
      expect((er.result as any).sealedHash).toBe(e.sealedHash);
      expect(canonical(requests[0]!.input)).toBe(canonical(a));
      expect(canonical(requests[1]!.input)).toBe(canonical(e));
    },
  );
  it.each(["en-US", "zh-CN"] as const)(
    "%s retains live model prose and recognizes equivalent observable evidence",
    async (locale) => {
      const x = await setup(locale, "A", true);
      await x.command("startSession", { acknowledgeDesignPreview: true });
      await x.advance(30000);
      await x.task("gate_agency");
      await x.advance(15000);
      const report = (await x.get()).reports[0]!;
      await x.receipt("report_opened", { reportId: report.reportId });
      await x.command("uploadReports", {
        items: [{ reportId: report.reportId, expectedRevision: 1 }],
      });
      await settle();
      const job = (await x.get()).latestAdviceJob!;
      expect(job.mode).toBe("live_model");
      expect(job.result).toEqual(x.generated.at(-1));
      expect(job.result!.summary).toBe("Player quote: 原地等待");
      const event = (await x.svc.getEventsSince(x.sid)).findLast(
        (e) => e.eventType === "advice.updated",
      )!;
      expect((event.data as any).result).toEqual(job.result);
      await x.receipt("advice_displayed", { jobId: job.jobId });
      await x.receipt("context_displayed");
      await x.command("commitAction", {
        actionId: "E1_BYPASS",
        waitDurationMs: null,
        reason: "",
        reasonAnnotation: {
          reasonCodes: ["prior_ai_error_only"],
          acknowledgedLimitation: false,
          comparedKnownCosts: false,
          declaredQuestionKey: null,
        },
        basedOnAdviceJobId: job.jobId,
        referencedReportIds: [],
        cancelPendingInvestigations: true,
      });
      const outcome = (await x.command("abandonSession", {
        reason: "player_exit",
      })) as P.OutcomeView;
      const accepted = (await x.svc.execute(
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
      )) as P.EvaluationAccepted;
      await settle();
      expect(
        x.evaluatorInputs[0]!.bounds.distrust.supportCandidates,
      ).toHaveLength(1);
      expect(x.evaluatorInputs[0]!.bounds.distrust.eligibleOpportunities).toBe(
        1,
      );
      const result = (await x.svc.read(
        "getEvaluation",
        x.sid,
        accepted.job.jobId,
      )) as P.EvaluationJobView;
      expect(result.result).toEqual(x.generated.at(-1));
      const exported = (await x.svc.execute(
        "createExport",
        {
          sealedHash: outcome.sealedHash,
          format: "last-mile-review-json",
          includePlayerStatements: true,
        },
        {
          sessionId: x.sid,
          runEpoch: outcome.runEpoch,
          idempotencyKey: randomUUID(),
        },
      )) as P.ExportAccepted;
      expect(exported.export.artifact!.evaluationJob!.result).toEqual(
        result.result,
      );
      expect(exported.export.artifact!.evaluationJob!.result!.summary).toBe(
        "Player quote: 原地等待",
      );
    },
  );
  it("persists the actual localized report/export bytes and hashes before delivery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "last-mile-locale-"));
    temporaryDirs.push(dir);
    const dbPath = join(dir, "game.sqlite");
    const x = await setup("en-US", "A", false, dbPath);
    await x.command("startSession", { acknowledgeDesignPreview: true });
    await x.advance(30000);
    await x.task("gate_agency");
    await x.advance(15000);
    const report = (await x.get()).reports[0]!;
    const upload = (await x.command("uploadReports", {
      items: [{ reportId: report.reportId, expectedRevision: 1 }],
    })) as P.UploadView;
    await settle();
    const outcome = (await x.command("abandonSession", {
      reason: "player_exit",
    })) as P.OutcomeView;
    const exported = (await x.svc.execute(
      "createExport",
      {
        sealedHash: outcome.sealedHash,
        format: "last-mile-review-json",
        includePlayerStatements: false,
      },
      {
        sessionId: x.sid,
        runEpoch: outcome.runEpoch,
        idempotencyKey: randomUUID(),
      },
    )) as P.ExportAccepted;
    const db = new DatabaseSync(dbPath);
    try {
      const row: any = db
        .prepare(
          "SELECT immutable_payload_json,immutable_payload_hash FROM reports WHERE report_id=?",
        )
        .get(report.reportId);
      expect(JSON.parse(row.immutable_payload_json)).toEqual(report.card);
      expect(row.immutable_payload_hash).toBe(hash(report.card));
      expect(upload.added[0]!.payloadHash).toBe(row.immutable_payload_hash);
      const artifactRow: any = db
        .prepare(
          "SELECT artifact_json FROM runtime_export_artifacts WHERE export_id=?",
        )
        .get(exported.export.exportId);
      const job: any = db
        .prepare("SELECT output_hash FROM export_jobs WHERE export_id=?")
        .get(exported.export.exportId);
      expect(JSON.parse(artifactRow.artifact_json)).toEqual(
        exported.export.artifact,
      );
      expect(job.output_hash).toBe(hash(exported.export.artifact));
      const reread = (await x.svc.read(
        "getExport",
        x.sid,
        exported.export.exportId,
      )) as P.ExportView;
      expect(canonical(reread.artifact)).toBe(artifactRow.artifact_json);
    } finally {
      db.close();
    }
  });
  it("returns session-language HTTP errors and English errors before session creation", async () => {
    const en = await setup("en-US"),
      zh = await setup("zh-CN");
    for (const x of [en, zh]) {
      const app = await createHttpApp({
        service: x.svc,
        config: {
          ...loadHttpConfig({ LAST_MILE_ROOT: process.cwd() }),
          clientDir: "/__none__",
        },
        launchToken: "localization-test-token",
      });
      try {
        const result = await app.inject({
          url: `/api/v1/sessions/${x.sid}/reports/${randomUUID()}`,
          headers: {
            host: "127.0.0.1:3111",
            authorization: "Bearer localization-test-token",
          },
        });
        expect(result.statusCode).toBe(404);
        expect(han(result.json().detail)).toBe(
          (await x.get()).locale === "zh-CN",
        );
        const unknown = await app.inject({
          url: "/api/v1/missing",
          headers: {
            host: "127.0.0.1:3111",
            authorization: "Bearer localization-test-token",
          },
        });
        expect(han(unknown.json().detail)).toBe(false);
      } finally {
        await app.close();
      }
    }
  });
});
