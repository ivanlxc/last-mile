import { useI18n } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Clock3,
  Users,
  Radio,
  HeartPulse,
  HelpCircle,
  LogOut,
  Route,
  Satellite,
  ScanLine,
  Building2,
  MessageCircle,
  ChevronRight,
  ChevronDown,
  PanelLeft,
  Sparkles,
  BookOpen,
  X,
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
import { useMapRenderer } from "../lib/mapRenderer";
import { ReadAloudButton } from "./ReadAloudButton";
import { AtmosphereControl } from "./AtmosphereControl";
import "./map-first.css";
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
  const [missionOpen, setMissionOpen] = useState(false);
  const missionMenu = useRef<HTMLDetailsElement>(null);
  const [drawer, setDrawer] = useState<"intel" | "advisor" | null>(null);
  const [seenReportCount, setSeenReportCount] = useState(s.reports.length);
  const [seenStory, setSeenStory] = useState<string | null>(null);
  const intelTrigger = useRef<HTMLButtonElement>(null);
  const advisorTrigger = useRef<HTMLButtonElement>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const decisionTrigger = useRef<HTMLButtonElement | null>(null);
  const renderer = useMapRenderer();
  const chinese = locale === "zh-CN";
  const closeDrawer = () => {
    const trigger = drawer === "intel" ? intelTrigger : advisorTrigger;
    setDrawer(null);
    trigger.current?.focus();
  };
  const closeDecision = () => {
    const actionId = decision?.actionId;
    setDecision(null);
    requestAnimationFrame(() => {
      const target = actionId
        ? document.querySelector<HTMLButtonElement>(
            `[data-action-id="${CSS.escape(actionId)}"]`,
          )
        : null;
      (target && !target.disabled ? target : intelTrigger.current)?.focus();
    });
  };
  useEffect(() => {
    if (drawer) drawerClose.current?.focus();
  }, [drawer]);
  useEffect(() => {
    if (drawer === "intel") setSeenReportCount(s.reports.length);
  }, [drawer, s.reports.length]);
  useEffect(() => {
    renderer.setInputBlocked(!!drawer || !!decision || missionOpen);
    return () => renderer.setInputBlocked(false);
  }, [drawer, decision, missionOpen, renderer.setInputBlocked]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("dialog[open]"))
        return;
      if (missionOpen || missionMenu.current?.open) {
        event.preventDefault();
        setMissionOpen(false);
        missionMenu.current?.querySelector("summary")?.focus();
        return;
      }
      if (decision) {
        event.preventDefault();
        closeDecision();
      } else if (drawer) {
        event.preventDefault();
        closeDrawer();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [decision, drawer, missionOpen]);
  useEffect(() => {
    if (!missionOpen) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !missionMenu.current?.contains(event.target)
      )
        setMissionOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [missionOpen]);
  const [displayClock, setDisplayClock] = useState(s.missionTimeMs);
  const sample = useRef({ mission: s.missionTimeMs, at: performance.now() });
  useEffect(() => {
    sample.current = { mission: s.missionTimeMs, at: performance.now() };
    setDisplayClock(s.missionTimeMs);
  }, [s.sessionId, s.runEpoch, s.missionTimeMs]);
  useEffect(() => {
    // Idle reading does not require persisted clock packets. Interpolate only
    // the display; every new server sample reanchors this shared elapsed clock.
    const interval = setInterval(() => {
      if (!document.hidden)
        setDisplayClock(
          sample.current.mission +
            Math.max(0, performance.now() - sample.current.at),
        );
    }, 200);
    return () => clearInterval(interval);
  }, []);
  const travelling =
    s.phase === "resolving" && s.activeOperation?.operationKind !== "wait";
  const previousScene = useRef(s.sceneId);
  useEffect(() => {
    if (s.sceneId !== previousScene.current) {
      setDecision(null);
      previousScene.current = s.sceneId;
    }
  }, [s.sceneId]);
  const choices = s.actionOptions.filter((a) => a.kind === "route");
  const waiting = s.activeOperation?.operationKind === "wait";
  return (
    <main className="command-center map-first-command">
      <header className="command-header">
        <Brand small />
        <div className="chapter-current">
          <span className="eyebrow">
            {scene ? `ACT ${scene.number}` : "PROLOGUE"}
          </span>
          <h1>{scene?.english ?? "LAST LIGHT"}</h1>
          <span className="scene-location">
            {scene?.location ?? t("ui.assemblyYardWestGate")}
          </span>
        </div>
        <div className="command-hud">
          <div className="civilian-hud">
            <Users size={16} />
            <strong>{s.civilianCount}</strong>
            <span>{chinese ? "名乘员" : "aboard"}</span>
          </div>
          <div
            className={`medical-hud ${s.medical.status !== "stable" ? "warning" : ""}`}
            title={s.medical.note}
          >
            <HeartPulse size={16} />
            <span>
              {s.medical.status === "stable"
                ? t("ui.stable")
                : t("ui.priorityTransferNeeded")}
            </span>
          </div>
          <details
            className="mission-details"
            ref={missionMenu}
            open={missionOpen}
          >
            <summary
              data-testid="open-mission"
              onClick={(event) => {
                event.preventDefault();
                setMissionOpen((open) => !open);
              }}
            >
              {chinese ? "任务" : "Mission"}
              <ChevronDown size={14} />
            </summary>
            <div className="mission-popover">
              <nav className="chapter-nav" aria-label={t("ui.chapterProgress")}>
                {Object.entries(scenes).map(([id, c], i) => (
                  <div className={s.sceneId === id ? "current" : ""} key={id}>
                    <b>{c.number}</b>
                    <span>
                      {i === 0
                        ? t("ui.westGate")
                        : i === 1
                          ? t("ui.market")
                          : t("ui.mainBridge")}
                    </span>
                  </div>
                ))}
              </nav>
              <div className="mission-clock">
                <Clock3 size={17} />
                <div>
                  <small>{t("ui.elapsedMissionTime")}</small>
                  <strong>{timer(displayClock)}</strong>
                </div>
              </div>
              <div className="global-resources">
                {s.resources.map((r) => {
                  const Icon = icons[r.channel];
                  return (
                    <div key={r.channel}>
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
              {(s.pendingTasks.manifest === "pending" ||
                s.pendingTasks.inspection === "pending") && (
                <p className="mission-pending">
                  {t("ui.handoffTasks")}:{" "}
                  {[
                    s.pendingTasks.manifest === "pending"
                      ? t("ui.manifestEntry")
                      : null,
                    s.pendingTasks.inspection === "pending"
                      ? t("ui.vehicleInspection")
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              <button
                className="resource-context"
                onClick={() => setContext(true)}
              >
                {t("ui.resourcesAndLimits")}
                <ArrowUpRight size={14} />
              </button>
              <button onClick={onGuide}>
                {t("ui.fieldGuide")}
                <HelpCircle size={14} />
              </button>
              <button onClick={() => setExit(true)}>
                {t("ui.endThisSession")}
                <LogOut size={14} />
              </button>
              <small className="session-language">
                {locale === "en-US" ? "EN" : "中文"} · {t("language.fixed")}
              </small>
            </div>
          </details>
        </div>
      </header>
      <div className="map-command-toolbar">
        <div className="map-panel-tools">
          <button
            data-testid="open-intel"
            ref={intelTrigger}
            className={drawer === "intel" ? "active" : ""}
            aria-expanded={drawer === "intel"}
            aria-controls="intel-drawer"
            onClick={() =>
              drawer === "intel" ? closeDrawer() : setDrawer("intel")
            }
          >
            <PanelLeft size={17} />
            {chinese ? "情报" : "Intel"}
            {s.reports.length > seenReportCount && (
              <span className="toolbar-badge">
                {s.reports.length - seenReportCount}
              </span>
            )}
          </button>
          <button
            data-testid="open-story"
            onClick={() => {
              setSeenStory(s.sceneId ?? "prologue");
              setShowScene(true);
            }}
            aria-label={t("ui.readTheSceneStory")}
          >
            <BookOpen size={16} />
            {chinese ? "故事" : "Story"}
            {seenStory !== (s.sceneId ?? "prologue") && (
              <span className="toolbar-badge">{chinese ? "新" : "New"}</span>
            )}
          </button>
        </div>
        <span className="operation-name" role="status">
          <span className="pulse-dot" />
          {travelling
            ? t("ui.convoyMoving")
            : waiting
              ? t("ui.coordinatingInPlace")
              : t("ui.awaitingOrders")}
        </span>
        <div className="map-toolbar-feedback">
          <AtmosphereControl
            sceneId={s.sceneId}
            travelling={travelling}
            reportCount={s.reports.length}
          />
          {s.activeTasks.length > 0 && (
            <button className="task-status" onClick={() => setDrawer("intel")}>
              <span className="spinner" />
              {s.activeTasks.length} {chinese ? "项调查进行中" : "in progress"}
            </button>
          )}
          <span
            className={`connection ${!game.connected ? "disconnected" : ""}`}
            title={
              game.connected
                ? t("ui.commandLinkOnline")
                : t("ui.reconnectingClockContinues")
            }
          >
            <i />
            <span>
              {game.connected
                ? chinese
                  ? "在线"
                  : "Connected"
                : chinese
                  ? "重新连接中"
                  : "Reconnecting…"}
            </span>
          </span>
          <button
            data-testid="open-advisor"
            ref={advisorTrigger}
            className={`advisor-trigger ${drawer === "advisor" ? "active" : ""}`}
            aria-expanded={drawer === "advisor"}
            aria-controls="advisor-drawer"
            onClick={() =>
              drawer === "advisor" ? closeDrawer() : setDrawer("advisor")
            }
          >
            <Sparkles size={16} />
            {t("ui.aiAdvisor")}
            {["queued", "running"].includes(
              s.latestAdviceJob?.status ?? "",
            ) && <span className="spinner" />}
          </button>
        </div>
      </div>
      <div className={`map-stage ${drawer ? `with-${drawer}` : ""}`}>
        <aside
          data-testid="intel-drawer"
          id="intel-drawer"
          className="map-drawer intel-drawer"
          hidden={drawer !== "intel"}
          aria-label={t("ui.fieldIntelligence")}
        >
          <div className="drawer-bar">
            <span>{chinese ? "情报与调查" : "INTELLIGENCE"}</span>
            <button
              ref={drawer === "intel" ? drawerClose : undefined}
              className="icon-button"
              aria-label={chinese ? "关闭情报" : "Close intelligence"}
              onClick={closeDrawer}
            >
              <X size={18} />
            </button>
          </div>
          <IntelPanel game={game} active={drawer === "intel"} />
        </aside>
        <div className="map-stage-main">
          <TacticalMap
            location={s.location}
            sceneId={s.sceneId}
            stage
            onInvestigate={
              s.phase === "scene" || waiting
                ? () => setDrawer("intel")
                : undefined
            }
          />
        </div>
        <aside
          data-testid="advisor-drawer"
          id="advisor-drawer"
          className="map-drawer advisor-drawer"
          hidden={drawer !== "advisor"}
          aria-label={t("ui.aiAdvisor")}
        >
          <div className="drawer-bar">
            <span>{chinese ? "决策支持" : "DECISION SUPPORT"}</span>
            <button
              ref={drawer === "advisor" ? drawerClose : undefined}
              className="icon-button"
              aria-label={chinese ? "关闭 AI 助手" : "Close AI advisor"}
              onClick={closeDrawer}
            >
              <X size={18} />
            </button>
          </div>
          <AdvisorPanel game={game} active={drawer === "advisor"} />
        </aside>
      </div>
      <footer className={`action-dock ${decision ? "reviewing-action" : ""}`}>
        {decision ? (
          <DecisionModal
            inline
            missionTimeMs={displayClock}
            game={game}
            action={decision}
            onClose={closeDecision}
          />
        ) : (
          <>
            <div className="action-label">
              <Route size={19} />
              <span>{t("ui.nextAction")}</span>
            </div>
            <div className="route-choices">
              {choices.length ? (
                choices.map((action, i) => (
                  <button
                    className="route-choice"
                    data-action-id={action.actionId}
                    key={action.actionId}
                    disabled={!action.available || game.busy}
                    onClick={(event) => {
                      decisionTrigger.current = event.currentTarget;
                      setDrawer(null);
                      setDecision(action);
                    }}
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
                    <ArrowUpRight size={18} />
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
              data-action-id="WAIT"
              disabled={
                !s.actionOptions.find((a) => a.actionId === "WAIT")
                  ?.available || game.busy
              }
              onClick={(event) => {
                const a = s.actionOptions.find((a) => a.actionId === "WAIT");
                if (a) {
                  decisionTrigger.current = event.currentTarget;
                  setDrawer(null);
                  setDecision(a);
                }
              }}
            >
              <Clock3 size={17} />
              <span>
                {t("ui.waitHere")}
                <small>{t("ui.153060Sec")}</small>
              </span>
            </button>
          </>
        )}
      </footer>
      {context && (
        <ContextModal
          game={game}
          missionTimeMs={displayClock}
          onClose={() => setContext(false)}
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
          <ReadAloudButton
            id={`story:${s.sessionId}:${s.sceneId}`}
            text={[
              scene?.title ?? t("ui.theLastDeparture"),
              scene?.intro ?? t("ui.duskSettlesOverTheValleyTwentyPassengers"),
              scene?.atmosphere ?? t("ui.staticBrieflyFillsTheRadioTheDriver"),
              `${scene?.speaker ?? t("ui.daybreakReceptionStation")}. ${scene?.radio ?? t("ui.daybreak07TheReceptionWindowIsOpen")}`,
            ].join(". ")}
          />
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
          <p className="muted small-text">
            {" "}
            {t("ui.theIllustrationSetsTheSceneItDoes")}{" "}
          </p>
        </Modal>
      )}
    </main>
  );
}
