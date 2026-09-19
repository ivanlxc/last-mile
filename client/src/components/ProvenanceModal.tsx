import { useI18n, formatError } from "../lib/i18n";
import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { get, sessionPath, type P } from "../lib/api";
import type { Game } from "../lib/useGame";
import { Modal } from "./Modal";
import { ReadAloudButton } from "./ReadAloudButton";
export function ProvenanceModal({
  game,
  onClose,
}: {
  game: Game;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const s = game.state!,
    [data, setData] = useState<P.ProvenanceView | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void get<P.ProvenanceView>(
      sessionPath(s.sessionId, "/provenance") +
        (s.sceneId ? `?sceneId=${s.sceneId}` : ""),
    )
      .then((v) => {
        if (active) setData(v);
      })
      .catch((e) => {
        if (active) setError(formatError(e, locale));
      });
    return () => {
      active = false;
    };
  }, [s.sessionId, s.sceneId, s.stateVersion]);
  const reports = data?.nodes.filter((n) => n.kind === "report") ?? [],
    sources = data?.nodes.filter((n) => n.kind !== "report") ?? [];
  const nodeHeight = locale === "en-US" ? 60 : 42;
  const rowHeight = nodeHeight + 16;
  const height = Math.max(
    250,
    Math.max(reports.length, sources.length) * rowHeight + 30,
  );
  const positions = new Map<string, [number, number]>();
  reports.forEach((n, i) => positions.set(n.nodeId, [35, 24 + i * rowHeight]));
  sources.forEach((n, i) => positions.set(n.nodeId, [430, 24 + i * rowHeight]));
  const relationLabels = {
      cites: t("ui.cites"),
      reports: t("ui.relays"),
      same_origin: t("ui.sameOrigin"),
    },
    statusLabels = {
      claimed: t("ui.sourceClaim"),
      hypothesized: t("ui.unverifiedRelationship"),
      verified: t("ui.verifiedRelationship"),
    };
  return (
    <Modal wide title={t("ui.whereDidTheseReportsComeFrom")} onClose={onClose}>
      <p> {t("ui.thisGraphShowsOnlyDisclosedRelationshipsSimilar")} </p>
      {error && <div className="notice-amber">{error}</div>}
      {!data ? (
        <div className="review-pending">
          <span className="spinner" /> {t("ui.loadingSourceRelationships")}{" "}
        </div>
      ) : (
        <>
          <ReadAloudButton
            id={`provenance:${s.sessionId}:${s.sceneId}`}
            text={[
              t("ui.thisGraphShowsOnlyDisclosedRelationshipsSimilar"),
              ...data.nodes.map((node) => node.label),
              ...data.edges.map((edge) =>
                [
                  data.nodes.find((node) => node.nodeId === edge.fromNodeId)
                    ?.label,
                  relationLabels[edge.relation],
                  data.nodes.find((node) => node.nodeId === edge.toNodeId)
                    ?.label,
                  statusLabels[edge.status],
                ].join(". "),
              ),
              data.notice,
            ].join(". ")}
          />
          <div className="provenance-legend">
            <span>{t("ui.reportCards")}</span>
            <span>{t("ui.disclosedSources")}</span>
            <span>{t("ui.solidVerifiedDashedUnverified")}</span>
          </div>
          <div className="provenance-scroll">
            {data.nodes.length ? (
              <svg
                viewBox={`0 0 660 ${height}`}
                className="provenance-graph"
                role="img"
                aria-label={t("ui.disclosedSourceRelationshipsInThisScene")}
              >
                <defs>
                  <marker
                    id="provenance-arrow"
                    markerWidth="7"
                    markerHeight="7"
                    refX="6"
                    refY="3.5"
                    orient="auto"
                  >
                    <path d="M0 0L7 3.5 0 7" fill="none" stroke="#91ab7f" />
                  </marker>
                </defs>
                {data.edges.map((e) => {
                  const a = positions.get(e.fromNodeId),
                    b = positions.get(e.toNodeId);
                  if (!a || !b) return null;
                  return (
                    <path
                      key={e.edgeId}
                      d={`M${a[0] + 195} ${a[1] + nodeHeight / 2}C${a[0] + 300} ${a[1] + nodeHeight / 2},${b[0] - 95} ${b[1] + nodeHeight / 2},${b[0]} ${b[1] + nodeHeight / 2}`}
                      stroke={e.status === "verified" ? "#a0c18f" : "#647e55"}
                      strokeWidth="1.2"
                      strokeDasharray={
                        e.status === "verified" ? undefined : "5 5"
                      }
                      fill="none"
                      markerEnd="url(#provenance-arrow)"
                    />
                  );
                })}
                {data.nodes.map((n) => {
                  const p = positions.get(n.nodeId)!;
                  return (
                    <g key={n.nodeId}>
                      <rect
                        x={p[0]}
                        y={p[1]}
                        width="195"
                        height={nodeHeight}
                        rx="5"
                        fill={n.kind === "report" ? "#303427" : "#243626"}
                        stroke={
                          n.kind === "verified_source" ? "#90b67e" : "#666e4844"
                        }
                      />
                      <foreignObject
                        x={p[0] + 11}
                        y={p[1] + 7}
                        width="174"
                        height={nodeHeight - 14}
                      >
                        <div className="provenance-label">{n.label}</div>
                      </foreignObject>
                    </g>
                  );
                })}
              </svg>
            ) : (
              <div className="empty-state">
                <Link2 size={25} />
                <h3>{t("ui.noReportsReceivedYet")}</h3>
                <p>{t("ui.requestAReportFromYourTeamThen")}</p>
              </div>
            )}
          </div>
          <div className="provenance-relations">
            {data.edges.map((e) => (
              <p key={e.edgeId}>
                <strong>
                  {data.nodes.find((n) => n.nodeId === e.fromNodeId)?.label}
                </strong>
                <span>{relationLabels[e.relation]} → </span>
                <strong>
                  {data.nodes.find((n) => n.nodeId === e.toNodeId)?.label}
                </strong>
                <em>{statusLabels[e.status]}</em>
              </p>
            ))}
          </div>
          <p className="muted small-text">{data.notice}</p>
        </>
      )}
    </Modal>
  );
}
