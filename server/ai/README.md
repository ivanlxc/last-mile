# LAST MILE AI runtime

`createAiService()` implements the domain `AgentGateway` structurally. It imports no SQLite, WorldEngine, private case, or role inventory. The only runtime assets here are the frozen public Agent contract, system prompts, and a catalog keyed by already-visible text hashes.

## Integration

```ts
import {
  createAiService,
  buildAdvisorInput,
  buildEvaluatorInput,
} from "./ai/index.js";
const agents = createAiService({ env: process.env });
// Domain injects agents into GameService, passes a frozen input and durable
// beginAttempt/finishAttempt/isCurrent callbacks. No call happens on construction.
```

Supported deployment keys: `MODEL_PROVIDER=offline|openai|anthropic`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`. The selected live provider needs both its key and model name; otherwise results are labeled `offline_template`. No key search, keychain access, credential logging, startup probe, conversation reuse, or provider SDK is used. `health()` exposes only configuration/readiness metadata; HTTP maps this to its narrower health contract. Model identifiers are configured explicitly because account access and supported models vary.

`HttpProvider` uses native fetch and exactly one request per `generate`. OpenAI uses Responses `text.format` with `json_schema`; Anthropic uses Messages `output_config.format`, plus `anthropic-version: 2023-06-01`. Both receive a conservative grammar subset; local Ajv 2020-12 validation still enforces all original lengths, conditionals, formats, counts, and contextual reference permissions. Provider grammar compliance is not semantic correctness. [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Messages API](https://platform.claude.com/docs/en/api/messages/create).

The locally verified OpenAI profile is `gpt-5.6-luna` with `OPENAI_REASONING_EFFORT=low`, a 30-second / 2,500-output-token Advisor request and a 45-second / 5,000-output-token Evaluator request. Configure these explicitly:

```dotenv
OPENAI_REASONING_EFFORT=low
AI_ADVISOR_TIMEOUT_MS=30000
AI_ADVISOR_MAX_OUTPUT_TOKENS=2500
AI_EVALUATOR_TIMEOUT_MS=45000
AI_EVALUATOR_MAX_OUTPUT_TOKENS=5000
```

When omitted, the four `AI_*` limits still default to 8,000 ms / 1,200 tokens and 20,000 ms / 3,000 tokens. The original 8-second window proved too short in early live checks. Timeout overrides accept 1,000–60,000 ms; output limits accept 256–16,000 tokens. `OPENAI_REASONING_EFFORT` is optional, only affects OpenAI, and accepts `none`, `low`, `medium`, `high`, `xhigh`, or `max`; acceptance by the local parser does not prove a particular model supports each value.

Refusal, truncation, transport failure and 429 return a labeled fallback; transport failures do not automatically retry. Malformed, context-invalid or clearly wrong-language output can consume at most one repair, within the remaining budget. Language checking only examines the model's own summary, Advisor rationale and Evaluator dimension explanations, excludes explicit quotations, and never translates or rewrites generated output. It is a conservative script mismatch check, not comprehensive language or semantic validation. The domain must atomically reserve a persisted sending attempt first, enforce **at most 2 attempts per logical job and 30 Advisor sends per session**, and keep success caches and terminal barriers. The AI module does not duplicate/reset those counters. An explicit retry uses the same logical job and its remaining budget. Late responses retain accounting but return no publishable result. Domain checks currentness again when committing completion.

`buildAdvisorInput` accepts only authorized current-scene views, constructs every object field explicitly, retains at most 12 unverified statements, freezes observation age, and hashes canonical JSON. It never receives a full session record. `buildEvaluatorInput` accepts `FilteredDecisionSlice` values containing pre-decision exposures, receipts and optional explicit self-report. It does not accept outcomes or hidden truth. Missing check availability, costs or motives stay unknown; NPC contexts are omitted. Free text is not classified into motive labels. Public-rule matches use the visible body hash, never a private case ID.

The canonical bound lists hold up to 32 counter/exclusion references; the builder indexes the earliest 32 per dimension while retaining all facts, contexts, and objective opportunity counts. This is an index bound, not deletion of later evidence or score sampling. Output guards cannot prove natural-language honesty or psychological validity; the report remains a limited game observation.

## Verification

```bash
pnpm exec vitest run tests/ai/ai.test.ts
pnpm verify:model # Safe metadata only; zero provider calls
```

Tests use injected fetch, fake timers and mock providers. They cover both actual vendor request/response envelopes, local full-schema checks, invalid JSON, unsupported citations, refusals, timeouts, stale completion, shared attempt budgets, future evidence, NPC exclusion and honest offline outputs. These automated contract tests make **zero paid or real provider requests**. `MockProvider` is an explicit test injection, not an environment-selectable production mode. No empirical claim about model quality or psychological measurement follows from contract tests.

Real OpenAI access and English/Chinese synthetic Advisor/Evaluator cases have now been verified, alongside a limited English domain-runtime check using an in-memory database and an injected clock. The final configured profile passed six live requests; this is a small smoke test, not an SLA, a full three-scene browser run, or evidence of psychological validity. Anthropic has not received a real-provider acceptance run. See [live integration acceptance](../../docs/implementation/真实模型接入验收.md) for the dated record, including early timeouts and rejected wrong-language outputs.

The opt-in CLI makes billable calls only with `--live` and uses synthetic fixture inputs, never a player database:

```bash
pnpm verify:model --live --role=all --locale=en-US --attempts=1 --output=.local-artifacts/model-smoke-en.json
```

`--role=advisor|evaluator|all`, `--locale=en-US|zh-CN` and `--attempts=1|2` select the bounded run; defaults are `all`, `en-US`, and `1`. At most role count × attempts requests can be sent. A fallback is a failed live check, not a success. The optional report path must remain under `.local-artifacts/`; console diagnostics omit credentials, raw provider error bodies and full inputs/outputs. No live call is part of ordinary `pnpm test` or service startup.

Public investigation mapping lives in `public-checks.ts` and contains no authored case or hidden state. `questionKeysForTarget` maps the inquiry a public target can address, not its current answer. Provenance requests use `source_chain`; an explicit self-reported question remains unchanged. Over-caution PV02 additionally requires `check.capabilityDisplayed === true`, based on an actual pre-decision display of that channel limitation. A general cost receipt alone cannot establish disclosure.
