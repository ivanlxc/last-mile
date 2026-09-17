import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advisorFallback,
  buildAdvisorInput,
  createAiService,
  MockProvider,
  type AttemptControl,
} from "../../server/ai/index.js";
import { configuredAgents } from "../../server/runtime.js";

const input = () =>
  buildAdvisorInput(
    JSON.parse(
      readFileSync(new URL("./advisor-input.json", import.meta.url), "utf8"),
    ),
  );
const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("durable async model accounting", () => {
  it("waits for the database reservation before sending and the completion receipt before publishing", async () => {
    const events: string[] = [];
    const payload = input();
    const service = createAiService({
      env: {},
      provider: new MockProvider(() => {
        events.push("send");
        return {
          ok: true,
          value: advisorFallback(payload, "en-US"),
          usage: null,
          providerRequestId: null,
        };
      }),
    });
    const control: AttemptControl = {
      locale: "en-US",
      async isCurrent() {
        await pause();
        return true;
      },
      async beginAttempt() {
        await pause();
        events.push("reserve-committed");
        return { attemptNo: 1, requestKey: "test-request" };
      },
      async finishAttempt() {
        await pause();
        events.push("receipt-committed");
      },
    };
    const result = await service.runAdvisor(payload, control);
    events.push("published");
    expect(result.status).toBe("succeeded");
    expect(events).toEqual([
      "reserve-committed",
      "send",
      "receipt-committed",
      "published",
    ]);
  });

  it("sends nothing when an asynchronous daily-budget reservation is rejected", async () => {
    let sends = 0;
    const service = createAiService({
      env: {},
      provider: new MockProvider(() => {
        sends++;
        throw Error("must not send");
      }),
    });
    const result = await service.runAdvisor(input(), {
      locale: "en-US",
      isCurrent: async () => true,
      beginAttempt: async () => {
        throw Error("daily budget");
      },
      finishAttempt: async () => {
        throw Error("nothing was sent");
      },
    });
    expect(sends).toBe(0);
    expect(result.error?.code).toBe("MODEL_BUDGET_EXHAUSTED");
  });

  it("does not interpret a Promise resolving false as a current job", async () => {
    let sends = 0;
    const service = createAiService({
      env: {},
      provider: new MockProvider(() => {
        sends++;
        throw Error("must not send");
      }),
    });
    const result = await service.runAdvisor(input(), {
      isCurrent: async () => false,
      beginAttempt: async () => {
        throw Error("stale job");
      },
      finishAttempt: async () => {},
    });
    expect(sends).toBe(0);
    expect(result.error?.code).toBe("CONTEXT_SUPERSEDED");
  });
});

describe("cloud model startup requirements", () => {
  it("permits local offline development", () => {
    expect(configuredAgents("local", process.cwd(), {}).configured).toBe(false);
  });
  it.each([undefined, "offline", "opneai"])(
    "rejects cloud offline/unknown provider %s",
    (value) => {
      expect(() =>
        configuredAgents("cloud", process.cwd(), { MODEL_PROVIDER: value }),
      ).toThrow("MODEL_PROVIDER");
    },
  );
  it("rejects a cloud provider without a key and model, without making network requests", () => {
    expect(() =>
      configuredAgents("cloud", process.cwd(), { MODEL_PROVIDER: "openai" }),
    ).toThrow("API key and model ID");
    expect(
      configuredAgents("cloud", process.cwd(), {
        MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "test-only-placeholder",
        OPENAI_MODEL: "test-model",
      }).configured,
    ).toBe(true);
  });
});
