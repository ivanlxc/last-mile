import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createAiService,
  buildAdvisorInput,
  advisorInputHash,
  guardAdvice,
  guardEvaluation,
  guardAdvisorInput,
  buildEvaluatorInput,
  assertContract,
  providerOutputSchema,
  MockProvider,
  HttpProvider,
  advisorFallback,
  evaluatorFallback,
  classifyContext,
  featuresFor,
  questionKeysForTarget,
  cannotConfirmQuestionKeys,
  publicChannelScopeText,
} from "../../server/ai/index.js";
import type {
  AdvisorInput,
  AdvisorOutput,
  EvaluatorInput,
  EvaluatorOutput,
  AttemptControl,
  FilteredDecisionSlice,
  BehavioralFeatures,
} from "../../server/ai/index.js";
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8"));
const advisor = (): AdvisorInput => {
  const x = fixture("advisor-input");
  x.inputHash = advisorInputHash(x);
  return x;
};
const answer = (input: AdvisorInput): AdvisorOutput => ({
  ...fixture("advisor-output"),
  inputHash: input.inputHash,
});
const evaluator = (): EvaluatorInput => fixture("evaluator-input");
function controller(max = 2) {
  let count = 0,
    current = true;
  const finished: any[] = [];
  return {
    locale: "zh-CN" as const,
    get count() {
      return count;
    },
    finished,
    setCurrent(v: boolean) {
      current = v;
    },
    beginAttempt() {
      if (count >= max) throw Error("budget");
      return {
        attemptNo: ++count,
        requestKey: `00000000-0000-0000-0000-${String(count).padStart(12, "0")}`,
      };
    },
    finishAttempt(n: number, result: any) {
      finished.push({ n, ...result });
    },
    isCurrent() {
      return current;
    },
  } satisfies AttemptControl & {
    readonly count: number;
    finished: any[];
    setCurrent(v: boolean): void;
  };
}
const env = (provider: "openai" | "anthropic") => ({
  MODEL_PROVIDER: provider,
  OPENAI_API_KEY: "test-key-never-real",
  OPENAI_MODEL: "test-openai",
  ANTHROPIC_API_KEY: "test-key-never-real",
  ANTHROPIC_MODEL: "test-anthropic",
});
function envelope(provider: string, value: unknown) {
  return provider === "openai"
    ? {
        id: "response_1",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify(value) }],
          },
        ],
        usage: { input_tokens: 20, output_tokens: 30 },
      }
    : {
        id: "message_1",
        type: "message",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(value) }],
        usage: { input_tokens: 20, output_tokens: 30 },
      };
}
afterEach(() => vi.useRealTimers());

