import type { AdvisorInput, EvaluatorInput } from "./types.js";
import { providerOutputSchema } from "./schema.js";
export type ProviderKind = "offline" | "openai" | "anthropic" | "mock";
export type OpenAIReasoningEffort =
  "none" | "low" | "medium" | "high" | "xhigh" | "max";
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}
export type ProviderErrorCode =
  | "MODEL_TIMEOUT"
  | "MODEL_TRANSPORT"
  | "MODEL_RATE_LIMIT"
  | "MODEL_INVALID_OUTPUT";
export type ProviderResult =
  | {
      ok: true;
      value: unknown;
      usage: Usage | null;
      providerRequestId: string | null;
    }
  | {
      ok: false;
      code: ProviderErrorCode;
      retryable: boolean;
      repairable: boolean;
      usage: Usage | null;
      providerRequestId: string | null;
      reason:
        | "transport"
        | "timeout"
        | "refusal"
        | "truncated"
        | "invalid_json"
        | "invalid_response"
        | "rate_limit"
        | "cancelled";
    };
export interface ProviderRequest {
  role: "advisor" | "evaluator";
  input: AdvisorInput | EvaluatorInput;
  systemPrompt: string;
  requestKey: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputTokens: number;
}
export interface StructuredProvider {
  readonly kind: ProviderKind;
  readonly configured: boolean;
  readonly model: string;
  readonly reasoningEffort?: OpenAIReasoningEffort;
  generate(request: ProviderRequest): Promise<ProviderResult>;
}
export interface ProviderConfig {
  provider: "offline" | "openai" | "anthropic";
  model: string;
  apiKey: string;
  openaiReasoningEffort?: OpenAIReasoningEffort;
}
export function readProviderConfig(
  env: Record<string, string | undefined>,
): ProviderConfig {
  // Only these explicitly supported keys are accessed; never enumerate, log or
  // serialize the environment or credential. No .env or keychain discovery.
  const provider =
    env.MODEL_PROVIDER === "openai"
      ? "openai"
      : env.MODEL_PROVIDER === "anthropic"
        ? "anthropic"
        : "offline";
  // A provider-specific setting must not change another provider's request or
  // cache identity. Blank is equivalent to leaving the optional setting unset.
  const effort =
    provider === "openai" ? env.OPENAI_REASONING_EFFORT?.trim() : undefined;
  if (
    effort &&
    !["none", "low", "medium", "high", "xhigh", "max"].includes(effort)
  )
    throw new Error(
      "INVALID_AI_CONFIG: OPENAI_REASONING_EFFORT must be none, low, medium, high, xhigh, or max",
    );
  return {
    provider,
    ...(effort
      ? { openaiReasoningEffort: effort as OpenAIReasoningEffort }
      : {}),
    model:
      provider === "openai"
        ? (env.OPENAI_MODEL ?? "").trim()
        : provider === "anthropic"
          ? (env.ANTHROPIC_MODEL ?? "").trim()
          : "",
    apiKey:
      provider === "openai"
        ? (env.OPENAI_API_KEY ?? "")
        : provider === "anthropic"
          ? (env.ANTHROPIC_API_KEY ?? "")
          : "",
  };
}
const usageOf = (v: any): Usage | null =>
  Number.isSafeInteger(v?.input_tokens) &&
  v.input_tokens >= 0 &&
  Number.isSafeInteger(v?.output_tokens) &&
  v.output_tokens >= 0
    ? { inputTokens: v.input_tokens, outputTokens: v.output_tokens }
    : null;
