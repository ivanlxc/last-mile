import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LoaderCircle, Square, Volume2 } from "lucide-react";
import { useI18n } from "../lib/i18n";
import {
  getSpeechActivity,
  subscribeSpeechActivity,
} from "../lib/speech/activity";
import { getSpeechConfig } from "../lib/speech/config";
import { speechPlayer, stopSpeech } from "../lib/speech/playback";
import "./voice.css";

export function ReadAloudButton({
  id,
  text,
  disabled = false,
  onComplete,
}: {
  id: string;
  text: string;
  disabled?: boolean;
  onComplete?: () => void;
}) {
  const { locale } = useI18n();
  const state = useSyncExternalStore(
    speechPlayer.subscribe,
    speechPlayer.snapshot,
  );
  const activity = useSyncExternalStore(
    subscribeSpeechActivity,
    getSpeechActivity,
  );
  const [enabled, setEnabled] = useState(false);
  const [unavailable, setUnavailable] = useState("Read aloud is connecting.");
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const ours = state.id === id;
  const playing =
    ours && (state.status === "playing" || state.status === "loading");
  const english = locale === "en-US";

  useEffect(() => {
    if (disabled) return;
    let mounted = true;
    const refresh = () =>
      void getSpeechConfig().then(
        (config) => {
          if (!mounted) return;
          setEnabled(config.enabled);
          setUnavailable(
            config.enabled
              ? ""
              : "Read aloud is unavailable. You can still read the text.",
          );
        },
        () => {
          if (mounted)
            setUnavailable(
              "Read aloud is unavailable. You can still read the text.",
            );
        },
      );
    refresh();
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      mounted = false;
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [disabled]);
  // A changed report/advice cannot continue speaking its previous contents.
  useEffect(() => () => stopSpeech(id), [id, text]);
  useEffect(() => {
    if (disabled || !english) stopSpeech(id);
  }, [disabled, english, id]);

  const reason = !english
    ? "English audio only · switch to English to listen"
    : activity.recording
      ? "Stop recording before playing audio"
      : unavailable;
  return (
    <span className="read-aloud-control">
      <button
        type="button"
        className="read-aloud-button"
        disabled={
          disabled || !english || !enabled || !text.trim() || activity.recording
        }
        aria-pressed={playing}
        title={reason || "Read the full text aloud in English"}
        onClick={() =>
          playing
            ? stopSpeech(id)
            : void speechPlayer.play(id, text, () => complete.current?.())
        }
      >
        {ours && state.status === "loading" ? (
          <LoaderCircle size={14} className="spin" />
        ) : playing ? (
          <Square size={12} />
        ) : (
          <Volume2 size={14} />
        )}
        {playing
          ? "Stop audio"
          : ours && state.status === "ended"
            ? "Replay"
            : "Listen"}
      </button>
      {ours && state.error && (
        <span className="speech-error" role="status">
          {state.error}
        </span>
      )}
    </span>
  );
}