describe("context and permission guards", () => {
  it("constructs an immutable allowlist and removes private fields at every level", () => {
    const input = advisor();
    const raw: any = {
      ...input,
      missionTimeMs: 1,
      privateCaseId: "secret",
      publicTask: { ...input.publicTask, resourceBalance: 5 },
      evidence: [{ ...input.evidence[0], root_source: "private" }],
    };
    const built = buildAdvisorInput(raw);
    expect(JSON.stringify(built)).not.toMatch(
      /privateCaseId|root_source|resourceBalance|missionTimeMs/,
    );
    expect(built.inputHash).toBe(advisorInputHash(built));
    raw.evidence[0].text = "mutated";
    expect(built.evidence[0]!.text).not.toBe("mutated");
  });
  it("does not allow a caller to smuggle extra fields directly to service", async () => {
    const service = createAiService({ env: { MODEL_PROVIDER: "offline" } }),
      c = controller();
    const input: any = advisor();
    input.missionTimeMs = 9000;
    expect((await service.runAdvisor(input, c)).error?.code).toBe(
      "AGENT_INPUT_INVALID",
    );
    expect(c.count).toBe(0);
  });
  it("rejects an altered input hash", () => {
    const a = advisor();
    a.evidence[0]!.text = "new";
    expect(() => guardAdvisorInput(a)).toThrow("INPUT_HASH_MISMATCH");
  });
  it("keeps last 12 statements unverified even if caller supplies a verified flag", () => {
    const a = advisor();
    const x: any = {
      ...a,
      statements: Array.from({ length: 14 }, (_, i) => ({
        statementId: `00000000-0000-0000-0000-${String(900 + i).padStart(12, "0")}`,
        revision: 1,
        text: `statement ${i}`,
        verification: "verified",
      })),
    };
    const built = buildAdvisorInput(x);
    expect(built.statements).toHaveLength(12);
    expect(built.statements[0]!.text).toBe("statement 2");
    expect(built.statements.every((x) => x.verification === "unverified")).toBe(
      true,
    );
  });
  it("rejects unuploaded provenance and unknown source endpoints", () => {
    const a = advisor();
    const ref = { instanceId: a.evidence[0]!.instanceId, revision: 1 };
    (a.evidence[0] as any).knownSourceEdges = [
      {
        fromRef: ref,
        toRef: ref,
        relation: "same_source_confirmed",
        findingRef: null,
      },
    ];
    a.inputHash = advisorInputHash(a);
    expect(() => guardAdvisorInput(a)).toThrow("PROVENANCE_WITHOUT_FINDING");
  });
  it("rejects references and action IDs absent from the manifest", () => {
    const a = advisor(),
      out = answer(a);
    (out.claims[0]!.citations[0] as any).refId =
      "00000000-0000-0000-0000-000000000999";
    expect(() => guardAdvice(a, out)).toThrow("CITATION_NOT_IN_MANIFEST");
    const out2 = answer(a);
    out2.recommendation.actionId = "SECRET_ACTION";
    expect(() => guardAdvice(a, out2)).toThrow("ACTION_NOT_PUBLIC");
  });
  it("full local schema enforces constraints omitted from provider grammar", () => {
    const a = advisor(),
      out: any = answer(a);
    out.claims[0].kind = "evidenceObservation";
    out.claims[0].citations = [];
    expect(() => guardAdvice(a, out)).toThrow();
    const schema = JSON.stringify(providerOutputSchema("advisor"));
    expect(schema).not.toMatch(/"allOf"|"if"|"minLength"|"maximum"|"\$ref"/);
    expect(providerOutputSchema("advisor").additionalProperties).toBe(false);
  });
  for (const name of [
    "advisor-input",
    "advisor-output",
    "evaluator-input",
    "evaluator-output",
  ] as const)
    it(`loads canonical ${name}`, () => {
      const map = {
        "advisor-input": "AdvisorInput",
        "advisor-output": "AdvisorOutput",
        "evaluator-input": "EvaluatorInput",
        "evaluator-output": "EvaluatorOutput",
      } as const;
      assertContract(map[name], fixture(name));
    });
});

