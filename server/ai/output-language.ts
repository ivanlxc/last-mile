import type { Locale } from "../localization.js";
import type { AdvisorOutput, EvaluatorOutput } from "./types.js";
import { ensure } from "./schema.js";

/** A conservative script mismatch check, not a general language classifier.
 * Only inspect the agent's own summary/rationale/explanations. Evidence claims
 * may reproduce source text; explicit quotations and brief names stay intact.
 * Never translate or rewrite model output after generation.
 */
export function guardOutputLanguage(
  output: AdvisorOutput | EvaluatorOutput,
  locale: Locale,
): void {
  const prose = [
    output.summary,
    ...("recommendation" in output
      ? [output.recommendation.rationale]
      : Object.values(output.dimensions).map((d) => d.explanation)),
  ]
    .join(" ")
    .replace(/"[^"\n]*"|“[^”]*”|「[^」]*」|『[^』]*』/g, "");
  const han = prose.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  const latin = prose.match(/[A-Za-z]/g)?.length ?? 0;
  const mismatch =
    locale === "en-US" ? han >= 12 && han > latin : han === 0 && latin >= 40;
  ensure(!mismatch, "OUTPUT_LANGUAGE_MISMATCH");
}
