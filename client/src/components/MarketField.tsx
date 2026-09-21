import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowLeft, Radio, ScanLine, Sparkles, MapPin } from "lucide-react";
import type { Game } from "../lib/useGame";
import type { P } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { FIELD_STATIONS, marketCopy, type StationId } from "../lib/marketField";
import { Modal } from "./Modal";
import { InvestigationModal } from "./InvestigationModal";
import { ReportCard } from "./IntelPanel";
import "./market-field.css";

const MarketViewport = lazy(() => import("./MarketViewport"));
export default function MarketField({
  game,
  blocked,
  onMap,
  onTablet,
}: {
  game: Game;
  blocked: boolean;
  onMap: () => void;
  onTablet: (panel: "intel" | "advisor") => void;
}) {
  const { locale, duration, channelLabels } = useI18n();
  const chinese = locale === "zh-CN",
    copy = marketCopy(chinese),
    s = game.state!;
  const [station, setStation] = useState<StationId | null>(null);
  const [investigation, setInvestigation] = useState<P.TaskOption | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const lastTrigger = useRef<HTMLElement | null>(null);
  const locked = blocked || s.phase !== "scene";
  const open = (id: StationId) => {
    if (locked) return;
    lastTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setStation(id);
    setReportId(null);
  };
  const close = () => {
    setStation(null);
    setInvestigation(null);
    setReportId(null);
    lastTrigger.current?.focus();
  };
  useEffect(() => {
    if (locked) {
      setStation(null);
      setInvestigation(null);
    }
  }, [locked]);
  const role =
    station === "noah" ? "analyst" : station === "samira" ? "liaison" : null;
  const quota = s.reportQuotas.find(
    (q) => q.role === role && q.sceneId === s.sceneId,
  );
  const reports = s.reports.filter(
    (r) =>
      r.sceneId === s.sceneId &&
      (role ? r.sourceRole === role : r.reportId === reportId),
  );
  async function requestBrief(topicId: "roads" | "cause") {
    if (!role || inFlight.current || locked) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      const result = await game.command<P.TaskAccepted>("/tasks", {
        taskKind: "request_report",
        targetRole: role,
        topicId,
      });
      if (result?.task.status === "completed" && result.task.reportId)
        setReportId(result.task.reportId);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }
  function tablet(panel: "intel" | "advisor") {
    close();
    onTablet(panel);
  }
  return (
    <section
      className="market-field"
      data-testid="market-field"
      aria-label={copy.title}
    >
      <Suspense
        fallback={<div className="market-fallback">{copy.loading}</div>}
      >
        <MarketViewport
          chinese={chinese}
          blocked={locked || !!station || !!investigation}
          onInteract={open}
        />
      </Suspense>
      <div className="market-heading">
        <span className="eyebrow">{copy.subtitle}</span>
        <h2>{copy.title}</h2>
        <p>{copy.objective}</p>
      </div>
      <button className="market-map-button" onClick={onMap}>
        <ArrowLeft size={15} />
        {copy.map}
      </button>
      <nav className="market-stations" aria-label={copy.stations}>
        <span>
          <MapPin size={13} />
          {copy.stations}
        </span>
        {FIELD_STATIONS.map(({ id }, i) => (
          <button
            key={id}
            disabled={locked}
            data-testid={`station-${id}`}
            onClick={() => open(id)}
          >
            <small>0{i + 1}</small>
            {copy[id]}
          </button>
        ))}
      </nav>
      <span className="market-scope">{copy.environment}</span>
      {station && !investigation && (
        <Modal title={copy[station]} onClose={close} wide>
          <p>{copy[`${station}Intro`]}</p>
          {role && (
            <>
              <div className="field-budget">
                <Radio size={17} />
                <span>{copy.reportSlots}</span>
                <strong>{quota?.remaining ?? 0} / 3</strong>
              </div>
              <p className="muted">{copy.allowance}</p>
              <div className="field-brief-actions">
                {(["roads", "cause"] as const).map((topic) => (
                  <button
                    className="secondary"
                    key={topic}
                    data-testid={`field-brief-${topic}`}
                    disabled={
                      submitting ||
                      game.busy ||
                      !quota?.remaining ||
                      s.activeTasks.some((t) => t.targetRole === role)
                    }
                    onClick={() => void requestBrief(topic)}
                  >
                    {copy[topic]}
                  </button>
                ))}
              </div>
              {!quota?.remaining && <p>{copy.exhausted}</p>}
            </>
          )}
          {station === "recon" && !reportId && (
            <div className="field-recon-list">
              {s.taskOptions.map((option) => (
                <button
                  className="secondary"
                  key={option.targetId}
                  data-testid={`field-investigation-${option.investigationKind}`}
                  disabled={
                    game.busy ||
                    (!option.available &&
                      option.disabledReason !== "needs_report_reference")
                  }
                  onClick={() => setInvestigation(option)}
                >
                  <ScanLine size={18} />
                  <span>
                    <strong>{option.label}</strong>
                    <small>
                      {channelLabels[option.resourceChannel]} ·{" "}
                      {duration(option.cost.knownDurationMs)} ·{" "}
                      {s.resources.find(
                        (r) => r.channel === option.resourceChannel,
                      )?.remaining ?? 0}{" "}
                      {chinese ? "次剩余" : "remaining"}
                      {!option.available &&
                      option.disabledReason !== "needs_report_reference"
                        ? ` · ${copy.unavailable}`
                        : ""}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          )}
          {station === "command" ? (
            <div className="field-command-actions">
              <button className="primary" onClick={() => tablet("advisor")}>
                <Sparkles size={16} />
                {copy.advisor}
              </button>
              <button className="secondary" onClick={() => tablet("intel")}>
                {copy.intel}
              </button>
              <button className="secondary" onClick={onMap}>
                {copy.routes}
              </button>
            </div>
          ) : (
            <>
              <div className="field-report-list">
                <h3>{copy.received}</h3>
                {reportId && (
                  <p className="field-received" role="status">
                    {copy.report}
                  </p>
                )}
                {reports.map((r) => (
                  <ReportCard
                    key={r.reportId}
                    report={r}
                    game={game}
                    active={!locked}
                    expanded={r.reportId === reportId}
                    toggle={() =>
                      setReportId((current) =>
                        current === r.reportId ? null : r.reportId,
                      )
                    }
                  />
                ))}
                {!reports.length && <p className="muted">{copy.none}</p>}
              </div>
              <p className="muted">{copy.confirmed}</p>
              <div className="field-command-actions">
                <button className="secondary" onClick={() => tablet("advisor")}>
                  {copy.advisor}
                </button>
                <button className="secondary" onClick={close}>
                  {copy.close}
                </button>
              </div>
            </>
          )}
          {game.error && (
            <p className="command-inline-error" role="alert">
              {game.error}
            </p>
          )}
        </Modal>
      )}
      {investigation && (
        <InvestigationModal
          game={game}
          option={investigation}
          onClose={() => setInvestigation(null)}
          onCompleted={(id) => {
            setReportId(id);
          }}
        />
      )}
    </section>
  );
}
