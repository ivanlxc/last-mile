import type {
  AdvisorInput,
  AdvisorOutput,
  EvaluatorInput,
  EvaluatorOutput,
} from "./types.js";
import { assertContract, ensure } from "./schema.js";
import { evidenceKey } from "./context.js";
const subset = <T>(xs: readonly T[], ys: Iterable<T>) => {
  const allowed = new Set(ys);
  return xs.every((x) => allowed.has(x));
};
export function guardAdvice(
  input: AdvisorInput,
  output: unknown,
): asserts output is AdvisorOutput {
  assertContract("AdvisorOutput", output);
  ensure(
    output.sessionId === input.sessionId &&
      output.inputHash === input.inputHash,
    "ADVICE_INPUT_MISMATCH",
  );
  const allowed = new Set([
    ...input.evidence.map((e) => `evidence:${e.instanceId}:${e.revision}`),
    ...input.backgrounds.map(
      (b) => `background:${b.backgroundId}:${b.revision}`,
    ),
    ...input.statements.map((s) => `statement:${s.statementId}:${s.revision}`),
  ]);
  const claims = new Set(output.claims.map((c) => c.claimId));
  ensure(claims.size === output.claims.length, "DUPLICATE_CLAIM_ID");
  for (const c of output.claims)
    for (const r of c.citations)
      ensure(
        allowed.has(`${r.kind}:${r.refId}:${r.revision}`),
        "CITATION_NOT_IN_MANIFEST",
      );
  ensure(
    output.recommendation.actionId === null ||
      input.publicTask.actions.some(
        (a) => a.actionId === output.recommendation.actionId,
      ),
    "ACTION_NOT_PUBLIC",
  );
  ensure(subset(output.recommendation.claimRefs, claims), "UNKNOWN_CLAIM_REF");
  for (const s of output.investigationSuggestions) {
    ensure(
      input.publicTask.channelCapabilities.some(
        (c) =>
          c.channel === s.channel &&
          c.publicTargetIds.includes(s.publicTargetId),
      ),
      "UNKNOWN_INVESTIGATION_TARGET",
    );
    ensure(subset(s.claimRefs, claims), "UNKNOWN_CLAIM_REF");
  }
}
export function guardEvaluatorInput(
  input: unknown,
): asserts input is EvaluatorInput {
  assertContract("EvaluatorInput", input);
  const contexts = new Map(input.contexts.map((c) => [c.contextId, c]));
  const facts = new Map(input.facts.map((f) => [f.factId, f]));
  ensure(
    contexts.size === input.contexts.length &&
      facts.size === input.facts.length,
    "DUPLICATE_CONTEXT_OR_FACT",
  );
  for (const c of input.contexts) {
    ensure(
      c.subjectBindingId === input.subjectBindingId,
      "WRONG_EVALUATION_SUBJECT",
    );
    ensure(
      c.legalActionIds.includes(c.chosenActionId),
      "CHOSEN_ACTION_NOT_LEGAL",
    );
    ensure(
      (c.displayedAdviceId === null) === (c.displayedAdviceAtMs === null),
      "ADVICE_RECEIPT_INCOMPLETE",
    );
    ensure(
      c.displayedAdviceAtMs === null ||
        c.displayedAdviceAtMs <= c.cutoffMissionMs,
      "FUTURE_ADVICE",
    );
  }
  for (const f of input.facts) {
    const c = contexts.get(f.contextId);
    ensure(c, "UNKNOWN_FACT_CONTEXT");
    ensure(c.factRefs.includes(f.factId), "FACT_NOT_IN_CONTEXT");
    ensure(
      f.availableAtMissionMs <= c.cutoffMissionMs &&
        f.cutoffMissionMs === c.cutoffMissionMs,
      "FUTURE_FACT",
    );
    ensure(
      subset(
        f.evidenceRefs.map(evidenceKey),
        c.playerVisibleRefs.map(evidenceKey),
      ),
      "FACT_EVIDENCE_NOT_VISIBLE",
    );
  }
  const expectedRules = {
    complacency: "CHECK-01",
    distrust: "REJECT-01",
    overCaution: "CHECK-COST-01",
    calibratedTrust: "CALIBRATE-01",
  } as const;
  for (const [dimension, b] of Object.entries(input.bounds)) {
    ensure(
      b.eligibleOpportunities === b.eligibleContextRefs.length,
      "BOUND_OPPORTUNITY_COUNT_MISMATCH",
    );
    ensure(
      subset(b.eligibleContextRefs, contexts.keys()),
      "UNKNOWN_ELIGIBLE_CONTEXT",
    );
    const candidates = new Set<string>();
    for (const s of b.supportCandidates) {
      ensure(!candidates.has(s.contextId), "DUPLICATE_SUPPORT_CANDIDATE");
      candidates.add(s.contextId);
      ensure(
        b.eligibleContextRefs.includes(s.contextId),
        "INELIGIBLE_SUPPORT_CANDIDATE",
      );
      for (const id of s.factRefs) {
        const f = facts.get(id);
        ensure(f?.contextId === s.contextId, "FACT_CONTEXT_MISMATCH");
        ensure(
          f.kind === "support" &&
            f.ruleId === expectedRules[dimension as keyof typeof expectedRules],
          "BOUND_FACT_RULE_MISMATCH",
        );
      }
    }
    ensure(
      subset([...b.counterevidenceRefs, ...b.exclusionRefs], facts.keys()),
      "UNKNOWN_BOUND_FACT",
    );
    for (const id of b.counterevidenceRefs)
      ensure(
        facts.get(id)?.kind === "counterevidence" &&
          facts.get(id)?.ruleId ===
            expectedRules[dimension as keyof typeof expectedRules],
        "BOUND_FACT_RULE_MISMATCH",
      );
    for (const id of b.exclusionRefs)
      ensure(
        facts.get(id)?.kind === "exclusion" &&
          facts.get(id)?.ruleId ===
            expectedRules[dimension as keyof typeof expectedRules],
        "BOUND_FACT_RULE_MISMATCH",
      );
  }
}
export function guardEvaluation(
  input: EvaluatorInput,
  output: unknown,
): asserts output is EvaluatorOutput {
  guardEvaluatorInput(input);
  assertContract("EvaluatorOutput", output);
  ensure(
    output.sessionId === input.sessionId &&
      output.sealedHash === input.sealedHash &&
      output.rubricVersion === input.rubricVersion,
    "EVALUATION_INPUT_MISMATCH",
  );
  const contexts = new Map(input.contexts.map((c) => [c.contextId, c]));
  const facts = new Map(input.facts.map((f) => [f.factId, f]));
  let supported = 0;
  for (const key of Object.keys(
    output.dimensions,
  ) as (keyof EvaluatorOutput["dimensions"])[]) {
    const r = output.dimensions[key],
      b = input.bounds[key];
    ensure(
      r.eligibleOpportunities === b.eligibleOpportunities,
      "OPPORTUNITY_COUNT_MISMATCH",
    );
    ensure(
      b.allowedSupportLevels.includes(r.supportLevel),
      "SUPPORT_ABOVE_BOUND",
    );
    const candidates = new Map(
      b.supportCandidates.map((c) => [c.contextId, c.factRefs]),
    );
    ensure(
      subset(r.supportContextRefs, candidates.keys()),
      "SUPPORT_CONTEXT_NOT_CANDIDATE",
    );
    ensure(
      r.supportContextRefs.length <= r.eligibleOpportunities,
      "MORE_SUPPORT_THAN_OPPORTUNITIES",
    );
    const allowed = r.supportContextRefs.flatMap((cid) => [
      ...(candidates.get(cid) ?? []),
    ]);
    ensure(subset(r.supportFactRefs, allowed), "UNBOUND_SUPPORT_FACT");
    for (const cid of r.supportContextRefs)
      ensure(
        r.supportFactRefs.some(
          (fid) =>
            candidates.get(cid)?.includes(fid) &&
            facts.get(fid)?.contextId === cid,
        ),
        "CONTEXT_WITHOUT_SUPPORT_FACT",
      );
    const scenes = r.supportContextRefs.map(
      (cid) => contexts.get(cid)?.sceneId,
    );
    ensure(new Set(scenes).size === scenes.length, "REPEATED_SAME_SCENE");
    const n = r.supportContextRefs.length;
    const level =
      r.eligibleOpportunities === 0
        ? "not_assessable"
        : n === 0
          ? "not_observed"
          : n === 1
            ? "observed_once"
            : "repeated_observation";
    ensure(level === r.supportLevel, "SUPPORT_LEVEL_COUNT_MISMATCH");
    ensure(
      subset(r.counterevidenceRefs, b.counterevidenceRefs),
      "COUNTEREVIDENCE_NOT_ALLOWED",
    );
    if (n > 0) supported++;
  }
  const pattern =
    supported === 0
      ? "insufficient_evidence"
      : supported === 1
        ? "limited_pattern"
        : "mixed";
  ensure(
    output.overallPattern === pattern &&
      input.allowedOverallPatterns.includes(pattern),
    "OVERALL_PATTERN_MISMATCH",
  );
  for (const moment of output.keyMoments) {
    ensure(contexts.has(moment.contextId), "UNKNOWN_CONTEXT");
    for (const fid of moment.factRefs)
      ensure(
        facts.get(fid)?.contextId === moment.contextId,
        "FACT_CONTEXT_MISMATCH",
      );
  }
  for (const next of output.nextAttempts)
    ensure(subset(next.basisRefs, facts.keys()), "UNKNOWN_FACT_REF");
}
