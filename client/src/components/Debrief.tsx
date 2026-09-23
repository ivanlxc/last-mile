import { ArrivalScene } from "./ArrivalScene";
import { useI18n, formatError } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Clock3,
  Download,
  FileText,
  Flag,
  RotateCcw,
  Sparkles,
  Users,
  ChevronDown,
} from "lucide-react";
import type { Game } from "../lib/useGame";
import { get, post, sessionPath, type P } from "../lib/api";
import type { EvaluatorOutput } from "../../../docs/engineering_v0.5/contracts/agent-derived.types";
import { timer } from "../lib/narrative";
import { Brand } from "./Landing";
import { Map2D } from "./TacticalMap";
import { AtmosphereControl } from "./AtmosphereControl";
export function Debrief({ game }: { game: Game }) {
  const { t, locale, scenes, dimensionLabels, supportLabels, campaign } =
    useI18n();
  const actionNames: Record<string, string> = {
    E1_MAIN: t("ui.registerAtTheMainGate"),
    E1_BYPASS: t("ui.takeTheSouthServiceRoad"),
    E2_MAIN: t("ui.takeTheMarketMainRoad"),
    E2_BYPASS: t("ui.takeTheConnectorToTheBridge"),
    E3_BRIDGE: t("ui.requestPassageOverTheMainBridge"),
    E3_FORD: t("ui.useTheOldRiverbedAndTransferArea"),
    WAIT: t("ui.waitHere"),
  };

  const s = game.state!,
    [outcome, setOutcome] = useState<P.OutcomeView | null>(null),
    [replay, setReplay] = useState<P.ReplayView | null>(null),
    [evaluation, setEvaluation] = useState<P.EvaluationJobView | null>(null),
    [tab, setTab] = useState<"review" | "decisions">("review"),
    [localError, setLocalError] = useState(""),
    [exporting, setExporting] = useState(false);
  const evaluationRequest = useRef<{
    hash: string;
    promise: Promise<P.EvaluationAccepted>;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [o, r] = await Promise.all([
          get<P.OutcomeView>(sessionPath(s.sessionId, "/outcome")),
          get<P.ReplayView>(sessionPath(s.sessionId, "/replay")),
        ]);
        if (!alive) return;
        setOutcome(o);
        setReplay(r);
        if (evaluationRequest.current?.hash !== o.sealedHash)
          evaluationRequest.current = {
            hash: o.sealedHash,
            promise: post<P.EvaluationAccepted>(
              sessionPath(s.sessionId, "/evaluations"),
              {
                sealedHash: o.sealedHash,
                evaluationConfigId: "EVALUATION_REFERENCE_V1",
              },
              s.runEpoch,
            ),
          };
        const e = await evaluationRequest.current.promise;
        if (alive) setEvaluation(e.job);
      } catch (e) {
        if (alive) setLocalError(formatError(e, locale));
      }
    })();
    return () => {
      alive = false;
    };
  }, [s.sessionId, s.runEpoch]);
  useEffect(() => {
    if (!evaluation || !["queued", "running"].includes(evaluation.status))
      return;
    let alive = true;
    const id = setInterval(() => {
      void get<P.EvaluationJobView>(
        sessionPath(s.sessionId, `/evaluations/${evaluation.jobId}`),
      )
        .then((e) => {
          if (alive) setEvaluation(e);
        })
        .catch((e) => {
          if (alive) setLocalError(formatError(e, locale));
        });
    }, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [evaluation?.jobId, evaluation?.status, s.sessionId]);
  const analysis =
    evaluation?.result && "dimensions" in evaluation.result
      ? (evaluation.result as EvaluatorOutput)
      : null;
  const download = async () => {
    if (!outcome) return;
    setExporting(true);
    setLocalError("");
    try {
      const r = await post<P.ExportAccepted>(
        sessionPath(s.sessionId, "/exports"),
        {
          sealedHash: outcome.sealedHash,
          format: "last-mile-review-json",
          includePlayerStatements: true,
        },
        s.runEpoch,
      );
      let view = r.export;
      for (
        let i = 0;
        i < 20 && ["queued", "running"].includes(view.status);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 400));
        view = await get<P.ExportView>(
          sessionPath(s.sessionId, `/exports/${view.exportId}`),
        );
      }
      if (!view.artifact) throw Error(t("ui.theExportIsNotReadyYetPlease"));
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(view.artifact, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `LAST_MILE_${s.sessionId.slice(0, 8)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setLocalError(formatError(e, locale));
    } finally {
      setExporting(false);
    }
  };
  const ending = outcome?.terminationReason;
  const title = outcome?.taskSuccess
    ? t("ui.theLastMileArrivalConfirmed")
    : ending === "mission_deadline"
      ? t("ui.theWindowHasClosed")
      : ending === "technical_interruption"
        ? t("ui.aTechnicalInterruptionEndedTheEscort")
        : t("ui.thisEscortEndsHere");
  return (
    <main className="debrief page-shell">
      <header className="page-header">
        <Brand />
        <span className="eyebrow">{t("ui.afterACTIONREVIEW")}</span>
        <AtmosphereControl />
        <button className="text-button" onClick={game.home}>
          {" "}
          {t("ui.backToTitle")} <ArrowUpRight size={15} />
        </button>
      </header>
      {outcome && <ArrivalScene outcome={outcome} />}
      <section className="ending-banner">
        <div className="ending-copy">
          <div className="overline">
            {outcome?.taskSuccess
              ? "MISSION ARRIVAL CONFIRMED"
              : "MISSION RECORD SEALED"}
          </div>
          <h1>{outcome ? title : t("ui.savingYourMissionRecord")}</h1>
          <p>
            {outcome?.summary ??
              t("ui.loadingTheMissionRecordAndDecisionContext")}
          </p>
          {outcome?.taskSuccess && (
            <p className="ending-quote">{campaign.closing}</p>
          )}
          <div className="ending-stats">
            <span>
              <Users size={17} />
              <b>20</b> {t("ui.civilians")}{" "}
            </span>
            <span>
              <Clock3 size={17} />
              <b>
                {timer(
                  outcome?.playerElapsedMs ??
                    s.playerElapsedMs ??
                    outcome?.sealedAtMissionMs ??
                    s.missionTimeMs,
                )}
              </b>{" "}
              {t("ui.playTime")}{" "}
            </span>
            <span>
              <Flag size={17} />
              <b>
                {outcome?.handoffCompletedAtMissionMs !== null &&
                outcome?.handoffCompletedAtMissionMs !== undefined
                  ? t("ui.complete")
                  : t("ui.pending")}
              </b>{" "}
              {t("ui.handoff")}{" "}
            </span>
          </div>
          {s.actionTiming === "instant" && (
            <p className="muted small-text">
              {t("ui.simulatedMissionTime")}:{" "}
              {timer(outcome?.sealedAtMissionMs ?? s.missionTimeMs)}
            </p>
          )}
        </div>
        <div className="ending-map">
          <Map2D
            location={outcome?.finalLocation ?? s.location}
            sceneId={s.sceneId}
          />
        </div>
      </section>
      <div className="review-toolbar">
        <div className="tab-bar">
          <button
            className={tab === "review" ? "selected" : ""}
            onClick={() => setTab("review")}
          >
            {" "}
            {t("ui.trustAndJudgment")}{" "}
          </button>
          <button
            className={tab === "decisions" ? "selected" : ""}
            onClick={() => setTab("decisions")}
          >
            {" "}
            {t("ui.decisionReplay")}{" "}
            <span>{replay?.decisions.length ?? 0}</span>
          </button>
        </div>
        <button
          className="secondary small"
          disabled={!outcome || exporting}
          onClick={() => void download()}
        >
          <Download size={14} />
          {exporting ? t("ui.exporting") : t("ui.exportFullReview")}
        </button>
      </div>
      {localError && (
        <div className="notice-amber" role="alert">
          {localError}
        </div>
      )}
      {tab === "review" ? (
        <section className="evaluation-section">
          <div className="evaluation-heading">
            <div>
              <span className="eyebrow">HOW YOU USED WHAT YOU KNEW</span>
              <h2>{t("ui.understandingYourDecisions")}</h2>
            </div>
            <span className="mode-badge">
              {evaluation?.mode === "live_model"
                ? t("ui.independentAIReview")
                : t("ui.ruleBasedReview")}
            </span>
          </div>
          <p className="evaluation-summary">
            {analysis?.summary ??
              t("ui.buildingAReviewFromTheInformationVisible")}
          </p>
          {analysis ? (
            <>
              <div className="dimension-grid">
                {Object.entries(analysis.dimensions).map(([key, d], i) => (
                  <article
                    className={`dimension ${key === "calibratedTrust" ? "calibrated" : ""}`}
                    key={key}
                  >
                    <span className="dimension-number">0{i + 1}</span>
                    <h3>
                      {dimensionLabels[key as keyof typeof dimensionLabels]}
                    </h3>
                    <span className={`support-tag ${d.supportLevel}`}>
                      {supportLabels[d.supportLevel]}
                    </span>
                    <p>{d.explanation}</p>
                    <div className="dimension-foot">
                      <span>{t("ui.assessableContexts")}</span>
                      <b>{d.eligibleOpportunities}</b>
                    </div>
                    <details>
                      <summary>
                        {" "}
                        {t("ui.evidenceAndLimits")} <ChevronDown size={12} />
                      </summary>
                      <p>
                        {t("review.supportCounts", {
                          contexts: d.supportContextRefs.length,
                          facts: d.supportFactRefs.length,
                        })}
                      </p>
                      {d.uncertainties.map((u, j) => (
                        <p key={j}>{u}</p>
                      ))}
                    </details>
                  </article>
                ))}
              </div>
              <div className="review-bottom">
                <div>
                  <span className="eyebrow">NEXT TIME</span>
                  <h3>{t("ui.somethingToTryNextTime")}</h3>
                  {analysis.nextAttempts.length ? (
                    analysis.nextAttempts.map((n, i) => (
                      <p key={i}>
                        <ArrowRight size={14} />
                        {n.suggestion}
                      </p>
                    ))
                  ) : (
                    <p> {t("ui.recordASpecificReasonForEachChoice")} </p>
                  )}
                </div>
                <div className="review-limits">
                  <span className="eyebrow">READING THIS REVIEW</span>
                  <p> {t("ui.theseAreObservationsFromThisSessionNot")} </p>
                  {analysis.limitations.slice(0, 3).map((l, i) => (
                    <p key={i}>{l}</p>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="review-pending">
              <span className="spinner" />
              <p>
                {evaluation?.status === "failed"
                  ? t("ui.theReviewCouldNotBeGeneratedYou")
                  : t("ui.preparingTheReview")}
              </p>
            </div>
          )}
        </section>
      ) : (
        <section className="replay-section">
          <div className="timeline">
            {s.actionTiming === "instant" && (
              <p className="muted small-text">{t("ui.simulatedMissionTime")}</p>
            )}
            {replay?.decisions.length ? (
              replay.decisions.map((d, i) => (
                <article className="timeline-card" key={d.decisionId}>
                  <div className="timeline-marker">
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <div className="timeline-detail">
                    <div className="timeline-top">
                      <span>{scenes[d.sceneId].title}</span>
                      <time>T + {timer(d.committedAtMissionMs)}</time>
                    </div>
                    <h3>
                      {actionNames[d.actionId] ??
                        (d.actionId.startsWith("CHECK.")
                          ? t("review.investigation") +
                            (replay.reports.find(
                              (r) =>
                                r.card.definitionId ===
                                d.actionId.slice(6).replace(/\.trace$/, ""),
                            )
                              ? " · " +
                                replay.reports.find(
                                  (r) =>
                                    r.card.definitionId ===
                                    d.actionId.slice(6).replace(/\.trace$/, ""),
                                )!.card.title
                              : "")
                          : t("ui.fieldAction"))}
                    </h3>
                    <p>
                      {d.reason || t("ui.noSelfReportedReasonWasRecordedFor")}
                    </p>
                    <div className="timeline-counts">
                      <span>
                        {t("review.knownReports", {
                          count: d.knownReportIds.length,
                        })}
                      </span>
                      <span>
                        {t("review.uploadedReports", {
                          count: d.uploadedIds.length,
                        })}
                      </span>
                      <span>
                        {t("review.displayedAdvice", {
                          count: d.displayedAdviceJobIds.length,
                        })}
                      </span>
                    </div>
                    <blockquote>
                      {d.resultSummary || t("ui.seeTheMissionLogBelowForThe")}
                    </blockquote>
                    <details>
                      <summary>
                        {" "}
                        {t("ui.informationAvailableAtTheTime")}{" "}
                        <ChevronDown size={13} />
                      </summary>
                      {d.knownReportIds.map((id) => {
                        const r = replay.reports.find((r) => r.reportId === id);
                        return r ? (
                          <div className="replay-report" key={id}>
                            <strong>{r.card.title}</strong>
                            <p>{r.card.body}</p>
                          </div>
                        ) : null;
                      })}
                    </details>
                  </div>
                </article>
              ))
            ) : (
              <div className="empty-state">
                <FileText size={25} />
                <h3>{t("ui.noRouteDecisionWasMade")}</h3>
                <p>{t("ui.thisRecordCannotSupportACompleteAccount")}</p>
              </div>
            )}
          </div>
          <aside className="replay-log">
            <span className="eyebrow">MISSION LOG</span>
            <h3>{t("ui.missionLog")}</h3>
            {s.actionTiming === "instant" && (
              <p className="muted small-text">{t("ui.simulatedMissionTime")}</p>
            )}
            {replay?.publicLog.map((l) => (
              <div key={l.logId}>
                <time>{timer(l.missionTimeMs)}</time>
                <p>{l.summary}</p>
              </div>
            ))}
          </aside>
        </section>
      )}
      <footer className="debrief-footer">
        <p>{t("ui.conditionsMayChangeNextTimeTakeThe")}</p>
        <button
          className="primary"
          disabled={game.busy}
          onClick={() => void game.create()}
        >
          {" "}
          {t("ui.startAnotherEscort")} <RotateCcw size={16} />
        </button>
      </footer>
    </main>
  );
}
