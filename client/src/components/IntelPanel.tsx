import { useI18n } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import {
  Radio,
  ScanLine,
  Satellite,
  Users,
  Building2,
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  Link2,
  CircleDot,
  Send,
} from "lucide-react";
import type { P } from "../lib/api";
import type { Game } from "../lib/useGame";

import { useVisibleReceipt } from "../lib/useVisibleReceipt";
import { InvestigationModal } from "./InvestigationModal";
import { ProvenanceModal } from "./ProvenanceModal";
import { ReadAloudButton } from "./ReadAloudButton";
import { reportNarration } from "../lib/reportNarration";
const icons = {
  satellite: Satellite,
  drone: ScanLine,
  localAgency: Building2,
  witness: Users,
};
export function IntelPanel({
  game,
  active = true,
}: {
  game: Game;
  active?: boolean;
}) {
  const { t, characters, scenes, channelLabels, duration } = useI18n();
  const disabledLabels = {
    no_resource: t("ui.missionAllowanceExhausted"),
    no_report_slot: t("ui.sceneReportLimitReached"),
    role_busy: t("ui.thisRoleIsBusy"),
    phase_locked: t("ui.unavailableWhileMoving"),
    needs_report_reference: t("ui.aDeliveredReportIsRequired"),
  };

  const s = game.state!,
    [tab, setTab] = useState<"investigate" | "reports">("investigate"),
    [role, setRole] = useState<"analyst" | "liaison">("analyst"),
    [expanded, setExpanded] = useState<string | null>(null),
    [trace, setTrace] = useState<P.TaskOption | null>(null),
    [provenance, setProvenance] = useState(false),
    [pendingTopic, setPendingTopic] = useState<string | null>(null),
    [receivedReportId, setReceivedReportId] = useState<string | null>(null);
  const scene = s.sceneId ? scenes[s.sceneId] : null,
    current = s.reports.filter((r) => r.sceneId === s.sceneId);
  const quota = s.reportQuotas.find(
      (q) => q.role === role && q.sceneId === s.sceneId,
    ),
    activeTask = s.activeTasks.find((t) => t.targetRole === role);
  const showReport = (reportId: string) => {
    setExpanded(reportId);
    setReceivedReportId(reportId);
    setTab("reports");
  };
  const askReport = async (topicId: string) => {
    setPendingTopic(topicId);
    const result = await game.command<P.TaskAccepted>("/tasks", {
      taskKind: "request_report",
      targetRole: role,
      topicId,
    });
    setPendingTopic(null);
    if (result?.task.status === "completed" && result.task.reportId)
      showReport(result.task.reportId);
  };
  useEffect(() => {
    setTab("investigate");
    setExpanded(null);
    setReceivedReportId(null);
    setTrace(null);
  }, [s.sceneId]);
  useEffect(() => {
    if (!active) {
      setTrace(null);
      setProvenance(false);
    }
  }, [active]);
  return (
    <section className="intel-panel panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">HUMAN INTELLIGENCE</span>
          <h2>{t("ui.fieldIntelligence")}</h2>
        </div>
        <button
          className="icon-button"
          aria-label={t("ui.sourceRelationships")}
          title={t("ui.sourceRelationships")}
          onClick={() => setProvenance(true)}
        >
          <Link2 size={18} />
        </button>
      </div>
      <div className="tab-bar">
        <button
          className={tab === "investigate" ? "selected" : ""}
          onClick={() => setTab("investigate")}
        >
          {" "}
          {t("ui.investigateAndContact")}{" "}
        </button>
        <button
          className={tab === "reports" ? "selected" : ""}
          onClick={() => setTab("reports")}
        >
          {" "}
          {t("ui.received")} <span>{current.length}</span>
        </button>
      </div>
      {receivedReportId && tab === "reports" && (
        <p className="report-delivery-status" role="status">
          <Check size={14} /> {t("ui.reportReceived")}
        </p>
      )}
      {tab === "investigate" ? (
        <>
          <div className="role-switch">
            {(["analyst", "liaison"] as const).map((id) => (
              <button
                className={role === id ? "selected" : ""}
                key={id}
                onClick={() => setRole(id)}
              >
                <span className="avatar">{characters[id].initials}</span>
                <span>
                  {characters[id].name}
                  <small>{characters[id].role}</small>
                </span>
                <i
                  className={
                    s.activeTasks.some((t) => t.targetRole === id)
                      ? "occupied"
                      : "available"
                  }
                />
              </button>
            ))}
          </div>
          <div className="quota-line">
            <span>{t("ui.sceneReports")}</span>
            <span>
              {quota?.used ?? 0} / 3{" "}
              <i>
                {quota?.reserved
                  ? t("quota.reserved", { count: quota.reserved })
                  : ""}
              </i>
            </span>
          </div>
          {activeTask ? (
            <div className="task-running">
              <span className="pulse-dot" />
              <div>
                <strong>
                  {activeTask.taskKind === "request_report"
                    ? t("ui.preparingTheBriefing")
                    : t("ui.investigationInProgress")}
                </strong>
                <p>{t("ui.theReportArrivesAutomaticallyWhenReadyYou")}</p>
              </div>
            </div>
          ) : null}
          <div className="investigation-scroll">
            <div className="list-label">
              {" "}
              {t("ui.existingBriefings")}{" "}
              <small>{t("ui.noChannelCost1SecToDeliver")}</small>
            </div>
            <div className="brief-topics">
              {scene?.topics
                .filter((t) =>
                  ({
                    E1: {
                      analyst: ["roads", "gate_status"],
                      liaison: ["manifest", "gate_status"],
                    },
                    E2: {
                      analyst: ["roads", "cause"],
                      liaison: ["roads", "cause"],
                    },
                    E3: {
                      analyst: ["roads", "bridge_status"],
                      liaison: ["manifest", "ford_status"],
                    },
                  })[s.sceneId!][role].includes(t.id),
                )
                .map((t) => (
                  <button
                    key={t.id}
                    disabled={
                      game.busy ||
                      !!activeTask ||
                      !(
                        s.phase === "scene" ||
                        s.activeOperation?.operationKind === "wait"
                      ) ||
                      !quota?.remaining
                    }
                    onClick={() => void askReport(t.id)}
                  >
                    {t.label}
                    {pendingTopic === t.id ? (
                      <span className="spinner" />
                    ) : (
                      <ArrowUpRight size={13} />
                    )}
                  </button>
                )) ?? (
                <p className="muted">
                  {t("ui.contactsBecomeAvailableAtTheCheckpoint")}
                </p>
              )}
            </div>
            <div className="list-label">
              {" "}
              {t("ui.furtherInvestigation")}{" "}
              <small>{t("ui.usesTheMissionAllowance")}</small>
            </div>
            {s.taskOptions
              .filter((o) => o.targetRole === role)
              .map((o) => {
                const Icon = icons[o.resourceChannel];
                const resource = s.resources.find(
                  (r) => r.channel === o.resourceChannel,
                );
                return (
                  <button
                    key={o.targetId}
                    className={`investigation-card ${!o.available ? "unavailable" : ""}`}
                    disabled={
                      game.busy ||
                      (!o.available &&
                        o.disabledReason !== "needs_report_reference")
                    }
                    onClick={() => setTrace(o)}
                  >
                    <div className="investigation-icon">
                      <Icon size={18} />
                    </div>
                    <div>
                      <strong>{o.label}</strong>
                      <span>
                        {o.investigationKind === "provenance_trace"
                          ? t("ui.traceAReceivedReportSSource")
                          : channelLabels[o.resourceChannel]}{" "}
                        ·{" "}
                        {t("ui.simulatedDuration", {
                          time: duration(o.cost.knownDurationMs),
                        })}
                      </span>
                      {!o.available && o.disabledReason && (
                        <em>{disabledLabels[o.disabledReason]}</em>
                      )}
                    </div>
                    <span className="resource-mini">
                      {resource?.remaining ?? 0}
                      <small>{t("ui.uses")}</small>
                    </span>
                  </button>
                );
              })}
            {!s.taskOptions.length && (
              <div className="empty-small">
                {" "}
                {t("ui.theConvoyIsMovingAssignInvestigationsAt")}{" "}
              </div>
            )}
          </div>
          <div className="panel-note">
            <CircleDot size={13} />
            <span>{t("ui.newFindingsCorrectionsAndTracesEachUse")}</span>
          </div>
        </>
      ) : (
        <div className="reports-scroll">
          {!current.length ? (
            <div className="empty-state">
              <Radio size={28} />
              <h3>{t("ui.waitingForTheFirstLead")}</h3>
              <p> {t("ui.requestAnExistingBriefingOrAssignAn")} </p>
              <button
                className="text-button"
                onClick={() => setTab("investigate")}
              >
                {" "}
                {t("ui.assignAnInvestigation")} <ArrowUpRight size={14} />
              </button>
            </div>
          ) : (
            current.map((r) => (
              <ReportCard
                key={r.reportId}
                report={r}
                game={game}
                active={active}
                expanded={expanded === r.reportId}
                toggle={() =>
                  setExpanded(expanded === r.reportId ? null : r.reportId)
                }
              />
            ))
          )}
          <div className="upload-meter">
            <span>{t("ui.sceneUploads")}</span>
            <strong>{s.uploadQuota?.used ?? 0} / 5</strong>
            <div>
              <i style={{ width: `${(s.uploadQuota?.used ?? 0) * 20}%` }} />
            </div>
            <small>
              {t("intel.uploadLimitNote", {
                count: s.unuploadedReportIds.filter((id) =>
                  current.some((r) => r.reportId === id),
                ).length,
              })}
            </small>
          </div>
        </div>
      )}
      {trace && (
        <InvestigationModal
          game={game}
          option={trace}
          onClose={() => setTrace(null)}
          onCompleted={showReport}
        />
      )}
      {provenance && (
        <ProvenanceModal game={game} onClose={() => setProvenance(false)} />
      )}
    </section>
  );
}
function ReportCard({
  report: r,
  game,
  active,
  expanded,
  toggle,
}: {
  report: P.ReportView;
  game: Game;
  active: boolean;
  expanded: boolean;
  toggle: () => void;
}) {
  const { t, locale, characters } = useI18n();
  const heading = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (expanded && active) {
      heading.current?.scrollIntoView({ block: "nearest" });
      heading.current?.focus({ preventScroll: true });
    }
  }, [r.reportId, expanded, active]);
  const s = game.state!,
    uploaded = s.sceneUploads.some((u) => u.reportId === r.reportId),
    ref = useVisibleReceipt(
      expanded ? r.reportId : "",
      () => void game.receipt("report_opened", { reportId: r.reportId }),
      0.55,
      active,
    );
  return (
    <article
      className={`report-card ${expanded ? "expanded" : ""}`}
      data-report-id={r.reportId}
    >
      <button ref={heading} className="report-heading" onClick={toggle}>
        <div>
          <span className="report-meta">
            {characters[r.sourceRole].name} · {r.card.sourceLabel}
          </span>
          <h3>{r.card.title}</h3>
          <span className={`freshness ${r.card.freshness}`}>
            {r.card.freshness === "historical"
              ? t("ui.historicalInformation")
              : r.card.freshness === "current"
                ? t("ui.currentObservation")
                : r.card.freshness === "superseded"
                  ? t("ui.superseded")
                  : t("ui.freshnessUnknown")}
          </span>
        </div>
        <ChevronDown size={16} className={expanded ? "rotate" : ""} />
      </button>
      {expanded && (
        <div className="report-body">
          <ReadAloudButton
            id={`report:${r.reportId}:${r.revision}`}
            text={reportNarration(r, characters[r.sourceRole].name)}
            disabled={!active}
          />
          <div ref={ref} className="report-opening">
            <p>{r.card.body}</p>
          </div>
          <dl>
            <dt>{t("ui.observationScopeLabel")}</dt>
            <dd>{r.card.observationScope}</dd>
            <dt>{t("ui.sourceVerification")}</dt>
            <dd>
              {r.card.provenanceStatus === "verified"
                ? t("ui.verified")
                : r.card.provenanceStatus === "partially_verified"
                  ? t("ui.partlyVerified")
                  : t("ui.unverified")}
            </dd>
            <dt>{t("ui.observedAt")}</dt>
            <dd>
              {r.card.observedAt
                ? new Date(r.card.observedAt).toLocaleTimeString(locale, {
                    hour12: false,
                  })
                : t("ui.notProvided")}
            </dd>
          </dl>
          <button
            className={`upload-button ${uploaded ? "uploaded" : ""}`}
            disabled={
              uploaded ||
              game.busy ||
              !s.uploadQuota?.remaining ||
              !(
                s.phase === "scene" ||
                s.activeOperation?.operationKind === "wait"
              )
            }
            onClick={() =>
              void game.command("/uploads", {
                items: [{ reportId: r.reportId, expectedRevision: r.revision }],
              })
            }
          >
            {uploaded ? (
              <>
                <Check size={14} /> {t("ui.uploadedToAI")}{" "}
              </>
            ) : (
              <>
                <Send size={14} /> {t("ui.uploadThisCard")} <span>+1 / 5</span>
              </>
            )}
          </button>
        </div>
      )}
    </article>
  );
}
