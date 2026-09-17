/** Explicit, bounded live smoke test. Uses synthetic fixtures, never a player DB. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildAdvisorInput,
  createAiService,
  guardAdvice,
  guardEvaluation,
  guardEvaluatorInput,
  type AttemptControl,
  type EvaluatorInput,
  AiContractError,
  type AdvisorOutput,
  type EvaluatorOutput,
} from "../server/ai/index.js";
import { HttpProvider, readProviderConfig } from "../server/ai/providers.js";
import { guardOutputLanguage } from "../server/ai/output-language.js";

const args = process.argv.slice(2);
for (const arg of args)
  if (
    !/^--(live|locale=(en-US|zh-CN)|role=(advisor|evaluator|all)|attempts=[12]|output=.+)$/.test(
      arg,
    )
  )
    throw new Error("Unsupported verify-model argument");
const option = (key: string, fallback: string) =>
  args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3) ??
  fallback;
const locale = option("locale", "en-US") as "en-US" | "zh-CN";
const role = option("role", "all");
const maxAttempts = Number(option("attempts", "1"));
const output = option("output", "");
const destination = output ? resolve(output) : null;
if (destination && !destination.startsWith(resolve(".local-artifacts") + "/"))
  throw new Error("REPORT_MUST_STAY_IN_LOCAL_ARTIFACTS");
const config = readProviderConfig(process.env);
const metadata = {
  provider: config.provider,
  model: config.model,
  keyPresent: Boolean(config.apiKey),
  locale,
  reasoningEffort: config.openaiReasoningEffort ?? "model_default",
  limits: {
    advisorTimeoutMs: Number(process.env.AI_ADVISOR_TIMEOUT_MS ?? "8000"),
    evaluatorTimeoutMs: Number(process.env.AI_EVALUATOR_TIMEOUT_MS ?? "20000"),
    advisorMaxOutputTokens: Number(
      process.env.AI_ADVISOR_MAX_OUTPUT_TOKENS ?? "1200",
    ),
    evaluatorMaxOutputTokens: Number(
      process.env.AI_EVALUATOR_MAX_OUTPUT_TOKENS ?? "3000",
    ),
  },
};
if (!args.includes("--live")) {
  console.info(
    JSON.stringify({
      ...metadata,
      liveCalls: 0,
      hint: "Use --live explicitly to make billable synthetic test requests.",
    }),
  );
} else {
  if (config.provider === "offline" || !config.apiKey || !config.model)
    throw new Error(
      "MODEL_NOT_CONFIGURED: select provider and fill key + model in .env",
    );
  const advisor = buildAdvisorInput(
    JSON.parse(readFileSync("tests/ai/advisor-input.json", "utf8")),
  );
  const evaluator = JSON.parse(
    readFileSync("tests/ai/evaluator-input.json", "utf8"),
  ) as EvaluatorInput;
  guardEvaluatorInput(evaluator);
  let calls = 0;
  const transport: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    if (++calls > (role === "all" ? 2 : 1) * maxAttempts)
      throw new Error("SMOKE_BUDGET_EXHAUSTED");
    const started = performance.now();
    try {
      const response = await fetch(url, init);
      const diagnostic: Record<string, unknown> = {
        call: calls,
        status: response.status,
        headerLatencyMs: Math.round(performance.now() - started),
      };
      if (!response.ok) {
        // Never print raw error bodies, headers, credentials or request inputs.
        const body: any = await response
          .clone()
          .json()
          .catch(() => null);
        for (const field of ["code", "type", "param"])
          if (
            typeof body?.error?.[field] === "string" &&
            /^[a-zA-Z0-9_.\[\]-]{1,120}$/.test(body.error[field])
          )
            diagnostic[field] = body.error[field];
      }
      transport.push(diagnostic);
      return response;
    } catch (error) {
      transport.push({
        call: calls,
        elapsedMs: Math.round(performance.now() - started),
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  };
  const baseProvider = new HttpProvider(config, fetchImpl);
  const validation: Array<Record<string, unknown>> = [];
  const service = createAiService({
    env: process.env,
    provider: {
      kind: baseProvider.kind,
      configured: baseProvider.configured,
      model: baseProvider.model,
      reasoningEffort: baseProvider.reasoningEffort,
      async generate(request) {
        const response = await baseProvider.generate(request);
        if (response.ok) {
          try {
            if (request.role === "advisor")
              guardAdvice(advisor, response.value);
            else guardEvaluation(evaluator, response.value);
            guardOutputLanguage(
              response.value as AdvisorOutput | EvaluatorOutput,
              locale,
            );
            validation.push({ call: calls, role: request.role, passed: true });
          } catch (error) {
            validation.push({
              call: calls,
              role: request.role,
              passed: false,
              code:
                error instanceof AiContractError
                  ? error.code
                  : "VALIDATION_ERROR",
            });
          }
        }
        return response;
      },
    },
  });
  const jobs: Array<Record<string, unknown>> = [];
  for (const currentRole of role === "all"
    ? ["advisor", "evaluator"]
    : [role]) {
    let count = 0;
    const attempts: Array<Record<string, unknown>> = [];
    const control: AttemptControl = {
      locale,
      beginAttempt() {
        if (count >= maxAttempts) throw new Error("SMOKE_JOB_BUDGET_EXHAUSTED");
        return { attemptNo: ++count, requestKey: randomUUID() };
      },
      finishAttempt(attemptNo, value) {
        attempts.push({ attemptNo, ...value });
      },
      isCurrent: () => true,
    };
    const started = performance.now();
    const completion =
      currentRole === "advisor"
        ? await service.runAdvisor(advisor, control)
        : await service.runEvaluator(evaluator, control);
    const passed =
      completion.mode === "live_model" &&
      completion.status === "succeeded" &&
      completion.result !== null;
    if (passed) {
      if (currentRole === "advisor") guardAdvice(advisor, completion.result);
      else guardEvaluation(evaluator, completion.result);
    }
    const job = {
      role: currentRole,
      passed,
      elapsedMs: Math.round(performance.now() - started),
      attempts,
      completion,
    };
    jobs.push(job);
    // Summary is safe: full synthetic model output is written only to the optional local report.
    console.info(
      JSON.stringify({
        role: currentRole,
        locale,
        passed,
        elapsedMs: job.elapsedMs,
        attempts,
        mode: completion.mode,
        error: completion.error ?? null,
      }),
    );
  }
  const report = {
    date: new Date().toISOString(),
    ...metadata,
    configHash: service.configHash,
    syntheticFixturesOnly: true,
    liveCalls: calls,
    maxAttemptsPerJob: maxAttempts,
    transport,
    validation,
    jobs,
  };
  if (destination) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  console.info(
    JSON.stringify({
      liveCalls: calls,
      transport,
      validation,
      allPassed: jobs.every((j) => j.passed),
    }),
  );
  if (jobs.some((j) => !j.passed)) process.exitCode = 1;
}
