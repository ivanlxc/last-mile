import { useI18n } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  Clock3,
  Users,
  Radio,
  HeartPulse,
  HelpCircle,
  LogOut,
  Route,
  Flag,
  Satellite,
  ScanLine,
  Building2,
  MessageCircle,
  ChevronRight,
} from "lucide-react";
import type { Game } from "../lib/useGame";
import type { P } from "../lib/api";
import { timer } from "../lib/narrative";
import { Brand } from "./Landing";
import { TacticalMap } from "./TacticalMap";
import { IntelPanel } from "./IntelPanel";
import { AdvisorPanel } from "./AdvisorPanel";
import { DecisionModal } from "./DecisionModal";
import { Modal } from "./Modal";
import { ContextModal } from "./ContextModal";
import { InvestigationModal } from "./InvestigationModal";
import { mapRendererCopy } from "../lib/mapRendererCopy";
const icons = {
  satellite: Satellite,
  drone: ScanLine,
  localAgency: Building2,
  witness: MessageCircle,
};
export function GameView({
  game,
  onGuide,
}: {
  game: Game;
  onGuide: () => void;
}) {
  const { t, locale, scenes, channelLabels, duration } = useI18n();
  const s = game.state!,
    scene = s.sceneId ? scenes[s.sceneId] : null;
  const [decision, setDecision] = useState<P.ActionOption | null>(null),
    [exit, setExit] = useState(false),
    [showScene, setShowScene] = useState(false),
    [context, setContext] = useState(false);
  const [displayClock, setDisplayClock] = useState(s.missionTimeMs);
  const [mapInvestigations, setMapInvestigations] = useState(false);
  const [mapInvestigationId, setMapInvestigationId] = useState<string | null>(
    null,
  );
  const mapInvestigation = s.taskOptions.find(
    (option) => option.targetId === mapInvestigationId,
  );
  const mapCopy = mapRendererCopy(locale);
  const sample = useRef({ mission: s.missionTimeMs, at: performance.now() });
  useEffect(() => {
    sample.current = { mission: s.missionTimeMs, at: performance.now() };
    setDisplayClock(s.missionTimeMs);
  }, [s.missionTimeMs]);
  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden)
        setDisplayClock(
          Math.min(
            s.missionDeadlineMs,
            sample.current.mission +
              Math.min(1800, performance.now() - sample.current.at),
          ),
        );
    }, 200);
    return () => clearInterval(interval);
  }, [s.missionDeadlineMs]);
  const remaining = s.missionDeadlineMs - displayClock;
  const travelling =
    s.phase === "resolving" && s.activeOperation?.operationKind !== "wait";
  const previousScene = useRef(s.sceneId);
  useEffect(() => {
    if (s.sceneId !== previousScene.current) {
      setDecision(null);
      setMapInvestigations(false);
      setMapInvestigationId(null);
      previousScene.current = s.sceneId;
    }
  }, [s.sceneId]);
  const choices = s.actionOptions.filter((a) => a.kind === "route");
  const waiting = s.activeOperation?.operationKind === "wait";
  return (
    <main className="command-center">
      <header className="command-header">
        <Brand small />
        <span className="session-language" title={t("language.fixed")}>
          {locale === "en-US" ? "EN" : "中文"}
        </span>
        <nav className="chapter-nav" aria-label={t("ui.chapterProgress")}>
          {Object.entries(scenes).map(([id, c], i) => (
            <div
              className={
                s.sceneId === id
                  ? "current"
                  : s.sceneId && Number(s.sceneId.slice(1)) > i + 1
                    ? "past"
                    : ""
              }
              key={id}
            >
              <b>{c.number}</b>
              <span>
                {i === 0
                  ? t("ui.westGate")
                  : i === 1
                    ? t("ui.market")
                    : t("ui.mainBridge")}
              </span>
              {i < 2 && <ChevronRight size={12} />}
            </div>
          ))}
        </nav>
        <div className="command-hud">
          <div className="civilian-hud">
            <Users size={17} />
            <strong>20</strong>
            <span>{t("ui.civilians")}</span>
          </div>
          <div
            className={`medical-hud ${s.medical.status !== "stable" ? "warning" : ""}`}
            title={s.medical.note}
          >
            <HeartPulse size={17} />
            <span>
              {s.medical.status === "stable"
                ? t("ui.stable")
                : t("ui.priorityTransferNeeded")}
            </span>
          </div>
          <div
            className={`mission-clock ${remaining < 120000 ? "critical" : ""}`}
          >
            <Clock3 size={17} />
            <div>
              <small>{t("ui.windowRemaining")}</small>
              <strong>{timer(remaining)}</strong>
            </div>
          </div>
          <button
            className="icon-button"
            aria-label={t("ui.fieldGuide")}
            onClick={onGuide}
          >
            <HelpCircle size={18} />
          </button>
          <button
            className="icon-button"
            aria-label={t("ui.endThisSession")}
            onClick={() => setExit(true)}
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <div className="resource-strip">
        <span className="operation-name">
          <span className="pulse-dot" /> {t("ui.daybreak07")} <i> / </i>{" "}
          {travelling
            ? t("ui.convoyMoving")
            : waiting
              ? t("ui.coordinatingInPlace")
              : t("ui.awaitingOrders")}
        </span>
        <div className="global-resources">
          <button className="resource-context" onClick={() => setContext(true)}>
            {" "}
            {t("ui.resourcesAndLimits")} <HelpCircle size={11} />
          </button>
          {s.resources.map((r) => {
            const Icon = icons[r.channel];
            return (
              <div
                key={r.channel}
                title={t("resources.sharedTitle", {
                  channel: channelLabels[r.channel],
                })}
              >
                <Icon size={14} />
                <span>{channelLabels[r.channel]}</span>
                <strong className={!r.remaining ? "empty" : ""}>
                  {r.remaining}
                  <small>/{r.initial}</small>
                </strong>
              </div>
            );
          })}
        </div>
        <span className={`connection ${!game.connected ? "disconnected" : ""}`}>
          <i />
          {game.connected
            ? t("ui.commandLinkOnline")
            : t("ui.reconnectingClockContinues")}
        </span>
      </div>
      <div className="play-layout">
        <section className="world-column">
          <div
            className="scene-art"
            style={{
              backgroundImage: `url(${scene?.image ?? "/assets/hero.png"})`,
            }}
            key={scene?.image ?? "entry"}
          >
            <div className="scene-art-top">
              <span>
                {scene
                  ? `ACT ${scene.number} / ${scene.english}`
                  : "PROLOGUE / LAST LIGHT"}
              </span>
              <button
                onClick={() => setShowScene(true)}
                aria-label={t("ui.readTheSceneStory")}
              >
                <ArrowUpRight size={18} />
              </button>
            </div>
            <div className="scene-title">
              <span className="scene-location">
                {scene?.location ?? t("ui.assemblyYardWestGate")}
              </span>
              <h1>{scene?.title ?? t("ui.theLastDeparture")}</h1>
              <p>
                {scene?.intro ?? t("ui.theReceptionStationLightsAreOnYour")}
              </p>
            </div>
            <span className="art-caption">
              {t("ui.storyIllustrationNotReconnaissance")}
            </span>
          </div>
          <div className="radio-line">
            <div className="radio-avatar">
              <Radio size={17} />
            </div>
            <div>
              <strong>
                {scene?.speaker ?? t("ui.daybreakReceptionStation")}{" "}
                <span>{t("ui.radio")}</span>
              </strong>
              <p>
                {travelling
                  ? (s.activeOperation?.publicProgressLabel ??
                    t("ui.theConvoyIsHeadingToTheNext"))
                  : waiting
                    ? t("ui.holdPositionInvestigationsAndAnalysisContinueAnd")
                    : (scene?.radio ??
                      t("ui.daybreak07TheReceptionWindowIsOpen"))}
              </p>
            </div>
          </div>
          <TacticalMap
            location={s.location}
            sceneId={s.sceneId}
            onInvestigate={
              s.phase === "scene" || waiting
                ? () => setMapInvestigations(true)
                : undefined
            }
          />
          {(s.pendingTasks.manifest === "pending" ||
            s.pendingTasks.inspection === "pending") && (
            <div className="pending-strip">
              <Flag size={13} />
              <span>{t("ui.handoffTasks")}</span>
              {s.pendingTasks.manifest === "pending" && (
                <b>{t("ui.manifestEntry")}</b>
              )}
              {s.pendingTasks.inspection === "pending" && (
                <b>{t("ui.vehicleInspection")}</b>
              )}
            </div>
          )}
        </section>
        <IntelPanel game={game} />
        <AdvisorPanel game={game} />
      </div>
      <footer className="action-dock">
        <div className="action-label">
          <Route size={19} />
          <span>
            {" "}
            {t("ui.nextAction")}
            <small>{t("ui.theFinalDecisionIsYours")}</small>
          </span>
        </div>
        <div className="route-choices">
          {choices.length ? (
            choices.map((action, i) => (
              <button
                className="route-choice"
                key={action.actionId}
                disabled={!action.available || game.busy}
                onClick={() => setDecision(action)}
              >
                <span className="route-letter">
                  {String.fromCharCode(65 + i)}
                </span>
                <div>
                  <strong>{action.label}</strong>
                  <small>
                    {duration(action.cost.knownDurationMs)}{" "}
                    <i>
                      ·{" "}
                      {action.cost.uncertainty === "none"
                        ? t("ui.fixedDuration")
                        : t("ui.additionalDelayPossibleLabel")}
                    </i>
                  </small>
                </div>
                <ArrowUpRight size={21} />
              </button>
            ))
          ) : (
            <div className="travel-message">
              <span className="travel-track">
                <i />
              </span>
              <div>
                <strong>
                  {s.activeOperation?.publicProgressLabel ??
                    t("ui.convoyInTransit")}
                </strong>
                <small>{t("ui.chooseARouteAtTheNextDecision")}</small>
              </div>
            </div>
          )}
        </div>
        <button
          className="wait-button"
          disabled={
            !s.actionOptions.find((a) => a.actionId === "WAIT")?.available ||
            game.busy
          }
          onClick={() => {
            const a = s.actionOptions.find((a) => a.actionId === "WAIT");
            if (a) setDecision(a);
          }}
        >
          <Clock3 size={17} />
          <span>
            {" "}
            {t("ui.waitHere")}
            <small>{t("ui.153060Sec")}</small>
          </span>
        </button>
      </footer>
      {context && (
        <ContextModal game={game} onClose={() => setContext(false)} />
      )}
      {decision && (
        <DecisionModal
          game={game}
          action={decision}
          onClose={() => setDecision(null)}
        />
      )}
      {mapInvestigations && (
        <Modal
          title={mapCopy.investigations}
          onClose={() => setMapInvestigations(false)}
        >
          <p>{mapCopy.investigationNote}</p>
          {s.taskOptions.map((option) => {
            const Icon = icons[option.resourceChannel];
            return (
              <button
                key={option.targetId}
                className="investigation-card"
                disabled={
                  game.busy ||
                  (!option.available &&
                    option.disabledReason !== "needs_report_reference")
                }
                onClick={() => {
                  setMapInvestigations(false);
                  setMapInvestigationId(option.targetId);
                }}
              >
                <div className="investigation-icon">
                  <Icon size={18} />
                </div>
                <div>
                  <strong>{option.label}</strong>
                  <span>
                    {channelLabels[option.resourceChannel]} ·{" "}
                    {duration(option.cost.knownDurationMs)}
                  </span>
                </div>
                <ChevronRight size={16} />
              </button>
            );
          })}
          {!s.taskOptions.length && (
            <p className="muted">
              {t("ui.theConvoyIsMovingAssignInvestigationsAt")}
            </p>
          )}
        </Modal>
      )}
      {mapInvestigation && (
        <InvestigationModal
          key={mapInvestigation.targetId}
          game={game}
          option={mapInvestigation}
          onClose={() => setMapInvestigationId(null)}
        />
      )}
      {exit && (
        <Modal title={t("ui.endThisEscort")} onClose={() => setExit(false)}>
          <p> {t("ui.thisSessionWillBeSealedImmediatelyYou")} </p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setExit(false)}>
              {" "}
              {t("ui.keepCommanding")}{" "}
            </button>
            <button
              className="danger-button"
              disabled={game.busy}
              onClick={async () => {
                const r = await game.command("/abandon", {
                  reason: "player_exit",
                });
                if (r) setExit(false);
              }}
            >
              {" "}
              {t("ui.endAndReview")}{" "}
            </button>
          </div>
        </Modal>
      )}
      {showScene && (
        <Modal
          title={scene?.title ?? t("ui.theLastDeparture")}
          onClose={() => setShowScene(false)}
        >
          <img
            className="modal-scene-art"
            src={scene?.image ?? "/assets/hero.png"}
            alt={t("ui.illustrationOfTheFictionalValley")}
          />
          <p>
            {scene?.intro ?? t("ui.duskSettlesOverTheValleyTwentyPassengers")}
          </p>
          <blockquote>
            {scene?.atmosphere ?? t("ui.staticBrieflyFillsTheRadioTheDriver")}
          </blockquote>
          <p className="muted small-text">
            {" "}
            {t("ui.theIllustrationSetsTheSceneItDoes")}{" "}
          </p>
        </Modal>
      )}
    </main>
  );
}
