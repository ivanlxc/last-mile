import { useI18n } from "../lib/i18n";
import { useState } from "react";
import {
  Sparkles,
  Send,
  ArrowUpRight,
  FileText,
  ChevronDown,
  ShieldQuestion,
  CircleHelp,
} from "lucide-react";
import type { AdvisorOutput } from "../../../docs/engineering_v0.5/contracts/agent-derived.types";
import type { P } from "../lib/api";
import type { Game } from "../lib/useGame";
import { useVisibleReceipt } from "../lib/useVisibleReceipt";
import { Modal } from "./Modal";
export function AdvisorPanel({ game }: { game: Game }) {
  const { t } = useI18n();
  const s = game.state!,
    job = s.latestAdviceJob,
    [text, setText] = useState(""),
    [expanded, setExpanded] = useState(false),
    [source, setSource] = useState<P.ReportView | null>(null);
  const output =
    job?.result && "claims" in job.result
      ? (job.result as AdvisorOutput)
      : null;
  const current =
    job?.inputVersion === s.assistantContextVersion &&
    job?.status !== "superseded" &&
    job?.status !== "cancelled";
  const ref = useVisibleReceipt(
    output ? job!.jobId : "",
    () => void game.receipt("advice_displayed", { jobId: job!.jobId }),
  );
  const running = job?.status === "queued" || job?.status === "running";
  const ask = async (
    kind: P.QuestionRequest["payload"]["questionKind"],
    question: string | null = null,
  ) => {
    const result = await game.command("/questions", {
      questionKind: kind,
      text: question,
      expectedInboxVersion: s.inboxVersion,
      uploadBatch: [],
    });
    if (result && kind === "free_text") setText("");
  };
  const enabled =
    !!s.sceneId &&
    (s.phase === "scene" || s.activeOperation?.operationKind === "wait") &&
    !game.busy;
  return (
    <section className="advisor-panel panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">DECISION SUPPORT</span>
          <h2>
            {" "}
            {t("ui.aiAdvisor")} <span className="ai-stars">✧</span>
          </h2>
        </div>
        <span
          className={`mode-badge ${job?.mode === "live_model" || (!job && game.health?.modelConfigured) ? "live" : ""}`}
        >
          {job
            ? job.mode === "live_model"
              ? "LIVE MODEL"
              : t("ui.offlineTemplate")
            : game.health?.modelConfigured
              ? t("ui.modelConfigured")
              : t("ui.offlineTemplate")}
        </span>
      </div>
      <div className="ai-boundary">
        <FileText size={15} />
        <span>
          {t("advisor.receivedCards", { count: s.sceneUploads.length })}
        </span>
      </div>
      <div className="advisor-scroll">
        {running ? (
          <div className="thinking">
            <span className="spinner" />
            <span>
              {" "}
              {t("ui.analyzingAvailableMaterial")}
              <small>
                {t("ui.youCanKeepInvestigatingOrDecideIndependently")}
              </small>
            </span>
          </div>
        ) : null}
        {output ? (
          <div
            className={`advice-content ${!current ? "stale" : ""}`}
            ref={ref}
          >
            {!current && (
              <div className="notice-amber">
                {" "}
                {t("ui.thisAdviceUsesAnEarlierInformationOr")}{" "}
              </div>
            )}
            {job?.mode === "offline_template" && (
              <div className="template-note">
                {" "}
                {t("ui.thisOfflineTemplateOrganizesTheLimitsOf")}{" "}
              </div>
            )}
            <div className="analysis-label">
              <Sparkles size={14} />
              <span>{t("ui.evidenceAnalysis")}</span>
              <span>V{s.inboxVersion}</span>
            </div>
            <h3>{output.summary}</h3>
            <div className="advice-rationale">
              {output.recommendation.rationale}
            </div>
            {output.recommendation.actionId && (
              <div className="recommendation">
                <span>{t("ui.conditionalRecommendation")}</span>
                <strong>
                  {s.actionOptions.find(
                    (a) => a.actionId === output.recommendation.actionId,
                  )?.label ?? output.recommendation.actionId}
                </strong>
              </div>
            )}
            {output.uncertainties.length > 0 && (
              <div className="uncertainties">
                <h4>
                  <ShieldQuestion size={14} /> {t("ui.whatRemainsUnknown")}{" "}
                </h4>
                <ul>
                  {output.uncertainties.map((u, i) => (
                    <li key={i}>{u}</li>
                  ))}
                </ul>
              </div>
            )}
            {output.recommendation.conditions.length > 0 && (
              <div className="condition-list">
                <h4>{t("ui.conditionsForThisRecommendation")}</h4>
                {output.recommendation.conditions.map((c, i) => (
                  <p key={i}>{c}</p>
                ))}
              </div>
            )}
            <button
              className="text-button evidence-toggle"
              onClick={() => setExpanded(!expanded)}
            >
              {t("advisor.showBasis", { count: output.claims.length })}{" "}
              <ChevronDown size={14} className={expanded ? "rotate" : ""} />
            </button>
            {expanded &&
              output.claims.map((claim, i) => (
                <div className="claim" key={claim.claimId}>
                  <span>
                    {String(i + 1).padStart(2, "0")} /{" "}
                    {claim.kind === "inference"
                      ? t("ui.inference")
                      : claim.kind === "playerStatement"
                        ? t("ui.playerStatement")
                        : claim.kind === "backgroundRecord"
                          ? t("ui.background")
                          : t("ui.evidenceObservation")}
                  </span>
                  <p>{claim.text}</p>
                  <div className="citation-list">
                    {claim.citations.map((c, idx) => {
                      const r = s.reports.find(
                        (r) =>
                          r.evidenceInstanceId === c.refId &&
                          r.revision === c.revision,
                      );
                      return r ? (
                        <button key={idx} onClick={() => setSource(r)}>
                          <FileText size={11} />
                          {r.card.title}
                        </button>
                      ) : (
                        <span key={idx}>
                          {c.kind === "background"
                            ? t("ui.backgroundRule")
                            : c.kind === "statement"
                              ? t("ui.unverifiedStatement")
                              : t("ui.evidenceReference")}{" "}
                          · {c.refId.slice(0, 12)}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            {output.investigationSuggestions.length > 0 && (
              <div className="investigation-suggestions">
                <h4>{t("ui.questionsToPursue")}</h4>
                {output.investigationSuggestions.map((q, i) => (
                  <p key={i}>
                    <CircleHelp size={13} />
                    {q.questionToResolve}
                  </p>
                ))}
              </div>
            )}
          </div>
        ) : !running ? (
          <div className="empty-state ai-empty">
            <div className="ai-orb">
              <Sparkles size={25} />
            </div>
            <h3>{t("ui.makingSenseOfIncompleteInformation")}</h3>
            <p> {t("ui.readTheFieldReportsAndChooseWhat")} </p>
            <span>
              {" "}
              {t("ui.anEmptyInboxDoesNotMeanThere")} <br />{" "}
              {t("ui.adviceDoesNotSettleEveryQuestion")}{" "}
            </span>
          </div>
        ) : null}
      </div>
      <div className="advisor-composer">
        <div className="quick-questions">
          <button disabled={!enabled} onClick={() => void ask("explain_basis")}>
            {" "}
            {t("ui.explainTheBasis")}{" "}
          </button>
          <button
            disabled={!enabled}
            onClick={() => void ask("compare_routes")}
          >
            {" "}
            {t("ui.compareRoutes")}{" "}
          </button>
          <button disabled={!enabled} onClick={() => void ask("uncertainties")}>
            {" "}
            {t("ui.whatIsMissing")}{" "}
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && enabled) void ask("free_text", text.trim());
          }}
        >
          <textarea
            aria-label={t("ui.askTheAIAdvisor")}
            rows={2}
            maxLength={2000}
            placeholder={t("ui.askAQuestionOrShareAConstraint")}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="submit"
            disabled={!text.trim() || !enabled}
            aria-label={t("ui.sendToAI")}
          >
            <ArrowUpRight size={20} />
          </button>
        </form>
        <small>{t("ui.freeTextIsUnverifiedTimeAndResource")}</small>
      </div>
      {source && (
        <Modal title={source.card.title} onClose={() => setSource(null)}>
          <CitationReport report={source} game={game} />
        </Modal>
      )}
    </section>
  );
}

function CitationReport({
  report,
  game,
}: {
  report: P.ReportView;
  game: Game;
}) {
  const { t } = useI18n();
  const ref = useVisibleReceipt(
    report.reportId,
    () => void game.receipt("report_opened", { reportId: report.reportId }),
  );
  return (
    <div ref={ref}>
      <p className="source-name">{report.card.sourceLabel}</p>
      <p className="quoted-report">{report.card.body}</p>
      <p className="muted small-text">
        {" "}
        {t("ui.observationScope")}
        {report.card.observationScope}
      </p>
    </div>
  );
}
