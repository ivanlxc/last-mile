import { useState } from "react";
import { X, AlertCircle, ArrowRight } from "lucide-react";
import { useGame } from "./lib/useGame";
import { LocaleProvider, useI18n } from "./lib/i18n";
import type { Game } from "./lib/useGame";
import { Landing, Briefing } from "./components/Landing";
import { GameView } from "./components/GameView";
import { Debrief } from "./components/Debrief";
import { Modal } from "./components/Modal";
import { AccessGate, type AccessMode } from "./components/AccessGate";
import { CloudHistory } from "./components/CloudHistory";
import { MapRendererProvider } from "./lib/mapRenderer";
export default function App() {
  return <AccessGate>{(mode) => <AuthenticatedGame mode={mode} />}</AccessGate>;
}
function AuthenticatedGame({ mode }: { mode: AccessMode }) {
  const game = useGame();
  return (
    <LocaleProvider locale={game.locale}>
      <MapRendererProvider state={game.state}>
        <GameShell game={game} mode={mode} />
      </MapRendererProvider>
    </LocaleProvider>
  );
}
function GameShell({ game, mode }: { game: Game; mode: AccessMode }) {
  const { t, campaign } = useI18n();
  const [guide, setGuide] = useState(false);
  return (
    <>
      {game.state ? (
        game.state.lifecycle === "created" ? (
          <Briefing game={game} />
        ) : game.state.lifecycle === "sealed" ? (
          <Debrief game={game} />
        ) : (
          <GameView game={game} onGuide={() => setGuide(true)} />
        )
      ) : (
        <Landing game={game} onGuide={() => setGuide(true)} />
      )}{" "}
      {!game.state && mode === "cloud" && <CloudHistory />}
      {game.error && (
        <div className="error-toast" role="alert">
          <AlertCircle size={19} />
          <span>{game.error}</span>
          <button
            onClick={game.clearError}
            aria-label={t("ui.dismissNotification")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {guide && (
        <Modal
          wide
          title={t("ui.youCanDecideWithoutKnowingEverything")}
          onClose={() => setGuide(false)}
        >
          <div className="guide-grid">
            {campaign.tutorial.map((t) => (
              <article key={t.number}>
                <b>{t.number}</b>
                <h3>{t.title}</h3>
                <p>{t.text}</p>
              </article>
            ))}
          </div>
          <div className="guide-budget">
            <strong>{t("ui.sharedAcrossTheMission")}</strong>
            <span>{t("ui.satellite2")}</span>
            <span>{t("ui.drone3")}</span>
            <span>{t("ui.localAgency3")}</span>
            <span>{t("ui.witness2")}</span>
          </div>
          <p className="muted small-text">
            {" "}
            {t("ui.eachRoleMayDeliver3ReportsPer")}{" "}
          </p>
          <button className="primary" onClick={() => setGuide(false)}>
            {" "}
            {t("ui.understood")} <ArrowRight size={17} />
          </button>
        </Modal>
      )}
    </>
  );
}