const failure = (
  code: ProviderErrorCode,
  reason: Extract<ProviderResult, { ok: false }>["reason"],
  retryable = false,
  repairable = false,
  usage: Usage | null = null,
  providerRequestId: string | null = null,
): ProviderResult => ({
  ok: false,
  code,
  reason,
  retryable,
  repairable,
  usage,
  providerRequestId,
});
async function readLimited(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) throw Error("EMPTY_BODY");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw Error("ABORTED");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 524288) throw Error("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}
export class HttpProvider implements StructuredProvider {
  readonly kind: "openai" | "anthropic";
  readonly configured: boolean;
  readonly model: string;
  readonly reasoningEffort?: OpenAIReasoningEffort;
  #key: string;
  #fetch: typeof fetch;
  constructor(config: ProviderConfig, fetchImpl: typeof fetch = fetch) {
    this.kind = config.provider === "anthropic" ? "anthropic" : "openai";
    this.model = config.model;
    this.reasoningEffort =
      this.kind === "openai" ? config.openaiReasoningEffort : undefined;
    this.#key = config.apiKey;
    this.configured =
      config.provider !== "offline" && !!config.model && !!config.apiKey;
    this.#fetch = fetchImpl;
  }
  async generate(r: ProviderRequest): Promise<ProviderResult> {
    if (!this.configured) return failure("MODEL_TRANSPORT", "transport");
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    r.signal?.addEventListener("abort", abort, { once: true });
    if (r.signal?.aborted) controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, r.timeoutMs);
    const schema = providerOutputSchema(r.role);
    const endpoint =
      this.kind === "openai"
        ? "https://api.openai.com/v1/responses"
        : "https://api.anthropic.com/v1/messages";
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    let body: Record<string, unknown>;
    if (this.kind === "openai") {
      headers.authorization = `Bearer ${this.#key}`;
      headers["x-client-request-id"] = r.requestKey;
      body = {
        model: this.model,
        store: false,
        instructions: r.systemPrompt,
        input: [{ role: "user", content: JSON.stringify(r.input) }],
        text: {
          format: {
            type: "json_schema",
            name: `last_mile_${r.role}_v05`,
            strict: true,
            schema,
          },
        },
        max_output_tokens: r.maxOutputTokens,
        ...(this.reasoningEffort
          ? { reasoning: { effort: this.reasoningEffort } }
          : {}),
      };
    } else {
      headers["x-api-key"] = this.#key;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model: this.model,
        max_tokens: r.maxOutputTokens,
        system: r.systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(r.input) }],
        output_config: { format: { type: "json_schema", schema } },
        stream: false,
      };
    }
    try {
      const response = await this.#fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const requestId =
        response.headers.get("x-request-id") ??
        response.headers.get("request-id");
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return failure(
          response.status === 429 ? "MODEL_RATE_LIMIT" : "MODEL_TRANSPORT",
          response.status === 429 ? "rate_limit" : "transport",
          response.status === 429 || response.status >= 500,
          false,
          null,
          requestId,
        );
      }
      let envelope: any;
      try {
        envelope = JSON.parse(await readLimited(response, controller.signal));
      } catch {
        if (controller.signal.aborted) throw Error("ABORTED");
        return failure(
          "MODEL_INVALID_OUTPUT",
          "invalid_json",
          true,
          true,
          null,
          requestId,
        );
      }
      const usage = usageOf(envelope?.usage),
        providerRequestId =
          typeof envelope?.id === "string" ? envelope.id : requestId;
      let text: string;
      if (this.kind === "openai") {
        const blocks = Array.isArray(envelope?.output)
          ? envelope.output.flatMap((x: any) =>
              x?.type === "message" && Array.isArray(x.content)
                ? x.content
                : [],
            )
          : [];
        if (blocks.some((x: any) => x?.type === "refusal"))
          return failure(
            "MODEL_INVALID_OUTPUT",
            "refusal",
            false,
            false,
            usage,
            providerRequestId,
          );
        if (envelope?.status !== "completed")
          return failure(
            "MODEL_INVALID_OUTPUT",
            envelope?.status === "incomplete"
              ? "truncated"
              : "invalid_response",
            false,
            false,
            usage,
            providerRequestId,
          );
        const texts = blocks.filter(
          (x: any) => x?.type === "output_text" && typeof x.text === "string",
        );
        if (texts.length !== 1)
          return failure(
            "MODEL_INVALID_OUTPUT",
            "invalid_response",
            true,
            true,
            usage,
            providerRequestId,
          );
        text = texts[0].text;
      } else {
        if (envelope?.stop_reason === "refusal")
          return failure(
            "MODEL_INVALID_OUTPUT",
            "refusal",
            false,
            false,
            usage,
            providerRequestId,
          );
        if (envelope?.stop_reason !== "end_turn")
          return failure(
            "MODEL_INVALID_OUTPUT",
            envelope?.stop_reason === "max_tokens"
              ? "truncated"
              : "invalid_response",
            false,
            false,
            usage,
            providerRequestId,
          );
        const texts = Array.isArray(envelope?.content)
          ? envelope.content.filter(
              (x: any) => x?.type === "text" && typeof x.text === "string",
            )
          : [];
        if (
          texts.length !== 1 ||
          envelope?.content.some((x: any) => x?.type === "tool_use")
        )
          return failure(
            "MODEL_INVALID_OUTPUT",
            "invalid_response",
            true,
            true,
            usage,
            providerRequestId,
          );
        text = texts[0].text;
      }
      try {
        return { ok: true, value: JSON.parse(text), usage, providerRequestId };
      } catch {
        return failure(
          "MODEL_INVALID_OUTPUT",
          "invalid_json",
          true,
          true,
          usage,
          providerRequestId,
        );
      }
    } catch {
      return failure(
        timedOut ? "MODEL_TIMEOUT" : "MODEL_TRANSPORT",
        timedOut ? "timeout" : r.signal?.aborted ? "cancelled" : "transport",
        !r.signal?.aborted,
        false,
      );
    } finally {
      clearTimeout(timer);
      r.signal?.removeEventListener("abort", abort);
    }
  }
}
export class MockProvider implements StructuredProvider {
  readonly kind = "mock";
  readonly configured = true;
  readonly model = "injected-test-model";
  constructor(
    private readonly responder: (
      request: ProviderRequest,
    ) => ProviderResult | Promise<ProviderResult>,
  ) {}
  generate(request: ProviderRequest) {
    return Promise.resolve(this.responder(request));
  }
}
export class OfflineProvider implements StructuredProvider {
  readonly kind = "offline";
  readonly configured = false;
  readonly model = "";
  async generate(): Promise<ProviderResult> {
    return failure("MODEL_TRANSPORT", "transport");
  }
}
