import { localizeTree, type Locale } from "../localization.js";
import type {
  AdvisorInput,
  AdvisorOutput,
  EvaluatorInput,
  EvaluatorOutput,
  DimensionResult,
} from "./types.js";
import { DIMENSIONS } from "./facts.js";
import { guardAdvice, guardEvaluation } from "./guards.js";
export function advisorFallback(
  input: AdvisorInput,
  locale: Locale = "en-US",
): AdvisorOutput {
  const result: AdvisorOutput = {
    sessionId: input.sessionId,
    inputHash: input.inputHash,
    summary: "当前使用离线资料检查模板。请直接核对已上传卡片的观察范围和限制。",
    claims: [],
    recommendation: {
      actionId: null,
      rationale: "模板不生成路线建议；请结合你实际掌握的资料与成本作出选择。",
      claimRefs: [],
      conditions: [],
    },
    uncertainties: [
      "模板没有推断当前世界状态，未获知指挥官私有时间、伤情和资源。",
    ],
    investigationSuggestions: [],
    changeSummary: "离线模板，不是模型分析。",
  };
  guardAdvice(input, result);
  return localizeTree(result, locale);
}
export function evaluatorFallback(
  input: EvaluatorInput,
  locale: Locale = "en-US",
): EvaluatorOutput {
  const dimensions = {} as EvaluatorOutput["dimensions"];
  const contexts = new Map(input.contexts.map((c) => [c.contextId, c]));
  let supported = 0;
  const moments: EvaluatorOutput["keyMoments"][number][] = [];
  for (const d of DIMENSIONS) {
    const b = input.bounds[d],
      seen = new Set<string>();
    const picked = b.supportCandidates.filter((c) => {
      const scene = contexts.get(c.contextId)!.sceneId;
      if (seen.has(scene)) return false;
      seen.add(scene);
      return true;
    });
    const level: DimensionResult["supportLevel"] =
      b.eligibleOpportunities === 0
        ? "not_assessable"
        : picked.length === 0
          ? "not_observed"
          : picked.length === 1
            ? "observed_once"
            : "repeated_observation";
    const chosen = b.allowedSupportLevels.includes(level) ? picked : [];
    const safeLevel = chosen.length
      ? level
      : b.eligibleOpportunities === 0
        ? "not_assessable"
        : "not_observed";
    if (chosen.length) supported++;
    dimensions[d] = {
      supportLevel: safeLevel,
      eligibleOpportunities: b.eligibleOpportunities,
      supportContextRefs: chosen.map((c) => c.contextId),
      supportFactRefs: [...new Set(chosen.flatMap((c) => c.factRefs))],
      counterevidenceRefs: [...b.counterevidenceRefs],
      explanation: chosen.length
        ? "规则在当时记录中找到可引用的行为观察。"
        : "当前记录不足以支持本维度的行为观察。",
      uncertainties: ["离线规则摘要；自报与操作不证明真实动机，不是心理诊断。"],
    };
    if (chosen[0])
      moments.push({
        contextId: chosen[0].contextId,
        factRefs: [...chosen[0].factRefs],
        explanation: "可查看这些当时记录；不使用后来公开的信息或最终结局。",
      });
  }
  const result: EvaluatorOutput = {
    sessionId: input.sessionId,
    sealedHash: input.sealedHash,
    rubricVersion: input.rubricVersion,
    summary: "这是确定性规则生成的本局观察摘要，供复盘使用。",
    overallPattern:
      supported === 0
        ? "insufficient_evidence"
        : supported === 1
          ? "limited_pattern"
          : "mixed",
    dimensions,
    keyMoments: moments,
    nextAttempts: [],
    limitations: [
      "离线模板，不是独立模型评价。",
      "本游戏行为规则未经心理测量验证，不代表稳定人格或真实行动能力。",
    ],
  };
  guardEvaluation(input, result);
  return localizeTree(result, locale);
}
