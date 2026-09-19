import type { P } from "./api";

/** Read the delivered report, including its limits, without an AI rewrite. */
export function reportNarration(report: P.ReportView, officer: string): string {
  const card = report.card;
  const freshness = {
    historical: "Historical information",
    current: "Current observation",
    superseded: "Superseded information",
    unknown: "Freshness unknown",
  };
  const verification =
    card.provenanceStatus === "verified"
      ? "Verified"
      : card.provenanceStatus === "partially_verified"
        ? "Partly verified"
        : "Unverified";
  return [
    card.title,
    `Source: ${officer}. ${card.sourceLabel}`,
    freshness[card.freshness as keyof typeof freshness] ?? "Freshness unknown",
    card.body,
    `Observation scope: ${card.observationScope}`,
    `Source verification: ${verification}`,
    `Observed at: ${card.observedAt ?? "Not provided"}`,
  ].join(". ");
}
