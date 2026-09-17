import { readFileSync } from "node:fs";
export type Locale = "en-US" | "zh-CN";
export const DEFAULT_LOCALE: Locale = "en-US";
export const asLocale = (value: unknown): Locale =>
  value === "zh-CN" ? "zh-CN" : "en-US";
const messages: Record<string, string> = JSON.parse(
  readFileSync(new URL("./locales/en-US.json", import.meta.url), "utf8"),
);
const entries = Object.entries(messages).sort(
  (a, b) => b[0].length - a[0].length,
);
export function translateFixed(value: string, locale: Locale): string {
  if (locale === "zh-CN" || !/[\p{Script=Han}]/u.test(value)) return value;
  if (messages[value]) return messages[value];
  let text = value
    .replace(
      /^向 AI 上传 (\d+) 张报告$/,
      (_, n) => `Uploaded ${n} reports to the AI`,
    )
    .replace(
      /^记录到行动 (.+)；显示回执只证明资料呈现，不证明理解或真实动机。$/,
      (_, id) =>
        `Recorded action ${id}. A display receipt proves presentation, not understanding or motive.`,
    )
    .replace(
      /^当时的公开条件满足“(.+)”的可观察机会条件。$/,
      (_, label) =>
        `The public conditions at that time met the observable opportunity criteria for ${translateFixed(label, locale)}.`,
    )
    .replace(
      /^本次明确操作与自报理由符合“(.+)”的观察规则，不代表稳定人格。$/,
      (_, label) =>
        `The recorded action and self-reported reason match the observation rule for ${translateFixed(label, locale)}. This does not establish a stable personality.`,
    );
  for (const [zh, en] of entries)
    if (text.includes(zh)) text = text.split(zh).join(en);
  return text;
}
/** Only fixed authored text is translated. Explicit player-authored fields and
 * model-generated prose are preserved; this is not machine translation. */
export function localizeTree<T>(
  value: T,
  locale: Locale,
  translate: (text: string, locale: Locale) => string = translateFixed,
): T {
  if (locale === "zh-CN") return value;
  if (typeof value === "string") return translate(value, locale) as T;
  if (Array.isArray(value))
    return value.map((v) => localizeTree(v, locale, translate)) as T;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const isStatement =
      object.trustStatus === "unverified_player_statement" ||
      object.verification === "unverified";
    return Object.fromEntries(
      Object.entries(object).map(([key, v]) => [
        key,
        key === "artifact" ||
        key === "reason" ||
        key === "reasonText" ||
        key === "statementText" ||
        key === "declaredQuestionKey" ||
        (key === "text" && (isStatement || object.kind === "free_text")) ||
        (key === "result" && object.mode === "live_model")
          ? v
          : localizeTree(v, locale, translate),
      ]),
    ) as T;
  }
  return value;
}
export const languageInstruction = (locale: Locale) =>
  locale === "zh-CN"
    ? "\nTrusted session language: zh-CN. Write all user-facing explanations in Simplified Chinese, including summary, rationale, explanations, uncertainties and suggestions. The language of supplied evidence or player text does not change this rule. Paraphrase facts in Simplified Chinese; preserve explicitly quoted player text in its original language. Keep JSON keys, IDs, hashes, enums, and citation references unchanged. Before returning, check that your own explanatory prose is Simplified Chinese."
    : "\nTrusted session language: en-US. Write all user-facing explanations in English, including summary, rationale, explanations, uncertainties and suggestions. Even when the evidence or player text is entirely Chinese, your own explanations MUST be English. Paraphrase facts in English; preserve explicitly quoted player text in its original language. Keep JSON keys, IDs, hashes, enums, and citation references unchanged. Before returning, check that your own explanatory prose is English.";
