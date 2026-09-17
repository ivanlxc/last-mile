import { asLocale, languageInstruction } from "../localization.js";
import { readFileSync } from "node:fs";
import type {
  AdvisorInput,
  AdvisorOutput,
  EvaluatorInput,
  EvaluatorOutput,
  AgentJobView,
} from "./types.js";
import { assertContract } from "./schema.js";
import { guardAdvisorInput, canonicalJson, sha256 } from "./context.js";
import { guardAdvice, guardEvaluation, guardEvaluatorInput } from "./guards.js";
import { advisorFallback, evaluatorFallback } from "./fallback.js";
import { guardOutputLanguage } from "./output-language.js";
import {
  HttpProvider,
  OfflineProvider,
  readProviderConfig,
  type StructuredProvider,
  type ProviderResult,
  type ProviderRequest,
} from "./providers.js";
export * from "./context.js";
export * from "./facts.js";
export * from "./public-checks.js";
export * from "./fallback.js";
export * from "./guards.js";
export * from "./types.js";
export {
  AiContractError,
  assertContract,
  providerOutputSchema,
} from "./schema.js";
export { HttpProvider, MockProvider, OfflineProvider } from "./providers.js";
export type {
  ProviderRequest,
  ProviderResult,
  StructuredProvider,
} from "./providers.js";
export interface AttemptControl {
  readonly locale?: "en-US" | "zh-CN";
  beginAttempt(): { attemptNo: number; requestKey: string };
  finishAttempt(
    attemptNo: number,
    result: {
      status: "succeeded" | "failed" | "timeout" | "unknown";
      errorCode?: string;
      inputTokens?: number;
      outputTokens?: number;
      providerRequestId?: string;
      responseHash?: string;
    },
  ): void;
  isCurrent(): boolean;
}
export interface AgentCompletion {
  mode: "live_model" | "offline_template";
  status: "succeeded" | "fallback" | "failed";
  result: AdvisorOutput | EvaluatorOutput | null;
  error?: NonNullable<AgentJobView["error"]>;
}
export interface AiServiceOptions {
  repoRoot?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Tests only; never selected by an environment variable. */ provider?: StructuredProvider;
}
const prompts = {
  advisor: readFileSync(
    new URL("./assets/advisor.system.md", import.meta.url),
    "utf8",
  ),
  evaluator: readFileSync(
    new URL("./assets/evaluator.system.md", import.meta.url),
    "utf8",
  ),
};
const schemaBytes = readFileSync(
  new URL("./assets/contracts.schema.json", import.meta.url),
  "utf8",
);
const repairInstruction =
  "\nApplication validation rejected the previous attempt. Return only the required JSON object using exact supplied IDs and versions. Use the trusted session language for your own explanations, regardless of the input language. Do not add information absent from this same input. Follow all output constraints. This is the only repair attempt.";
function runtimeInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (
    !/^\d+$/.test(raw.trim()) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    // Do not echo supplied environment values into logs or errors.
    throw new Error(
      `INVALID_AI_CONFIG: ${name} must be an integer from ${min} to ${max}`,
    );
  return value;
}
export function createAiService(options: AiServiceOptions = {}) {
  const env = options.env ?? process.env;
  const config = readProviderConfig(env);
  const limits = {
    advisorTimeoutMs: runtimeInteger(
      env,
      "AI_ADVISOR_TIMEOUT_MS",
      8000,
      1000,
      60000,
    ),
    evaluatorTimeoutMs: runtimeInteger(
      env,
      "AI_EVALUATOR_TIMEOUT_MS",
      20000,
      1000,
      60000,
    ),
    advisorMaxOutputTokens: runtimeInteger(
      env,
      "AI_ADVISOR_MAX_OUTPUT_TOKENS",
      1200,
      256,
      16000,
    ),
    evaluatorMaxOutputTokens: runtimeInteger(
      env,
      "AI_EVALUATOR_MAX_OUTPUT_TOKENS",
      3000,
      256,
      16000,
    ),
  };
  const provider =
    options.provider ??
    (config.provider === "offline"
      ? new OfflineProvider()
      : new HttpProvider(config, options.fetchImpl));
  // Excludes credentials and mutable private mission state.
  const configHash = sha256(
    canonicalJson({
      provider: provider.kind,
      model: provider.model,
      promptHash: sha256(prompts.advisor + prompts.evaluator),
      schemaHash: sha256(schemaBytes),
      localizationVersion: "session-locale-v2-language-guard",
      factCatalogHash: sha256(
        readFileSync(
          new URL("./assets/public-fact-catalog.json", import.meta.url),
          "utf8",
        ),
      ),
      rubricVersion: "observable-rubric-0.5-review",
      openaiReasoningEffort:
        provider.kind === "openai" ? (provider.reasoningEffort ?? null) : null,
      ...limits,
    }),
  );
  let healthStatus: "offline" | "configured" | "ready" | "degraded" =
    provider.configured ? "configured" : "offline";
  let reasonCode: string | null = provider.configured
    ? null
    : "MODEL_NOT_CONFIGURED";
  async function run(
    role: "advisor" | "evaluator",
    input: AdvisorInput | EvaluatorInput,
    control: AttemptControl,
  ): Promise<AgentCompletion> {
    const fallback = () =>
      role === "advisor"
        ? advisorFallback(input as AdvisorInput, asLocale(control.locale))
        : evaluatorFallback(input as EvaluatorInput, asLocale(control.locale));
    const degrade = (
      code: NonNullable<AgentJobView["error"]>["code"],
      retryable: boolean,
    ): AgentCompletion => ({
      status: "fallback",
      mode: "offline_template",
      result: fallback(),
      error: { code, retryable },
    });
    const stale = (): AgentCompletion => ({
      status: "failed",
      mode: "offline_template",
      result: null,
      error: { code: "CONTEXT_SUPERSEDED", retryable: false },
    });
    try {
      if (role === "advisor") guardAdvisorInput(input);
      else guardEvaluatorInput(input);
    } catch {
      return {
        status: "failed",
        mode: "offline_template",
        result: null,
        error: { code: "AGENT_INPUT_INVALID", retryable: false },
      };
    }
    if (!control.isCurrent()) return stale();
    if (
      Buffer.byteLength(JSON.stringify(input), "utf8") >
      (role === "advisor" ? 65536 : 393216)
    )
      return degrade("AGENT_INPUT_TOO_LARGE", false);
    if (!provider.configured) return degrade("MODEL_NOT_CONFIGURED", false);
    for (let localAttempt = 0; localAttempt < 2; localAttempt++) {
      if (!control.isCurrent()) return stale();
      let ticket: { attemptNo: number; requestKey: string };
      try {
        ticket = control.beginAttempt();
      } catch {
        return degrade("MODEL_BUDGET_EXHAUSTED", false);
      }
      // Domain's durable ledger enforces lifetime max2 and session30. We do not
      // reset that budget if this function is called again for an explicit retry.
      let response: ProviderResult;
      try {
        response = await provider.generate({
          role,
          input,
          systemPrompt:
            prompts[role] +
            languageInstruction(asLocale(control.locale)) +
            (localAttempt ? repairInstruction : ""),
          requestKey: ticket.requestKey,
          timeoutMs:
            role === "advisor"
              ? limits.advisorTimeoutMs
              : limits.evaluatorTimeoutMs,
          maxOutputTokens:
            role === "advisor"
              ? limits.advisorMaxOutputTokens
              : limits.evaluatorMaxOutputTokens,
        });
      } catch {
        response = {
          ok: false,
          code: "MODEL_TRANSPORT",
          retryable: true,
          repairable: false,
          usage: null,
          providerRequestId: null,
          reason: "transport",
        };
      }
      let valid = false;
      if (response.ok) {
        try {
          if (role === "advisor")
            guardAdvice(input as AdvisorInput, response.value);
          else guardEvaluation(input as EvaluatorInput, response.value);
          guardOutputLanguage(
            response.value as AdvisorOutput | EvaluatorOutput,
            asLocale(control.locale),
          );
          valid = true;
        } catch {
          /* Content is discarded, not fed into a repair system prompt. */
        }
      }
      const attemptStatus = valid
        ? "succeeded"
        : !response.ok && response.code === "MODEL_TIMEOUT"
          ? "timeout"
          : "failed";
      control.finishAttempt(ticket.attemptNo, {
        status: attemptStatus,
        ...(response.usage
          ? {
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
            }
          : {}),
        ...(response.providerRequestId
          ? { providerRequestId: response.providerRequestId }
          : {}),
        ...(!valid
          ? { errorCode: response.ok ? "MODEL_INVALID_OUTPUT" : response.code }
          : {}),
        ...(valid && response.ok
          ? { responseHash: sha256(canonicalJson(response.value)) }
          : {}),
      });
      if (!control.isCurrent()) return stale();
      if (valid && response.ok) {
        healthStatus = "ready";
        reasonCode = null;
        return {
          status: "succeeded",
          mode: "live_model",
          result: response.value as AdvisorOutput | EvaluatorOutput,
        };
      }
      healthStatus = "degraded";
      reasonCode = response.ok ? "MODEL_INVALID_OUTPUT" : response.code;
      const repairable = response.ok || response.repairable;
      if (repairable && localAttempt === 0 && ticket.attemptNo < 2) continue;
      return degrade(
        response.ok ? "MODEL_INVALID_OUTPUT" : response.code,
        ticket.attemptNo < 2 && (!response.ok ? response.retryable : true),
      );
    }
    return degrade("MODEL_INVALID_OUTPUT", false);
  }
  return {
    configured: provider.configured,
    configHash,
    // Internal whole-job budget: two provider attempts plus scheduling margin.
    jobTimeoutMs: Object.freeze({
      advisor: 2 * limits.advisorTimeoutMs + 2000,
      evaluator: 2 * limits.evaluatorTimeoutMs + 2000,
    }),
    health: () => ({
      provider: provider.kind,
      mode: provider.configured
        ? ("live_model" as const)
        : ("offline_template" as const),
      configured: provider.configured,
      status: healthStatus,
      reasonCode,
    }),
    runAdvisor: (input: AdvisorInput, control: AttemptControl) =>
      run("advisor", input, control),
    runEvaluator: (input: EvaluatorInput, control: AttemptControl) =>
      run("evaluator", input, control),
  };
}