describe.each(["openai", "anthropic"] as const)(
  "%s protocol via fake HTTP",
  (provider) => {
    it("sends actual structured-output protocol and records usage once", async () => {
      const a = advisor();
      let request: any;
      let url = "";
      const fake = vi.fn(async (u: any, init: any) => {
        url = String(u);
        request = init;
        return new Response(JSON.stringify(envelope(provider, answer(a))), {
          status: 200,
        });
      }) as unknown as typeof fetch;
      const service = createAiService({ env: env(provider), fetchImpl: fake });
      const c = controller();
      const result = await service.runAdvisor(a, c);
      expect(result.status).toBe("succeeded");
      expect(result.mode).toBe("live_model");
      expect(c.count).toBe(1);
      expect(c.finished[0].inputTokens).toBe(20);
      expect(service.health().status).toBe("ready");
      const body = JSON.parse(request.body);
      expect(body.tools).toBeUndefined();
      expect(body.previous_response_id).toBeUndefined();
      if (provider === "openai") {
        expect(url).toBe("https://api.openai.com/v1/responses");
        expect(body.text.format.type).toBe("json_schema");
        expect(body.text.format.strict).toBe(true);
        expect(body.store).toBe(false);
        expect(body.instructions).toContain("LANTERN");
        expect(body.max_output_tokens).toBe(1200);
      } else {
        expect(url).toBe("https://api.anthropic.com/v1/messages");
        expect(body.output_config.format.type).toBe("json_schema");
        expect(request.headers["anthropic-version"]).toBe("2023-06-01");
        expect(body.system).toContain("LANTERN");
        expect(body.max_tokens).toBe(1200);
      }
    });
    it("repairs invalid JSON at most once and uses a distinct durable request key", async () => {
      const a = advisor();
      let calls = 0;
      const fake = vi.fn(async () => {
        calls++;
        if (calls === 1) return new Response("{bad json");
        return new Response(JSON.stringify(envelope(provider, answer(a))));
      }) as unknown as typeof fetch;
      const c = controller(),
        service = createAiService({ env: env(provider), fetchImpl: fake });
      expect((await service.runAdvisor(a, c)).status).toBe("succeeded");
      expect(c.count).toBe(2);
      expect(c.finished.map((x) => x.status)).toEqual(["failed", "succeeded"]);
    });
    it("never publishes fabricated references and exhausted repair remains labeled fallback", async () => {
      const a = advisor(),
        out = answer(a);
      (out.claims[0]!.citations[0] as any).refId =
        "00000000-0000-0000-0000-000000000999";
      const fake = vi.fn(
        async () => new Response(JSON.stringify(envelope(provider, out))),
      ) as unknown as typeof fetch;
      const c = controller(),
        service = createAiService({ env: env(provider), fetchImpl: fake });
      const result = await service.runAdvisor(a, c);
      expect(c.count).toBe(2);
      expect(result.status).toBe("fallback");
      expect(result.mode).toBe("offline_template");
      expect(
        (result.result as AdvisorOutput).recommendation.actionId,
      ).toBeNull();
      expect(result.error?.retryable).toBe(false);
    });
    it("does not repair a refusal or retry a transport failure automatically", async () => {
      const a = advisor();
      const refusal =
        provider === "openai"
          ? {
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [{ type: "refusal", refusal: "no" }],
                },
              ],
            }
          : { stop_reason: "refusal", content: [] };
      const c = controller(),
        service = createAiService({
          env: env(provider),
          fetchImpl: (async () =>
            new Response(JSON.stringify(refusal))) as typeof fetch,
        });
      expect((await service.runAdvisor(a, c)).status).toBe("fallback");
      expect(c.count).toBe(1);
      const c2 = controller(),
        service2 = createAiService({
          env: env(provider),
          fetchImpl: (async () =>
            new Response("private provider error body", {
              status: 429,
            })) as typeof fetch,
        });
      const result = await service2.runAdvisor(a, c2);
      expect(c2.count).toBe(1);
      expect(result.error?.code).toBe("MODEL_RATE_LIMIT");
      expect(JSON.stringify(result)).not.toContain("private provider");
    });
    it("has an 8s Advisor deadline and records timeout as one sent attempt", async () => {
      vi.useFakeTimers();
      const fake = vi.fn(
        (_u: any, init: any) =>
          new Promise<Response>((_, reject) =>
            init.signal.addEventListener("abort", () =>
              reject(Error("aborted")),
            ),
          ),
      ) as unknown as typeof fetch;
      const c = controller(),
        service = createAiService({ env: env(provider), fetchImpl: fake });
      const pending = service.runAdvisor(advisor(), c);
      await vi.advanceTimersByTimeAsync(8000);
      const result = await pending;
      expect(result.error?.code).toBe("MODEL_TIMEOUT");
      expect(c.count).toBe(1);
      expect(c.finished[0].status).toBe("timeout");
    });
    it("ignores a late result once its context is superseded", async () => {
      const a = advisor(),
        c = controller();
      const fake = (async () => {
        c.setCurrent(false);
        return new Response(JSON.stringify(envelope(provider, answer(a))));
      }) as typeof fetch;
      const result = await createAiService({
        env: env(provider),
        fetchImpl: fake,
      }).runAdvisor(a, c);
      expect(result.result).toBeNull();
      expect(result.error?.code).toBe("CONTEXT_SUPERSEDED");
      expect(c.count).toBe(1);
    });
    it("accepts a valid independent evaluator output and refuses truncated provider output", async () => {
      const input = evaluator(),
        output = fixture("evaluator-output");
      const c = controller();
      const service = createAiService({
        env: env(provider),
        fetchImpl: (async () =>
          new Response(
            JSON.stringify(envelope(provider, output)),
          )) as typeof fetch,
      });
      const result = await service.runEvaluator(input, c);
      expect(result.status).toBe("succeeded");
      expect((result.result as EvaluatorOutput).sealedHash).toBe(
        input.sealedHash,
      );
      expect(c.count).toBe(1);
      const partial: any = envelope(provider, answer(advisor()));
      if (provider === "openai") partial.status = "incomplete";
      else partial.stop_reason = "max_tokens";
      const c2 = controller();
      const truncated = await createAiService({
        env: env(provider),
        fetchImpl: (async () =>
          new Response(JSON.stringify(partial))) as typeof fetch,
      }).runAdvisor(advisor(), c2);
      expect(truncated.status).toBe("fallback");
      expect(c2.count).toBe(1);
      expect(truncated.error?.retryable).toBe(false);
    });
    it("Evaluator uses an independent system and 20s timeout", async () => {
      vi.useFakeTimers();
      let body: any;
      const fake = ((_u: any, init: any) => {
        body = JSON.parse(init.body);
        return new Promise<Response>((_, reject) =>
          init.signal.addEventListener("abort", () => reject(Error("aborted"))),
        );
      }) as typeof fetch;
      const c = controller(),
        service = createAiService({ env: env(provider), fetchImpl: fake });
      const pending = service.runEvaluator(evaluator(), c);
      await vi.advanceTimersByTimeAsync(19999);
      expect(c.finished).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).error?.code).toBe("MODEL_TIMEOUT");
      expect(provider === "openai" ? body.instructions : body.system).toContain(
        "independent after-action",
      );
      expect(
        body.messages?.[0]?.content ?? body.input?.[0]?.content,
      ).not.toContain("hiddenTruth");
    });
  },
);

