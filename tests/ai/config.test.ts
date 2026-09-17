import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAdvisorInput,
  createAiService,
  type AttemptControl,
  type EvaluatorInput,
} from "../../server/ai/index.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8"));
const advisor = () => buildAdvisorInput(fixture("advisor-input"));
const evaluator = (): EvaluatorInput => fixture("evaluator-input");
const env = (provider: "openai" | "anthropic" = "openai") => ({
  MODEL_PROVIDER: provider,
  OPENAI_API_KEY: "mock-key-not-real",
  OPENAI_MODEL: "mock-openai-model",
  ANTHROPIC_API_KEY: "mock-key-not-real",
  ANTHROPIC_MODEL: "mock-anthropic-model",
});
function control() {
  let attempts = 0;
  const finished: unknown[] = [];
  return {
    locale: "zh-CN" as const,
    finished,
    beginAttempt() {
      if (attempts >= 2) throw Error("budget");
      return { attemptNo: ++attempts, requestKey: randomUUID() };
    },
    finishAttempt(attemptNo: number, result: unknown) {
      finished.push({ attemptNo, result });
    },
    isCurrent: () => true,
  } satisfies AttemptControl & { finished: unknown[] };
}
function successfulFetch(bodies: any[]): typeof fetch {
  return (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    const openai = "input" in body;
    const input = JSON.parse(
      openai ? body.input[0].content : body.messages[0].content,
    );
    const output = fixture(
      "sealedHash" in input ? "evaluator-output" : "advisor-output",
    );
    if ("inputHash" in input) output.inputHash = input.inputHash;
    return new Response(
      JSON.stringify(
        openai
          ? {
              id: "mock-response",
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [
                    { type: "output_text", text: JSON.stringify(output) },
                  ],
                },
              ],
            }
          : {
              id: "mock-message",
              stop_reason: "end_turn",
              content: [{ type: "text", text: JSON.stringify(output) }],
            },
      ),
    );
  }) as typeof fetch;
}
afterEach(() => vi.useRealTimers());

