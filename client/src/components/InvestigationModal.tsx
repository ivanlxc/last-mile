import { useI18n } from "../lib/i18n";
import { useState } from "react";
import { ArrowRight, Clock3 } from "lucide-react";
import type { P } from "../lib/api";
import type { Game } from "../lib/useGame";

import { Modal } from "./Modal";
export function InvestigationModal({
  game,
  option,
  onClose,
  onCompleted,
}: {
  game: Game;
  option: P.TaskOption;
  onClose: () => void;
  onCompleted: (reportId: string) => void;
}) {
  const { t, duration, characters, channelLabels, channelScope } = useI18n();
  const questions = [
    ["gate_registration", t("ui.isTheCurrentRegistrationSystemWorking")],
    ["bridge_permission", t("ui.areOurVehiclesClearedToPass")],
    ["market_lane", t("ui.isTheMarketLaneCurrentlyPassable")],
    ["gate_activity", t("ui.whatActivityIsVisibleAroundTheGate")],
    ["ford_lane", t("ui.whatRoadConditionsAreVisibleInThe")],
    ["source_chain", t("ui.whatIsTheOriginalSourceOfThis")],
    ["explosion_cause", t("ui.whatCausedTheLoudBang")],
    ["hostile_intent", t("ui.canWeEstablishHostileIntent")],
  ];

  const s = game.state!,
    trace = option.investigationKind === "provenance_trace";
  const [source, setSource] = useState(""),
    [question, setQuestion] = useState(""),
    [limitation, setLimitation] = useState(false),
    [costs, setCosts] = useState(false),
    [submitted, setSubmitted] = useState(false);
  const submit = async () => {
    setSubmitted(true);
    const changed = question || limitation || costs;
    const r = await game.command<P.TaskAccepted>("/tasks", {
      taskKind: "investigate_and_report",
      targetRole: option.targetRole,
      topicId: option.topicId,
      targetId: option.targetId,
      investigationKind: option.investigationKind,
      sourceReportId: trace ? source : null,
      reasonAnnotation: changed
        ? {
            reasonCodes:
              question === "no_new_question"
                ? ["no_new_question"]
                : question
                  ? ["new_question"]
                  : [],
            acknowledgedLimitation: limitation,
            comparedKnownCosts: costs,
            declaredQuestionKey:
              question && question !== "no_new_question" ? question : null,
          }
        : null,
    });
    if (r) {
      if (r.task.status === "completed" && r.task.reportId)
        onCompleted(r.task.reportId);
      onClose();
    }
  };
  return (
    <Modal title={option.label} onClose={onClose}>
      <div className="decision-cost">
        <Clock3 size={18} />
        <div>
          <span>{t("ui.investigationTime")}</span>
          <strong>{duration(option.cost.knownDurationMs)}</strong>
        </div>
        <div>
          <span>
            {t("investigation.balance", {
              channel: channelLabels[option.resourceChannel],
            })}
          </span>
          <strong>
            {s.resources.find((r) => r.channel === option.resourceChannel)
              ?.remaining ?? 0}{" "}
            {t("ui.uses")}{" "}
          </strong>
        </div>
      </div>
      <p>
        {t("investigation.costNote", {
          channel: channelLabels[option.resourceChannel],
          name: characters[option.targetRole].name,
        })}
      </p>
      <div className="channel-scope">
        <strong>{t("ui.whatThisChannelCanEstablish")}</strong>
        <p>{channelScope(option.resourceChannel)}</p>
      </div>
      {trace && (
        <>
          <label className="field-label" htmlFor="trace-source">
            {" "}
            {t("ui.whichReportShouldBeTraced")}{" "}
          </label>
          <select
            id="trace-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">{t("ui.selectAReceivedReport")}</option>
            {s.reports
              .filter(
                (r) =>
                  r.sceneId === s.sceneId && r.sourceRole === option.targetRole,
              )
              .map((r) => (
                <option key={r.reportId} value={r.reportId}>
                  {r.card.title}
                </option>
              ))}
          </select>
        </>
      )}
      <label className="field-label" htmlFor="investigation-question">
        {" "}
        {t("ui.theQuestionYouWantToResolve")}{" "}
        <small>{t("ui.optionalForTheReview")}</small>
      </label>
      <select
        id="investigation-question"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
      >
        <option value="">{t("ui.leaveUnrecorded")}</option>
        {questions.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
        <option value="no_new_question">
          {t("ui.noNewQuestionIWantToCheck")}
        </option>
      </select>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={limitation}
          onChange={(e) => setLimitation(e.target.checked)}
        />{" "}
        {t("ui.iConsideredThisChannelSObservationLimits")}{" "}
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={costs}
          onChange={(e) => setCosts(e.target.checked)}
        />{" "}
        {t("ui.iComparedInvestigatingWithTheTimeNeeded")}{" "}
      </label>
      <div className="decision-submit">
        <span>{t("ui.clockRunningAllowancesCoverTheWholeMission")}</span>
        <button
          className="primary"
          disabled={
            game.busy ||
            (trace && !source) ||
            !s.taskOptions.some(
              (t) =>
                t.targetId === option.targetId &&
                (t.available || t.disabledReason === "needs_report_reference"),
            )
          }
          onClick={() => void submit()}
        >
          {" "}
          {game.busy
            ? t("ui.preparingTheBriefing")
            : t("ui.startInvestigation")}
          <ArrowRight size={16} />
        </button>
      </div>
      {submitted && game.error && (
        <p className="command-inline-error" role="alert">
          {game.error}
        </p>
      )}
    </Modal>
  );
}