describe("offline, budget, and evaluator isolation", () => {
  it("offline/no key consumes zero attempts and never fabricates a recommendation", async () => {
    const c = controller(),
      service = createAiService({ env: { MODEL_PROVIDER: "offline" } });
    const result = await service.runAdvisor(advisor(), c);
    expect(c.count).toBe(0);
    expect(service.configured).toBe(false);
    expect(result.mode).toBe("offline_template");
    expect((result.result as AdvisorOutput).recommendation.actionId).toBeNull();
    expect(JSON.stringify(service.health())).not.toMatch(/key|endpoint/);
  });
  it("budget refusal sends no HTTP", async () => {
    const fake = vi.fn();
    const c = controller(0),
      service = createAiService({ env: env("openai"), fetchImpl: fake });
    expect((await service.runAdvisor(advisor(), c)).error?.code).toBe(
      "MODEL_BUDGET_EXHAUSTED",
    );
    expect(fake).not.toHaveBeenCalled();
  });
  it("a caller retry shares the persisted lifetime count", async () => {
    let calls = 0;
    const mock = new MockProvider(async () => {
      calls++;
      return {
        ok: false,
        code: "MODEL_TRANSPORT",
        retryable: true,
        repairable: false,
        reason: "transport",
        usage: null,
        providerRequestId: null,
      };
    });
    const c = controller(),
      service = createAiService({ provider: mock, env: {} });
    await service.runAdvisor(advisor(), c);
    await service.runAdvisor(advisor(), c);
    await service.runAdvisor(advisor(), c);
    expect(c.count).toBe(2);
    expect(calls).toBe(2);
  });
  it("rejects truth injected into evaluator input before provider invocation", async () => {
    const e: any = evaluator();
    e.hiddenTruth = { bridge: true };
    const c = controller();
    const result = await createAiService({ env: {} }).runEvaluator(e, c);
    expect(result.error?.code).toBe("AGENT_INPUT_INVALID");
    expect(c.count).toBe(0);
  });
  it("rejects future and cross-context evidence", () => {
    const e = evaluator(),
      out = fixture("evaluator-output");
    (e.facts[0] as any).availableAtMissionMs =
      e.contexts[0]!.cutoffMissionMs + 1;
    expect(() => guardEvaluation(e, out)).toThrow("FUTURE_FACT");
    const e2 = evaluator();
    (e2.facts[0]!.evidenceRefs[0] as any).instanceId =
      e2.facts[1]!.evidenceRefs[0]!.instanceId;
    expect(() => guardEvaluation(e2, out)).toThrow("FACT_EVIDENCE_NOT_VISIBLE");
  });
  it("validates both deterministic fallback outputs under full contracts", () => {
    const a = advisor();
    assertContract("AdvisorOutput", advisorFallback(a));
    const e = evaluator();
    guardEvaluation(e, evaluatorFallback(e));
  });
  it("builds facts only from human, pre-decision exposures; no outcomes or motive inference", () => {
    const base: FilteredDecisionSlice = {
      contextId: "00000000-0000-0000-0000-000000000010",
      sourceEventId: "00000000-0000-0000-0000-000000000011",
      sceneId: "E1",
      subjectBindingId: "00000000-0000-0000-0000-000000000012",
      controllerKind: "human",
      kind: "route_decision",
      cutoffMissionMs: 1000,
      chosenActionId: "E1_MAIN",
      legalActionIds: ["E1_MAIN", "E1_BYPASS"],
      displayedReports: [
        {
          instanceId: "00000000-0000-0000-0000-000000000013",
          revision: 1,
          definitionId: "gate_agency",
          body: "later evidence",
          freshness: "current",
          displayedAtMissionMs: 1001,
        },
      ],
      advisorUploadedRefs: [],
      reasonText: "I secretly ignored everything",
    };
    const input = buildEvaluatorInput({
      sessionId: advisor().sessionId,
      sealedHash: "b".repeat(64),
      subjectBindingId: base.subjectBindingId,
      decisions: [
        base,
        {
          ...base,
          contextId: "00000000-0000-0000-0000-000000000015",
          controllerKind: "npc",
        },
      ],
      terminalKind: "normal_end",
    });
    expect(input.contexts).toHaveLength(1);
    expect(input.contexts[0]!.playerVisibleRefs).toHaveLength(0);
    expect(input.contexts[0]!.reasonCodes).toEqual(["no_reason"]);
    expect(evaluatorFallback(input).overallPattern).toBe(
      "insufficient_evidence",
    );
    expect(JSON.stringify(input)).not.toContain("later evidence");
  });
  it("treats an explicit alternative evidence reason as a counterexample to AI-only reliance", () => {
    const f = fixture("fact-rule-cases").baseFeature as BehavioralFeatures;
    const r = classifyContext({
      ...f,
      reasonCodes: ["ai_said_so", "evidence_supported"],
      usedEvidenceInReason: false,
    });
    expect(r.complacency.support).toBe(false);
    expect(r.complacency.counterevidence).toBe(true);
    expect(r.calibratedTrust.support).toBe(false); // self-report does not prove a cited evidence basis
  });
  const data = fixture("fact-rule-cases");
  for (const c of data.cases)
    it(`rule fixture: ${c.name}`, () => {
      const f = { ...data.baseFeature, ...c.patch } as BehavioralFeatures;
      expect(
        classifyContext(f)[
          c.expectDimension as keyof ReturnType<typeof classifyContext>
        ].support,
      ).toBe(c.expectSupport);
    });
});

