import { createHash } from "node:crypto";
import type {
  AdvisorInput,
  Background,
  Evidence,
  PlayerStatement,
  Question,
  EvidenceRef,
} from "./types.js";
import { assertContract, ensure } from "./schema.js";
export const evidenceKey = (ref: EvidenceRef) =>
  `${ref.instanceId}:${ref.revision}`;
export function canonicalJson(value: unknown): string {
  function sort(v: any): any {
    if (v === null || typeof v !== "object") {
      ensure(
        typeof v !== "number" || Number.isSafeInteger(v),
        "NON_INTEGER_CANONICAL_NUMBER",
      );
      return v;
    }
    if (Array.isArray(v)) return v.map(sort);
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sort(v[k])]),
    );
  }
  return JSON.stringify(sort(value));
}
export const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
export function advisorInputHash(input: AdvisorInput): string {
  const { inputHash: _, ...body } = input;
  return sha256(canonicalJson(body));
}
export interface AdvisorContextArgs {
  sessionId: string;
  sceneId: AdvisorInput["sceneId"];
  contextVersion: number;
  publicTask: AdvisorInput["publicTask"];
  backgrounds: readonly Background[];
  evidence: readonly Evidence[];
  statements: readonly PlayerStatement[];
  question: Question;
}
/** Accepts already authorized views, not a Session/World/DB connection. All
 * objects are reconstructed so an accidental extra property cannot cross over. */
export function buildAdvisorInput(a: AdvisorContextArgs): AdvisorInput {
  const evidence = a.evidence.map((e) => ({
    instanceId: e.instanceId,
    revision: e.revision,
    sceneId: e.sceneId,
    observationType: e.observationType,
    text: e.text,
    sourceLabel: e.sourceLabel,
    observationAgeMs: e.observationAgeMs,
    freshness: e.freshness,
    scope: e.scope,
    limitations: [...e.limitations],
    knownSourceEdges: e.knownSourceEdges.map((x) => ({
      fromRef: {
        instanceId: x.fromRef.instanceId,
        revision: x.fromRef.revision,
      },
      toRef: { instanceId: x.toRef.instanceId, revision: x.toRef.revision },
      relation: x.relation,
      findingRef: x.findingRef
        ? {
            instanceId: x.findingRef.instanceId,
            revision: x.findingRef.revision,
          }
        : null,
    })),
  }));
  const refs = new Set(evidence.map(evidenceKey));
  for (const e of evidence)
    e.knownSourceEdges = e.knownSourceEdges.filter(
      (x) =>
        refs.has(evidenceKey(x.fromRef)) &&
        refs.has(evidenceKey(x.toRef)) &&
        (x.findingRef === null || refs.has(evidenceKey(x.findingRef))),
    );
  const input: AdvisorInput = {
    schemaVersion: "0.5",
    sessionId: a.sessionId,
    sceneId: a.sceneId,
    contextVersion: a.contextVersion,
    inputHash: "0".repeat(64),
    publicTask: {
      objective: a.publicTask.objective,
      currentNodeId: a.publicTask.currentNodeId,
      actions: a.publicTask.actions.map((x) => ({
        actionId: x.actionId,
        label: x.label,
        description: x.description,
        knownDurationMs: x.knownDurationMs,
        durationQualifier: x.durationQualifier,
        limitations: [...x.limitations],
      })),
      channelCapabilities: a.publicTask.channelCapabilities.map((x) => ({
        channel: x.channel,
        publicTargetIds: [...x.publicTargetIds],
        canObserve: [...x.canObserve],
        cannotConfirm: [...x.cannotConfirm],
      })),
    },
    backgrounds: a.backgrounds.map((x) => ({
      backgroundId: x.backgroundId,
      revision: x.revision,
      fictional: true,
      text: x.text,
      sourceLabel: x.sourceLabel,
      period: x.period,
      scope: x.scope,
      limitations: [...x.limitations],
    })),
    evidence,
    statements: a.statements
      .slice(-12)
      .map((x) => ({
        statementId: x.statementId,
        revision: 1,
        text: x.text,
        verification: "unverified",
      })),
    question: {
      questionId: a.question.questionId,
      kind: a.question.kind,
      text: a.question.text,
      selectedEvidenceRefs: a.question.selectedEvidenceRefs.map((x) => ({
        instanceId: x.instanceId,
        revision: x.revision,
      })),
    },
    priorAnalysis: null,
  };
  input.inputHash = advisorInputHash(input);
  guardAdvisorInput(input);
  return input;
}
export function guardAdvisorInput(
  input: unknown,
  verifyHash = true,
): asserts input is AdvisorInput {
  assertContract("AdvisorInput", input);
  ensure(input.priorAnalysis === null, "PRIOR_ANALYSIS_DISABLED");
  if (verifyHash)
    ensure(input.inputHash === advisorInputHash(input), "INPUT_HASH_MISMATCH");
  const evidence = new Map(input.evidence.map((e) => [evidenceKey(e), e]));
  ensure(evidence.size === input.evidence.length, "DUPLICATE_EVIDENCE");
  ensure(
    input.evidence.every((e) => e.sceneId === input.sceneId),
    "WRONG_SCENE_EVIDENCE",
  );
  for (const e of input.evidence)
    for (const edge of e.knownSourceEdges) {
      ensure(
        evidence.has(evidenceKey(edge.fromRef)) &&
          evidence.has(evidenceKey(edge.toRef)),
        "PROVENANCE_ENDPOINT_NOT_UPLOADED",
      );
      if (edge.relation !== "possibly_related")
        ensure(edge.findingRef, "PROVENANCE_WITHOUT_FINDING");
      if (edge.findingRef) {
        const f = evidence.get(evidenceKey(edge.findingRef));
        ensure(f, "PROVENANCE_FINDING_NOT_UPLOADED");
        ensure(
          ["provenance_finding", "correction"].includes(f.observationType),
          "REFERENCE_IS_NOT_PROVENANCE_FINDING",
        );
      }
    }
  ensure(
    input.question.selectedEvidenceRefs.every((r) =>
      evidence.has(evidenceKey(r)),
    ),
    "QUESTION_REFERENCE_NOT_UPLOADED",
  );
}
