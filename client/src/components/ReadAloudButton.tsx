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
  const [retry, setRetry] = useState(0);
  const [unavailable, setUnavailable] = useState("Read aloud is connecting.");
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const ours = state.id === id;
  const playing =
    ours && (state.status === "playing" || state.status === "loading");
  const blocked = ours && state.status === "blocked";
  const hasAudioSession = playing || blocked;
  const english = locale === "en-US";

  useEffect(() => {
    if (disabled) return;
    let mounted = true;
    const refresh = (force = false) =>
      void getSpeechConfig({ force }).then(
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
    refresh(retry > 0);
    const refreshNow = () => refresh(true);
    window.addEventListener("online", refreshNow);
    window.addEventListener("focus", refreshNow);
    return () => {
      mounted = false;
      window.removeEventListener("online", refreshNow);
      window.removeEventListener("focus", refreshNow);
    };
  }, [disabled, retry]);
  // A changed report/advice cannot continue speaking its previous contents.
  useEffect(() => () => stopSpeech(id), [id, text]);
  useEffect(() => {
    if (disabled || !english) stopSpeech(id);
  }, [disabled, english, id]);

  const reason = !english
    ? "朗读仅支持英文；请返回首页开始英文任务。"
    : activity.recording
      ? "Stop recording before playing audio"
      : unavailable;
  return (
    <span className="read-aloud-control">
      <button
        type="button"
        className="read-aloud-button"
        disabled={
          disabled ||
          !english ||
          (!hasAudioSession && !enabled) ||
          !text.trim() ||
          activity.recording
        }
        aria-pressed={hasAudioSession}
        title={reason || "Read the full text aloud in English"}
        onClick={() =>
          blocked
            ? speechPlayer.resume(id)
            : playing
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
        {blocked
          ? "Play audio"
          : playing
            ? "Stop audio"
            : ours && state.status === "ended"
              ? "Replay"
              : "Listen"}
      </button>
      {blocked && (
        <button
          type="button"
          className="read-aloud-button"
          onClick={() => stopSpeech(id)}
        >
          Stop
        </button>
      )}
      {ours && (playing || blocked) && (
        <span className="voice-feedback" role="status">
          {blocked
            ? "Audio is ready. Click Play audio to start."
            : state.status === "loading"
              ? "Preparing audio…"
              : `Playing · ${Math.floor((state.seconds ?? 0) / 60)}:${String((state.seconds ?? 0) % 60).padStart(2, "0")}`}
          {state.parts && state.parts > 1
            ? ` · part ${state.part} of ${state.parts}`
            : ""}
        </span>
      )}
      {!english && !disabled && (
        <span className="voice-feedback">{reason}</span>
      )}
      {english && !enabled && !disabled && !hasAudioSession && (
        <>
          <span className="voice-feedback" role="status">
            {unavailable}
          </span>
          <button
            type="button"
            className="read-aloud-button"
            onClick={() => {
              setUnavailable("Checking audio…");
              setRetry((value) => value + 1);
            }}
          >
            Retry audio
          </button>
        </>
      )}
      {ours && state.error && (
        <span className="speech-error" role="status">
          {state.error}
        </span>
      )}
    </span>
  );
}
