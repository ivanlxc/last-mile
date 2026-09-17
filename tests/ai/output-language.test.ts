import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { guardOutputLanguage } from "../../server/ai/output-language.js";
import type { AdvisorOutput, EvaluatorOutput } from "../../server/ai/types.js";
import {
  createAiService,
  buildAdvisorInput,
  MockProvider,
  advisorFallback,
  evaluatorFallback,
  guardAdvice,
  guardEvaluation,
  type EvaluatorInput,
  type AttemptControl,
} from "../../server/ai/index.js";
const advisor = (): AdvisorOutput =>
  JSON.parse(
    readFileSync(new URL("./advisor-output.json", import.meta.url), "utf8"),
  );
describe("obvious output-language mismatches", () => {
  it("rejects predominantly Chinese explanations in an English session", () => {
    const value = advisor();
    value.summary =
      "当前的历史图像无法证明检查站的登记系统正在工作，需要进一步核验。";
    value.recommendation.rationale = "当前的信息不足以支持选择某一条路线。";
    expect(() => guardOutputLanguage(value, "en-US")).toThrow(
      "OUTPUT_LANGUAGE_MISMATCH",
    );
  });
  it("preserves Chinese source claims, names and quoted player text in English prose", () => {
    const value = advisor();
    value.summary =
      "The player said “当前的历史图像无法证明检查站的登记系统正在工作，需要进一步核验。” This remains unverified.";
    value.recommendation.rationale =
      "Ask 萨米拉 for current information before acting.";
    const before = JSON.stringify(value);
    expect(() => guardOutputLanguage(value, "en-US")).not.toThrow();
    expect(JSON.stringify(value)).toBe(before);
  });
  it("rejects English-only explanations in a Chinese session", () => {
    const value = advisor();
    value.summary =
      "The uploaded material does not establish the current registration status.";
    value.recommendation.rationale =
      "Obtain current evidence before comparing the routes.";
    expect(() => guardOutputLanguage(value, "zh-CN")).toThrow(
      "OUTPUT_LANGUAGE_MISMATCH",
    );
  });
  it("allows Chinese explanations with unchanged English IDs", () => {
    const value = advisor();
    value.summary = "E1_MAIN 的登记系统状态仍然未知。";
    value.recommendation.rationale = "暂不判断 E1_BYPASS 的总耗时。";
    expect(() => guardOutputLanguage(value, "zh-CN")).not.toThrow();
  });
  it("also checks evaluator explanations and leaves reference IDs untouched", () => {
    const value = JSON.parse(
      readFileSync(new URL("./evaluator-output.json", import.meta.url), "utf8"),
    ) as EvaluatorOutput;
    value.summary =
      "只能依据当时可见的证据描述本局行为，不能判断玩家的固定人格。";
    expect(() => guardOutputLanguage(value, "en-US")).toThrow(
      "OUTPUT_LANGUAGE_MISMATCH",
    );
  });
});

describe("language guard through the full AiService pipeline", () => {
  for (const role of ["advisor", "evaluator"] as const)
    for (const repairSucceeds of [true, false])
      it(`${role}: ${repairSucceeds ? "repairs an incorrect language once" : "falls back explicitly after two incorrect-language outputs"}`, async () => {
        const inputAdvisor = buildAdvisorInput(
          JSON.parse(
            readFileSync(
              new URL("./advisor-input.json", import.meta.url),
              "utf8",
            ),
          ),
        );
        const inputEvaluator = JSON.parse(
          readFileSync(
            new URL("./evaluator-input.json", import.meta.url),
            "utf8",
          ),
        ) as EvaluatorInput;
        const resultFor = (locale: "en-US" | "zh-CN") =>
          role === "advisor"
            ? advisorFallback(inputAdvisor, locale)
            : evaluatorFallback(inputEvaluator, locale);
        const incorrect = resultFor("zh-CN");
        const correct = resultFor("en-US");
        // Isolate the reason for repair: both outputs pass all existing contract
        // and reference guards before the language-specific check runs.
        if (role === "advisor") {
          guardAdvice(inputAdvisor, incorrect);
          guardAdvice(inputAdvisor, correct);
        } else {
          guardEvaluation(inputEvaluator, incorrect);
          guardEvaluation(inputEvaluator, correct);
        }
        let calls = 0,
          attempts = 0;
        const prompts: string[] = [];
        const finished: Parameters<AttemptControl["finishAttempt"]>[1][] = [];
        const service = createAiService({
          env: {},
          provider: new MockProvider((request) => {
            calls++;
            prompts.push(request.systemPrompt);
            return {
              ok: true,
              value: calls === 2 && repairSucceeds ? correct : incorrect,
              usage: null,
              providerRequestId: `mock-language-${calls}`,
            };
          }),
        });
        const control: AttemptControl = {
          locale: "en-US",
          beginAttempt() {
            if (attempts >= 2) throw Error("budget");
            return { attemptNo: ++attempts, requestKey: randomUUID() };
          },
          finishAttempt(_attemptNo, result) {
            finished.push(result);
          },
          isCurrent: () => true,
        };
        const completion =
          role === "advisor"
            ? await service.runAdvisor(inputAdvisor, control)
            : await service.runEvaluator(inputEvaluator, control);
        expect(calls).toBe(2);
        expect(attempts).toBe(2);
        expect(finished[0]).toMatchObject({
          status: "failed",
          errorCode: "MODEL_INVALID_OUTPUT",
        });
        expect(prompts[0]).not.toContain(
          "Application validation rejected the previous attempt",
        );
        expect(prompts[1]).toContain(
          "Application validation rejected the previous attempt",
        );
        expect(
          prompts.every((prompt) =>
            prompt.includes("Trusted session language: en-US"),
          ),
        ).toBe(true);
        expect(completion.result).toEqual(correct);
        expect(() =>
          guardOutputLanguage(completion.result!, "en-US"),
        ).not.toThrow();
        if (repairSucceeds) {
          expect(completion).toMatchObject({
            status: "succeeded",
            mode: "live_model",
          });
          expect(finished[1]!.status).toBe("succeeded");
          expect(service.health().status).toBe("ready");
        } else {
          expect(completion).toMatchObject({
            status: "fallback",
            mode: "offline_template",
            error: { code: "MODEL_INVALID_OUTPUT", retryable: false },
          });
          expect(finished[1]).toMatchObject({
            status: "failed",
            errorCode: "MODEL_INVALID_OUTPUT",
          });
          expect(service.health().status).toBe("degraded");
        }
      });
});
