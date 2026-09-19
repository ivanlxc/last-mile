import type { AdvisorOutput } from "../../../../docs/engineering_v0.5/contracts/agent-derived.types";

/** Preserve every word, including late conditions and caveats, across requests. */
export function splitSpeechText(text: string, maxLength = 2000): string[] {
  const limit = Math.max(1, Math.floor(maxLength));
  const chunks: string[] = [];
  let remaining = text.replace(/\s+/g, " ").trim();
  while (remaining.length > limit) {
    const prefix = remaining.slice(0, limit + 1);
    const sentences = Array.from(prefix.matchAll(/[.!?]\s/g));
    const sentenceEnd = sentences.at(-1)?.index;
    const wordEnd = prefix.lastIndexOf(" ");
    const cut =
      sentenceEnd !== undefined && sentenceEnd + 1 >= limit / 3
        ? sentenceEnd + 1
        : wordEnd > 0
          ? wordEnd
          : limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function advisorReadout(
  output: AdvisorOutput,
  options: {
    current: boolean;
    offline: boolean;
    actionLabel: string | null;
    sourceTitle(refId: string, revision: number): string | undefined;
  },
) {
  const lines: string[] = [];
  if (!options.current)
    lines.push(
      "Earlier analysis. This advice uses an older information or decision context and may no longer apply.",
    );
  if (options.offline)
    lines.push(
      "Offline evidence review. This is a rules-based template, not a live language model response.",
    );
  lines.push(
    "AI advisor. Analysis is based only on the material explicitly shared with the advisor and any unverified player statements.",
  );
  lines.push(output.summary, output.recommendation.rationale);
  if (options.actionLabel)
    lines.push(`Conditional recommendation: ${options.actionLabel}.`);
  if (output.recommendation.conditions.length)
    lines.push(
      "Conditions for this recommendation:",
      ...output.recommendation.conditions,
    );
  if (output.uncertainties.length)
    lines.push("What remains unknown:", ...output.uncertainties);
  if (output.claims.length) lines.push("Evidence and reasoning:");
  for (const claim of output.claims) {
    const kind = {
      inference: "Inference",
      playerStatement: "Unverified player statement",
      backgroundRecord: "Background record",
      evidenceObservation: "Evidence observation",
    }[claim.kind];
    lines.push(`${kind}: ${claim.text}`);
    const sources = claim.citations.map((citation) => {
      const title = options.sourceTitle(citation.refId, citation.revision);
      return (
        title ??
        (citation.kind === "statement"
          ? "an unverified player statement"
          : citation.kind === "background"
            ? "a background rule"
            : `evidence reference ${citation.refId}`)
      );
    });
    if (sources.length)
      lines.push(`Sources: ${[...new Set(sources)].join("; ")}.`);
  }
  if (output.investigationSuggestions.length) {
    lines.push(
      "Questions to pursue:",
      ...output.investigationSuggestions.map((item) => item.questionToResolve),
    );
  }
  if (output.changeSummary)
    lines.push(`Changes since the prior analysis: ${output.changeSummary}`);
  return lines.filter(Boolean).join("\n\n");
}
