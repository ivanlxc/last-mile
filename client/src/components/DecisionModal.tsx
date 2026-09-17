import { useI18n } from "../lib/i18n";
import { useState } from "react";
import { ArrowRight, Clock3, ChevronDown, AlertCircle } from "lucide-react";
import type { P } from "../lib/api";
import type { Game } from "../lib/useGame";
import { timer } from "../lib/narrative";
import { Modal } from "./Modal";
export function DecisionModal({
  game,
  action,
  onClose,
}: {
  game: Game;
  action: P.ActionOption;
  onClose: () => void;
}) {
  const { t, duration, reasonLabels } = useI18n();
  const s = game.state!,
    wait = action.actionId === "WAIT";
  const [reason, setReason] = useState(""),
    [annotate, setAnnotate] = useState(false),
    [codes, setCodes] = useState<P.ReasonAnnotation["reasonCodes"][number][]>(
      [],
    ),
    [limitation, setLimitation] = useState(false),
    [costs, setCosts] = useState(false),
    [question, setQuestion] = useState(""),
    [based, setBased] = useState(false),
    [refs, setRefs] = useState<string[]>([]),
    [cancel, setCancel] = useState(false),
    [waitMs, setWaitMs] = useState(15000);
  const pending = s.activeTasks.length > 0 && !wait;
  const advice = s.latestAdviceJob;
  const validAdvice =
    advice?.result &&
    advice.inputVersion === s.assistantContextVersion &&
    !["superseded", "cancelled"].includes(advice.status);
  const submit = async () => {
    const changed = codes.length > 0 || limitation || costs || !!question;
    const result = await game.command("/actions", {
      actionId: action.actionId,
      waitDurationMs: wait ? waitMs : null,
      reason,
      reasonAnnotation: changed
        ? {
            reasonCodes: codes,
            acknowledgedLimitation: limitation,
            comparedKnownCosts: costs,
            declaredQuestionKey: question || null,
          }
        : null,
      basedOnAdviceJobId: based && validAdvice ? advice.jobId : null,
      referencedReportIds: refs,
      cancelPendingInvestigations: pending ? cancel : false,
    });
    if (result) onClose();
  };
  return (
    <Modal
      title={wait ? t("ui.stayHereAndKeepCoordinating") : action.label}
      onClose={onClose}
    >
      <div className="decision-cost">
        <Clock3 size={18} />
        <div>
          <span>{t("ui.knownEstimatedTime")}</span>
          <strong>
            {wait ? duration(waitMs) : duration(action.cost.knownDurationMs)}
          </strong>
        </div>
        <div>
          <span>{t("ui.escortWindowRemaining")}</span>
          <strong>{timer(s.missionDeadlineMs - s.missionTimeMs)}</strong>
        </div>
      </div>
      <p className="decision-risk">{action.knownRisk}</p>
      {action.irreversibleNotice && (
        <p className="muted small-text">{action.irreversibleNotice}</p>
      )}
      {wait && (
        <div className="wait-options">
          {[15000, 30000, 60000].map((ms) => (
            <button
              key={ms}
              onClick={() => setWaitMs(ms)}
              className={waitMs === ms ? "selected" : ""}
            >
              {duration(ms)}
            </button>
          ))}
        </div>
      )}
      <label className="field-label" htmlFor="reason">
        {" "}
        {t("ui.whyAreYouChoosingThisNow")} <small>{t("ui.optional")}</small>
      </label>
      <textarea
        id="reason"
        maxLength={1000}
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t("ui.noteYourMainEvidenceAnUnresolvedQuestion")}
      />
      {validAdvice && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={based}
            onChange={(e) => setBased(e.target.checked)}
          />{" "}
          {t("ui.iConsideredTheCurrentAIAnalysis")}{" "}
        </label>
      )}
      <details
        className="decision-details"
        open={annotate}
        onToggle={(e) => setAnnotate(e.currentTarget.open)}
      >
        <summary>
          {" "}
          {t("ui.addDecisionContext")}{" "}
          <small>{t("ui.optionalForTheReview")}</small>
          <ChevronDown size={14} />
        </summary>
        <div className="reason-chips">
          {Object.entries(reasonLabels).map(([key, label]) => (
            <button
              className={
                codes.includes(key as (typeof codes)[number]) ? "selected" : ""
              }
              key={key}
              onClick={() =>
                setCodes((c) =>
                  c.includes(key as (typeof codes)[number])
                    ? c.filter((x) => x !== key)
                    : [
                        ...c.filter(
                          (x) =>
                            !(
                              key === "new_question" && x === "no_new_question"
                            ) &&
                            !(
                              key === "no_new_question" && x === "new_question"
                            ),
                        ),
                        key as (typeof codes)[number],
                      ],
                )
              }
            >
              {label}
            </button>
          ))}
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={limitation}
            onChange={(e) => setLimitation(e.target.checked)}
          />{" "}
          {t("ui.iConsideredTheLimitsOfTheInformation")}{" "}
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={costs}
            onChange={(e) => setCosts(e.target.checked)}
          />{" "}
          {t("ui.iComparedTheKnownTimeCosts")}{" "}
        </label>
        <label className="field-label" htmlFor="new-question">
          {" "}
          {t("ui.aQuestionStillUnresolved")}{" "}
        </label>
        <input
          id="new-question"
          maxLength={100}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t("ui.forExampleIsOurVehicleClearanceStill")}
        />
        {s.reports.filter((r) => r.sceneId === s.sceneId).length > 0 && (
          <>
            <span className="field-label">{t("ui.reportsReferenced")}</span>
            {s.reports
              .filter((r) => r.sceneId === s.sceneId)
              .map((r) => (
                <label className="checkbox-row" key={r.reportId}>
                  <input
                    type="checkbox"
                    checked={refs.includes(r.reportId)}
                    onChange={() =>
                      setRefs((ids) =>
                        ids.includes(r.reportId)
                          ? ids.filter((id) => id !== r.reportId)
                          : [...ids, r.reportId],
                      )
                    }
                  />
                  {r.card.title}
                </label>
              ))}
          </>
        )}
      </details>
      {pending && (
        <label className="checkbox-row cancellation">
          <input
            type="checkbox"
            checked={cancel}
            onChange={(e) => setCancel(e.target.checked)}
          />
          <span>
            {t("decision.cancelPending", { count: s.activeTasks.length })}
          </span>
        </label>
      )}
      <div className="decision-submit">
        <span>
          <AlertCircle size={13} /> {t("ui.theClockKeepsRunning")}{" "}
        </span>
        <button
          className="primary"
          disabled={
            game.busy ||
            (pending && !cancel) ||
            !s.actionOptions.find((a) => a.actionId === action.actionId)
              ?.available
          }
          onClick={() => void submit()}
        >
          {game.busy ? t("ui.issuingOrder") : t("ui.confirmAction")}
          <ArrowRight size={17} />
        </button>
      </div>
    </Modal>
  );
}
