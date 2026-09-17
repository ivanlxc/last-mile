import { readFileSync } from "node:fs";
import type {
  AdvisorOutput,
  BehaviorContext,
  BehaviorFact,
  DimensionBound,
  EvaluatorInput,
  EvidenceRef,
} from "./types.js";
import { sha256, evidenceKey } from "./context.js";
import { guardEvaluatorInput } from "./guards.js";
import { ensure } from "./schema.js";

export const DIMENSIONS = [
  "complacency",
  "distrust",
  "overCaution",
  "calibratedTrust",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export interface ReasonAnnotation {
  reasonCodes: BehaviorContext["reasonCodes"];
  acknowledgedLimitation: boolean;
  comparedKnownCosts: boolean;
  declaredQuestionKey: string | null;
}
export interface DisplayedEvidence extends EvidenceRef {
  definitionId: string;
  body: string;
  freshness: "current" | "historical" | "superseded" | "unknown";
  displayedAtMissionMs: number;
}
/** The domain supplies this allowlisted snapshot, not a world state. Numbers here
 * are permitted retrospective decision facts and NEVER reach the Advisor. */
export interface FilteredDecisionSlice {
  contextId: string;
  sourceEventId: string;
  sceneId: "E1" | "E2" | "E3";
  subjectBindingId: string;
  controllerKind: "human" | "npc";
  kind: "route_decision" | "investigation_request" | "wait";
  cutoffMissionMs: number;
  chosenActionId: string;
  legalActionIds: readonly string[];
  displayedReports: readonly DisplayedEvidence[];
  advisorUploadedRefs: readonly EvidenceRef[];
  referencedEvidenceRefs?: readonly EvidenceRef[];
  displayedAdvice?: {
    jobId: string;
    displayedAtMissionMs: number;
    output: AdvisorOutput;
  } | null;
  reasonAnnotation?: ReasonAnnotation | null;
  reasonText?: string;
  visibleCostSummary?: string;
  contextDisplayedAtMs?: number | null;
  availableChecks?: readonly {
    questionKey: string;
    available: boolean;
    affordable: boolean;
  }[];
  check?: {
    channel: "satellite" | "drone" | "localAgency" | "witness";
    questionKey: string | null;
    knownAffordable: boolean;
    refresh: boolean;
    newTimeWindow: boolean;
    capabilityDisplayed?: boolean;
  } | null;
  oralKnowledgeStatus?: BehaviorContext["oralKnowledgeStatus"];
  unobservedCommunication?: boolean;
  technicalLimitations?: readonly string[];
  coverageComplete?: boolean;
}
export interface EvaluatorBuildArgs {
  sessionId: string;
  sealedHash: string;
  subjectBindingId: string;
  decisions: readonly FilteredDecisionSlice[];
  terminalKind: EvaluatorInput["coverage"]["terminalKind"];
  limitations?: readonly string[];
}
export interface BehavioralFeatures {
  contextId: string;
  sceneId: string;
  controllerKind: "human" | "npc";
  kind: FilteredDecisionSlice["kind"];
  adviceShownBefore: boolean;
  adviceHasAction: boolean;
  recommendationLegal: boolean;
  chosenMatchesAdvice: boolean;
  visibleGapPresent: boolean;
  availableRelevantCheckCount: number;
  checkKnownAffordable: boolean;
  adequateVisibleAdviceSupport: boolean;
  visibleCurrentCounterEvidence: boolean;
  costDisplayed: boolean;
  checkLowValueByPublicRule: boolean;
  checkRefreshesExpiredEvidence: boolean;
  reasonCodes: readonly string[];
  usedEvidenceInReason: boolean;
  acknowledgedLimitation: boolean;
  comparedKnownCosts: boolean;
  technicalIssue: boolean;
  coverageComplete: boolean;
  unobservedCommunication: boolean;
}
export type Classification = Record<
  Dimension,
  {
    eligible: boolean;
    support: boolean;
    counterevidence: boolean;
    excluded: boolean;
  }
>;
export function classifyContext(f: BehavioralFeatures): Classification {
  const r = Object.fromEntries(
    DIMENSIONS.map((d) => [
      d,
      {
        eligible: false,
        support: false,
        counterevidence: false,
        excluded: false,
      },
    ]),
  ) as Classification;
  if (f.controllerKind !== "human" || f.technicalIssue || !f.coverageComplete) {
    for (const d of DIMENSIONS) r[d].excluded = true;
    return r;
  }
  const reason = new Set(f.reasonCodes),
    unknown = reason.has("no_reason");
  const visible =
    f.kind === "route_decision" &&
    f.adviceShownBefore &&
    f.adviceHasAction &&
    f.recommendationLegal;
  let x = r.complacency;
  x.eligible =
    visible &&
    f.visibleGapPresent &&
    f.availableRelevantCheckCount > 0 &&
    f.checkKnownAffordable;
  x.excluded = f.unobservedCommunication || unknown;
  x.counterevidence =
    x.eligible &&
    (reason.has("accepted_uncertainty_for_time") ||
      reason.has("evidence_supported") ||
      f.usedEvidenceInReason);
  x.support =
    x.eligible &&
    !x.excluded &&
    !x.counterevidence &&
    f.chosenMatchesAdvice &&
    reason.has("ai_said_so");
  x = r.distrust;
  x.eligible = visible && f.adequateVisibleAdviceSupport;
  x.excluded = f.unobservedCommunication || unknown;
  x.counterevidence =
    x.eligible &&
    (f.visibleCurrentCounterEvidence ||
      reason.has("accepted_uncertainty_for_time") ||
      reason.has("evidence_supported"));
  x.support =
    x.eligible &&
    !x.excluded &&
    !x.counterevidence &&
    !f.chosenMatchesAdvice &&
    reason.has("prior_ai_error_only");
  x = r.overCaution;
  x.eligible =
    ["investigation_request", "wait"].includes(f.kind) &&
    f.costDisplayed &&
    f.checkKnownAffordable &&
    f.checkLowValueByPublicRule;
  x.excluded =
    f.unobservedCommunication || f.checkRefreshesExpiredEvidence || unknown;
  x.counterevidence =
    x.eligible &&
    (reason.has("new_question") || f.checkRefreshesExpiredEvidence);
  x.support =
    x.eligible &&
    !x.excluded &&
    !x.counterevidence &&
    reason.has("no_new_question");
  x = r.calibratedTrust;
  x.eligible =
    f.kind === "route_decision" &&
    f.usedEvidenceInReason &&
    f.acknowledgedLimitation &&
    f.comparedKnownCosts;
  x.excluded = unknown;
  x.counterevidence =
    x.eligible &&
    (reason.has("ai_said_so") || reason.has("prior_ai_error_only"));
  x.support =
    x.eligible &&
    !x.excluded &&
    !x.counterevidence &&
    (reason.has("evidence_supported") ||
      reason.has("accepted_uncertainty_for_time"));
  return r;
}
interface PublicRecordRule {
  definitionId: string;
  bodySha256: string;
  localizedBodySha256?: Record<string, string>;
  answeredQuestionKeys: string[];
  positiveLocalActionSupport: string[];
  negativeLocalActionSupport: string[];
  exposedGapQuestionKeys?: string[];
}
const catalog = JSON.parse(
  readFileSync(
    new URL("./assets/public-fact-catalog.json", import.meta.url),
    "utf8",
  ),
) as {
  records: PublicRecordRule[];
  actionQuestionKeys: Record<string, string[]>;
  cannotConfirm: { channel: string; questionKeys: string[] }[];
};
const ruleMap = new Map(
  catalog.records.flatMap((r) =>
    [r.bodySha256, ...Object.values(r.localizedBodySha256 ?? {})].map(
      (digest) => [`${r.definitionId}:${digest}`, r] as const,
    ),
  ),
);
function shownReports(s: FilteredDecisionSlice) {
  return s.displayedReports.filter(
    (r) => r.displayedAtMissionMs <= s.cutoffMissionMs,
  );
}
function shownAdvice(s: FilteredDecisionSlice) {
  return s.displayedAdvice &&
    s.displayedAdvice.displayedAtMissionMs <= s.cutoffMissionMs
    ? s.displayedAdvice
    : null;
}
export function featuresFor(s: FilteredDecisionSlice): BehavioralFeatures {
  const reports = shownReports(s),
    advice = shownAdvice(s),
    action = advice?.output.recommendation.actionId ?? null;
  const matches = reports.map((report) => ({
    report,
    rule: ruleMap.get(`${report.definitionId}:${sha256(report.body)}`),
  }));
  const questions = action ? (catalog.actionQuestionKeys[action] ?? []) : [];
  const answered = new Set(
    matches
      .filter((x) => x.report.freshness === "current")
      .flatMap((x) => x.rule?.answeredQuestionKeys ?? []),
  );
  const gaps = new Set(
    matches
      .flatMap((x) => x.rule?.exposedGapQuestionKeys ?? [])
      .filter((q) => questions.includes(q) && !answered.has(q)),
  );
  const checks = (s.availableChecks ?? []).filter(
    (c) => gaps.has(c.questionKey) && c.available,
  );
  const reason = s.reasonAnnotation?.reasonCodes.length
    ? s.reasonAnnotation.reasonCodes
    : ["no_reason"];
  const cost =
    s.contextDisplayedAtMs != null &&
    s.contextDisplayedAtMs <= s.cutoffMissionMs;
  const cited = new Set(
    advice?.output.claims
      .filter((c) => advice.output.recommendation.claimRefs.includes(c.claimId))
      .flatMap((c) =>
        c.citations
          .filter((r) => r.kind === "evidence")
          .map((r) => `${r.refId}:${r.revision}`),
      ) ?? [],
  );
  const positive =
    action !== null &&
    matches.some(
      (x) =>
        x.report.freshness === "current" &&
        x.rule?.positiveLocalActionSupport.includes(action) &&
        cited.has(evidenceKey(x.report)),
    );
  const negative =
    action !== null &&
    matches.some(
      (x) =>
        x.report.freshness === "current" &&
        x.rule?.negativeLocalActionSupport.includes(action),
    );
  const used =
    (s.referencedEvidenceRefs ?? []).some((ref) =>
      reports.some((r) => evidenceKey(r) === evidenceKey(ref)),
    ) &&
    reason.some(
      (x) =>
        x === "evidence_supported" || x === "accepted_uncertainty_for_time",
    );
  const check = s.check,
    question =
      check?.questionKey ?? s.reasonAnnotation?.declaredQuestionKey ?? null;
  // PV-01 is deliberately not inferred from repeated text/target. A fresh
  // real-time observation is a new window. PV-02 needs displayed capability.
  const cannotResolve = Boolean(
    cost &&
    check?.capabilityDisplayed === true &&
    question &&
    catalog.cannotConfirm.some(
      (x) => x.channel === check.channel && x.questionKeys.includes(question),
    ),
  );
  return {
    contextId: s.contextId,
    sceneId: s.sceneId,
    controllerKind: s.controllerKind,
    kind: s.kind,
    adviceShownBefore: !!advice,
    adviceHasAction: action !== null,
    recommendationLegal: !!action && s.legalActionIds.includes(action),
    chosenMatchesAdvice: action === s.chosenActionId,
    visibleGapPresent: gaps.size > 0,
    availableRelevantCheckCount: checks.length,
    checkKnownAffordable:
      cost && (check?.knownAffordable ?? checks.some((x) => x.affordable)),
    adequateVisibleAdviceSupport: positive && !negative,
    visibleCurrentCounterEvidence:
      negative || reason.includes("current_conflict"),
    costDisplayed: cost,
    checkLowValueByPublicRule: cannotResolve,
    checkRefreshesExpiredEvidence: Boolean(
      check?.refresh || check?.newTimeWindow,
    ),
    reasonCodes: reason,
    usedEvidenceInReason: used,
    acknowledgedLimitation:
      !!s.reasonAnnotation?.acknowledgedLimitation && reports.length > 0,
    comparedKnownCosts: !!s.reasonAnnotation?.comparedKnownCosts && cost,
    technicalIssue: (s.technicalLimitations?.length ?? 0) > 0,
    coverageComplete: s.coverageComplete !== false,
    unobservedCommunication: s.unobservedCommunication === true,
  };
}
function stableId(value: string): string {
  const h = sha256(value).slice(0, 32).split("");
  h[12] = "5";
  h[16] = ["8", "9", "a", "b"][parseInt(h[16]!, 16) % 4]!;
  const t = h.join("");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20)}`;
}
const ruleIds: Record<Dimension, string> = {
  complacency: "CHECK-01",
  distrust: "REJECT-01",
  overCaution: "CHECK-COST-01",
  calibratedTrust: "CALIBRATE-01",
};
const labels: Record<Dimension, string> = {
  complacency: "在有可承担检查时直接依赖建议",
  distrust: "仅因过去错误而拒绝当前有依据的建议",
  overCaution: "已知不能回答所选问题仍继续检查",
  calibratedTrust: "引用资料、承认限制并比较成本",
};
export function buildEvaluatorInput(a: EvaluatorBuildArgs): EvaluatorInput {
  const contexts: BehaviorContext[] = [],
    facts: BehaviorFact[] = [];
  const bounds = Object.fromEntries(
    DIMENSIONS.map((d) => [
      d,
      {
        eligibleOpportunities: 0,
        eligibleContextRefs: [],
        supportCandidates: [],
        counterevidenceRefs: [],
        exclusionRefs: [],
        allowedSupportLevels: [],
      },
    ]),
  ) as unknown as Record<Dimension, DimensionBound>;
  const mutable = bounds as any;
  const seenSupport = Object.fromEntries(
    DIMENSIONS.map((d) => [d, new Set<string>()]),
  ) as Record<Dimension, Set<string>>;
  const slices = a.decisions
    .filter(
      (s) =>
        s.controllerKind === "human" &&
        s.subjectBindingId === a.subjectBindingId,
    )
    .slice()
    .sort(
      (x, y) =>
        x.cutoffMissionMs - y.cutoffMissionMs ||
        x.contextId.localeCompare(y.contextId),
    );
  ensure(slices.length <= 64, "EVALUATION_CONTEXT_OVERFLOW");
  for (const s of slices) {
    const reports = shownReports(s),
      advice = shownAdvice(s),
      features = featuresFor(s),
      classification = classifyContext(features),
      factRefs: string[] = [];
    const add = (kind: BehaviorFact["kind"], ruleId: string, text: string) => {
      const id = stableId(`${a.sessionId}:${s.contextId}:${ruleId}:${kind}`);
      facts.push({
        factId: id,
        contextId: s.contextId,
        ruleId,
        kind,
        text,
        sourceEventIds: [s.sourceEventId],
        evidenceRefs: reports.map((r) => ({
          instanceId: r.instanceId,
          revision: r.revision,
        })),
        availableAtMissionMs: s.cutoffMissionMs,
        cutoffMissionMs: s.cutoffMissionMs,
      });
      factRefs.push(id);
      return id;
    };
    add(
      "observation",
      "CHOICE-RECORDED",
      `记录到行动 ${s.chosenActionId}；显示回执只证明资料呈现，不证明理解或真实动机。`,
    );
    for (const d of DIMENSIONS) {
      const c = classification[d],
        b = mutable[d];
      if (c.eligible) {
        b.eligibleContextRefs.push(s.contextId);
        b.eligibleOpportunities++;
        add(
          "opportunity",
          ruleIds[d],
          `当时的公开条件满足“${labels[d]}”的可观察机会条件。`,
        );
      }
      if (c.excluded)
        b.exclusionRefs.push(
          add(
            "exclusion",
            ruleIds[d],
            "理由、信息覆盖或技术条件不足，不作依赖动机的支持归责。",
          ),
        );
      if (c.counterevidence)
        b.counterevidenceRefs.push(
          add(
            "counterevidence",
            ruleIds[d],
            "记录中存在自报证据依据、时间取舍、新问题或资料更新等反例；自报内容本身未被推定为事实。",
          ),
        );
      if (c.support && !seenSupport[d].has(s.sceneId)) {
        seenSupport[d].add(s.sceneId);
        b.supportCandidates.push({
          contextId: s.contextId,
          factRefs: [
            add(
              "support",
              ruleIds[d],
              `本次明确操作与自报理由符合“${labels[d]}”的观察规则，不代表稳定人格。`,
            ),
          ],
        });
      }
    }
    contexts.push({
      contextId: s.contextId,
      sceneId: s.sceneId,
      subjectBindingId: a.subjectBindingId,
      controllerKind: "human",
      kind: s.kind,
      cutoffMissionMs: s.cutoffMissionMs,
      factRefs,
      playerVisibleRefs: reports.map((r) => ({
        instanceId: r.instanceId,
        revision: r.revision,
      })),
      advisorUploadedRefs: s.advisorUploadedRefs.map((r) => ({
        instanceId: r.instanceId,
        revision: r.revision,
      })),
      displayedAdviceId: advice?.jobId ?? null,
      displayedAdviceAtMs: advice?.displayedAtMissionMs ?? null,
      chosenActionId: s.chosenActionId,
      legalActionIds: [...s.legalActionIds],
      visibleCostSummary: s.visibleCostSummary ?? "",
      reasonCodes: features.reasonCodes as BehaviorContext["reasonCodes"],
      reasonText: (s.reasonText ?? "").slice(0, 800),
      oralKnowledgeStatus: s.oralKnowledgeStatus ?? "not_collected",
      technicalLimitations: [...(s.technicalLimitations ?? [])],
    });
  }
  for (const d of DIMENSIONS) {
    const b = mutable[d];
    b.exclusionRefs = b.exclusionRefs.slice(0, 32);
    b.counterevidenceRefs = b.counterevidenceRefs.slice(0, 32);
    b.allowedSupportLevels =
      b.eligibleOpportunities === 0
        ? ["not_assessable"]
        : [
            "not_observed",
            ...(b.supportCandidates.length > 0 ? ["observed_once"] : []),
            ...(b.supportCandidates.length > 1 ? ["repeated_observation"] : []),
          ];
  }
  const input: EvaluatorInput = {
    schemaVersion: "0.5",
    sessionId: a.sessionId,
    sealedHash: a.sealedHash,
    rubricVersion: "observable-rubric-0.5-review",
    subjectBindingId: a.subjectBindingId,
    contexts,
    facts,
    bounds,
    allowedOverallPatterns: [
      "mixed",
      "limited_pattern",
      "insufficient_evidence",
    ],
    coverage: {
      scenesObserved: [...new Set(contexts.map((c) => c.sceneId))],
      terminalKind: a.terminalKind,
      limitations: [
        ...(a.limitations ?? []),
        "口头交流未全面记录；自报理由不证明真实动机；这些游戏观察规则不是经验证的心理量表。",
      ],
    },
  };
  guardEvaluatorInput(input);
  return input;
}