describe("bounded AI runtime configuration", () => {
  it("keeps default output budgets and omits optional OpenAI reasoning", async () => {
    const bodies: any[] = [];
    const service = createAiService({
      env: env(),
      fetchImpl: successfulFetch(bodies),
    });
    expect((await service.runAdvisor(advisor(), control())).status).toBe(
      "succeeded",
    );
    expect((await service.runEvaluator(evaluator(), control())).status).toBe(
      "succeeded",
    );
    expect(bodies.map((b) => b.max_output_tokens)).toEqual([1200, 3000]);
    expect(bodies.every((b) => !("reasoning" in b))).toBe(true);
  });

  for (const effort of ["none", "low", "medium", "high", "xhigh", "max"])
    it(`sends explicit OpenAI reasoning effort ${effort}`, async () => {
      const bodies: any[] = [];
      const service = createAiService({
        env: { ...env(), OPENAI_REASONING_EFFORT: effort },
        fetchImpl: successfulFetch(bodies),
      });
      expect((await service.runAdvisor(advisor(), control())).status).toBe(
        "succeeded",
      );
      expect(bodies[0].reasoning).toEqual({ effort });
    });

  for (const provider of ["openai", "anthropic"] as const)
    it(`passes distinct configured token budgets to ${provider}`, async () => {
      const bodies: any[] = [];
      const service = createAiService({
        env: {
          ...env(provider),
          OPENAI_REASONING_EFFORT: "low",
          AI_ADVISOR_MAX_OUTPUT_TOKENS: "4000",
          AI_EVALUATOR_MAX_OUTPUT_TOKENS: "8000",
        },
        fetchImpl: successfulFetch(bodies),
      });
      expect((await service.runAdvisor(advisor(), control())).status).toBe(
        "succeeded",
      );
      expect((await service.runEvaluator(evaluator(), control())).status).toBe(
        "succeeded",
      );
      expect(
        bodies.map((b) =>
          provider === "openai" ? b.max_output_tokens : b.max_tokens,
        ),
      ).toEqual([4000, 8000]);
      if (provider === "anthropic") {
        expect(
          bodies.every((b) => !("reasoning" in b) && !("thinking" in b)),
        ).toBe(true);
      } else
        expect(bodies.every((b) => b.reasoning.effort === "low")).toBe(true);
    });

  for (const [role, setting, deadline] of [
    ["advisor", "AI_ADVISOR_TIMEOUT_MS", 1500],
    ["evaluator", "AI_EVALUATOR_TIMEOUT_MS", 2500],
  ] as const)
    it(`enforces configured ${role} deadline with a single charged attempt`, async () => {
      vi.useFakeTimers();
      const fake = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_, reject) =>
            init!.signal!.addEventListener("abort", () =>
              reject(Error("aborted")),
            ),
          ),
      ) as unknown as typeof fetch;
      const c = control();
      const service = createAiService({
        env: { ...env(), [setting]: String(deadline) },
        fetchImpl: fake,
      });
      const pending =
        role === "advisor"
          ? service.runAdvisor(advisor(), c)
          : service.runEvaluator(evaluator(), c);
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(c.finished).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).error?.code).toBe("MODEL_TIMEOUT");
      expect(c.finished).toHaveLength(1);
      expect(fake).toHaveBeenCalledTimes(1);
    });

  const limitCases = [
    ["AI_ADVISOR_TIMEOUT_MS", 1000, 60000],
    ["AI_EVALUATOR_TIMEOUT_MS", 1000, 60000],
    ["AI_ADVISOR_MAX_OUTPUT_TOKENS", 256, 16000],
    ["AI_EVALUATOR_MAX_OUTPUT_TOKENS", 256, 16000],
  ] as const;
  for (const [setting, min, max] of limitCases) {
    it(`accepts inclusive bounds for ${setting}`, () => {
      for (const value of [String(min), String(max), ` ${min} `])
        expect(() =>
          createAiService({
            env: { MODEL_PROVIDER: "offline", [setting]: value },
          }),
        ).not.toThrow();
    });
    it(`fails synchronously on invalid ${setting} before any request`, () => {
      const fake = vi.fn();
      for (const value of [
        String(min - 1),
        String(max + 1),
        "",
        " ",
        "1.5",
        "1e3",
        "0x1000",
        "NaN",
        "Infinity",
        "private-config-value",
      ]) {
        expect(() =>
          createAiService({
            env: { ...env(), [setting]: value },
            fetchImpl: fake,
          }),
        ).toThrow(
          `INVALID_AI_CONFIG: ${setting} must be an integer from ${min} to ${max}`,
        );
      }
      expect(fake).not.toHaveBeenCalled();
    });
  }

  it("rejects unknown OpenAI effort without echoing the supplied value", () => {
    const fake = vi.fn();
    for (const effort of ["minimal", "LOW", "private-config-value"])
      expect(() =>
        createAiService({
          env: { ...env(), OPENAI_REASONING_EFFORT: effort },
          fetchImpl: fake,
        }),
      ).toThrow(
        "INVALID_AI_CONFIG: OPENAI_REASONING_EFFORT must be none, low, medium, high, xhigh, or max",
      );
    expect(fake).not.toHaveBeenCalled();
  });

  it("keys the cache on all effective limits and OpenAI reasoning, excluding credentials", () => {
    const base = createAiService({ env: env() }).configHash;
    for (const [key, value] of [
      ["AI_ADVISOR_TIMEOUT_MS", "9000"],
      ["AI_EVALUATOR_TIMEOUT_MS", "21000"],
      ["AI_ADVISOR_MAX_OUTPUT_TOKENS", "1300"],
      ["AI_EVALUATOR_MAX_OUTPUT_TOKENS", "3100"],
      ["OPENAI_REASONING_EFFORT", "medium"],
    ])
      expect(
        createAiService({ env: { ...env(), [key!]: value } }).configHash,
      ).not.toBe(base);
    expect(
      createAiService({
        env: {
          ...env(),
          AI_ADVISOR_TIMEOUT_MS: "8000",
          AI_EVALUATOR_TIMEOUT_MS: "20000",
          AI_ADVISOR_MAX_OUTPUT_TOKENS: "1200",
          AI_EVALUATOR_MAX_OUTPUT_TOKENS: "3000",
          OPENAI_REASONING_EFFORT: " ",
          OPENAI_API_KEY: "another-mock-key",
        },
      }).configHash,
    ).toBe(base);
    expect(
      createAiService({ env: { ...env(), OPENAI_REASONING_EFFORT: " low " } })
        .configHash,
    ).toBe(
      createAiService({ env: { ...env(), OPENAI_REASONING_EFFORT: "low" } })
        .configHash,
    );
  });

  it("ignores OpenAI effort for Anthropic and offline without changing cache identity", () => {
    for (const provider of ["anthropic", "offline"] as const) {
      const values = { ...env(), MODEL_PROVIDER: provider };
      const base = createAiService({ env: values }).configHash;
      for (const effort of ["high", "unrecognized-other-provider-setting"])
        expect(
          createAiService({
            env: { ...values, OPENAI_REASONING_EFFORT: effort },
          }).configHash,
        ).toBe(base);
    }
  });
});
