import { useI18n } from "../lib/i18n";
import {
  ArrowUpRight,
  ArrowRight,
  Compass,
  Radio,
  ShieldCheck,
  Users,
  Clock3,
  Sparkles,
} from "lucide-react";

import type { Game } from "../lib/useGame";
import { TacticalMap } from "./TacticalMap";
import { useMapRenderer } from "../lib/mapRenderer";
import { mapRendererCopy } from "../lib/mapRendererCopy";
import { AtmosphereControl } from "./AtmosphereControl";
export function Brand({ small = false }: { small?: boolean }) {
  const { t } = useI18n();
  return (
    <div className={`brand ${small ? "small" : ""}`}>
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      <span>
        LAST MILE<small>{t("ui.theFinalStretch")}</small>
      </span>
    </div>
  );
}
export function Landing({
  game,
  onGuide,
}: {
  game: Game;
  onGuide: () => void;
}) {
  const { t } = useI18n();
  return (
    <main className="landing">
      <div className="landing-bg" />
      <div className="grain" />
      <header className="landing-nav">
        <Brand />
        <div className="nav-right">
          <AtmosphereControl />
          <div
            className="language-switch"
            role="group"
            aria-label={t("language.select")}
          >
            <button
              type="button"
              aria-label="English"
              aria-pressed={game.preferredLocale === "en-US"}
              onClick={() => game.setPreferredLocale("en-US")}
              disabled={game.busy}
            >
              English
            </button>
            <button
              type="button"
              aria-label="中文"
              aria-pressed={game.preferredLocale === "zh-CN"}
              onClick={() => game.setPreferredLocale("zh-CN")}
              disabled={game.busy}
            >
              中文
            </button>
          </div>
          <span className="version">SINGLE PLAYER EXPERIENCE</span>
          <button className="text-button" onClick={onGuide}>
            {" "}
            {t("ui.fieldGuide")} <ArrowUpRight size={16} />
          </button>
        </div>
      </header>
      <section className="landing-copy">
        <div className="overline">
          <span /> HUMAN + AI · A DECISION EXPERIENCE
        </div>
        <h1>
          LAST
          <br />
          <span>MILE</span>
          <em>{t("ui.theFinalStretch")}</em>
        </h1>
        <div className="hero-rule" />
        <p className="hero-tagline">
          {" "}
          {t("ui.twentyPeopleOneWayHome")} <br />{" "}
          {t("ui.noCompleteAnswers")}{" "}
        </p>
        <p className="hero-description">
          {" "}
          {t("ui.withFragmentsOfIntelligence")} <br />{" "}
          {t("ui.decideWhatToTrustAndHowTo")}{" "}
        </p>
        <button
          className="primary hero-cta"
          onClick={() => void game.create()}
          disabled={game.loading || game.busy || !game.bootstrap}
        >
          {game.loading
            ? t("ui.connecting")
            : game.busy
              ? t("ui.preparingMission")
              : t("ui.enterMissionBriefing")}
          <ArrowRight size={20} />
        </button>
        <p className="language-note">{t("language.nextRun")}</p>
        <span className="hero-meta">
          {" "}
          {t("ui.oneCommander")} <i /> {t("ui.threeCriticalChoices")} <i />{" "}
          {t("ui.unlimitedExploration")}{" "}
        </span>
      </section>
      <div className="landing-coordinate">
        <Compass size={26} />
        <div>
          <strong>SAHEL VALLEY</strong>
          <span>{t("ui.aFictionalValleyAnEveningEscort")}</span>
        </div>
      </div>
      <footer className="landing-footer">
        <span>AN EXPERIMENT IN CALIBRATED TRUST</span>
        <span className="provider-status">
          <i />
          {game.health?.modelConfigured
            ? t("ui.aiServiceConfigured")
            : t("ui.playableOfflineAITemplateMode")}
        </span>
        <span>PROTOTYPE 0.2</span>
      </footer>
    </main>
  );
}
export function Briefing({ game }: { game: Game }) {
  const { t, campaign, characters, locale } = useI18n();
  const { canStart } = useMapRenderer();
  const state = game.state!;
  return (
    <main className="briefing page-shell">
      <header className="page-header">
        <Brand />
        <span className="eyebrow">{t("ui.missionBRIEFING")}</span>
        <AtmosphereControl />
        <span className="status-tag">
          <Clock3 size={13} /> {t("ui.theClockHasNotStarted")}{" "}
        </span>
      </header>
      <div className="brief-grid">
        <section>
          <div className="overline">{t("ui.operationDAYBREAK07")}</div>
          <h1>
            {" "}
            {t("ui.bringEveryone")} <br />
            <em>{t("ui.toTheOtherSide")}</em>
          </h1>
          {campaign.briefing.map((p, i) => (
            <p className="brief-paragraph" key={i}>
              {p}
            </p>
          ))}
          <div className="mission-stats">
            <div>
              <Users size={19} />
              <strong>
                20<small>{t("ui.civilians")}</small>
              </strong>
            </div>
            <div>
              <Clock3 size={19} />
              <strong>
                ∞<small>{t("ui.noTimeLimit")}</small>
              </strong>
            </div>
            <div>
              <ShieldCheck size={19} />
              <strong>
                03<small>{t("ui.decisionScenes")}</small>
              </strong>
            </div>
          </div>
          <div className="crew">
            <span className="eyebrow">{t("ui.yourTeam")}</span>
            {Object.values(characters).map((c) => (
              <div className="crew-member" key={c.name}>
                <div className="avatar">{c.initials}</div>
                <div>
                  <strong>
                    {c.name} <small>{c.role}</small>
                  </strong>
                  <p>{c.line}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="brief-right">
          <TacticalMap location={state.location} sceneId={null} />
          <div className="brief-note">
            <Radio size={19} />
            <div>
              <strong>{t("ui.youChooseWhatTheAIKnows")}</strong>
              <p> {t("ui.theAdvisorOnlyAnalyzesCardsYouUpload")} </p>
            </div>
          </div>
          <div className="brief-rules">
            {campaign.tutorial.slice(0, 3).map((t) => (
              <div key={t.number}>
                <b>{t.number}</b>
                <p>
                  <strong>{t.title}</strong>
                  {t.text}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
      <footer className="brief-footer">
        <button
          className="text-button briefing-language"
          onClick={game.home}
          disabled={game.busy}
        >
          {t("language.changeBriefing")}
        </button>
        <div>
          <Sparkles size={16} />
          <span>{t("ui.observeThenJudgeYouCanAlwaysAct")}</span>
        </div>
        {!canStart && (
          <p className="map-start-status" role="status">
            {mapRendererCopy(locale).loading}
          </p>
        )}
        <button
          className="primary"
          disabled={game.busy || !canStart}
          onClick={() =>
            void game.command("/start", { acknowledgeDesignPreview: true })
          }
        >
          {" "}
          {t("ui.startEscort")} <ArrowRight size={18} />
        </button>
      </footer>
    </main>
  );
}