describe("public investigation capability mapping", () => {
  it("maps current checks separately from history and unverified accounts", () => {
    expect(questionKeysForTarget("gate_agency")).toEqual(["gate_registration"]);
    expect(questionKeysForTarget("service_drone")).toEqual(["service_lane"]);
    expect(questionKeysForTarget("bridge_agency")).toEqual([
      "bridge_permission",
    ]);
    expect(questionKeysForTarget("gate_satellite")).not.toContain(
      "gate_registration",
    );
    expect(questionKeysForTarget("market_witness")).not.toContain(
      "explosion_cause",
    );
    expect(questionKeysForTarget("unknown_private_case_target")).toEqual([]);
  });
  it("returns copies and preserves the public catalog cannot-confirm rules", () => {
    const q = questionKeysForTarget("gate_agency");
    q.push("private");
    expect(questionKeysForTarget("gate_agency")).not.toContain("private");
    const catalog = JSON.parse(
      readFileSync(
        new URL(
          "../../server/ai/assets/public-fact-catalog.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    for (const row of catalog.cannotConfirm)
      expect(cannotConfirmQuestionKeys(row.channel)).toEqual(row.questionKeys);
    expect(publicChannelScopeText("drone")).toContain("通行许可");
  });
  it("never treats a cost display alone as disclosure of a channel limitation", () => {
    const s: FilteredDecisionSlice = {
      contextId: "00000000-0000-0000-0000-000000000010",
      sourceEventId: "00000000-0000-0000-0000-000000000011",
      sceneId: "E3",
      subjectBindingId: "00000000-0000-0000-0000-000000000012",
      controllerKind: "human",
      kind: "investigation_request",
      cutoffMissionMs: 1000,
      chosenActionId: "investigate_and_report",
      legalActionIds: ["investigate_and_report"],
      displayedReports: [],
      advisorUploadedRefs: [],
      contextDisplayedAtMs: 900,
      check: {
        channel: "drone",
        questionKey: "bridge_permission",
        knownAffordable: true,
        refresh: false,
        newTimeWindow: false,
      },
      reasonAnnotation: {
        reasonCodes: ["no_new_question"],
        acknowledgedLimitation: false,
        comparedKnownCosts: true,
        declaredQuestionKey: "bridge_permission",
      },
    };
    expect(featuresFor(s).checkLowValueByPublicRule).toBe(false);
    expect(classifyContext(featuresFor(s)).overCaution.support).toBe(false);
    s.check!.capabilityDisplayed = true;
    expect(classifyContext(featuresFor(s)).overCaution.support).toBe(true);
    s.check!.newTimeWindow = true;
    expect(classifyContext(featuresFor(s)).overCaution.support).toBe(false);
  });
});
