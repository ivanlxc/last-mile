import { readFileSync } from "node:fs";
import {
  translateFixed,
  localizeTree,
  type Locale,
} from "../../localization.js";
// Server-only authored public wording. Never send this dictionary to a client
// or model: translate only the already-authorized projection/snapshot.
const content: Record<string, string> = JSON.parse(
  readFileSync(new URL("./en-US.json", import.meta.url), "utf8"),
);
const entries = Object.entries(content).sort(
  (a, b) => b[0].length - a[0].length,
);
export function translatePublicText(text: string, locale: Locale): string {
  if (locale === "zh-CN") return text;
  if (content[text]) return content[text];
  let result = text;
  for (const [zh, en] of entries)
    if (result.includes(zh)) result = result.split(zh).join(en);
  return translateFixed(result, locale);
}
export function localizePublic<T>(value: T, locale: Locale): T {
  return localizeTree(value, locale, translatePublicText);
}
