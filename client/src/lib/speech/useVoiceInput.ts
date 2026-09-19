import { useEffect, useRef, useState } from "react";
import { SpeechCapture, type RecordingState } from "./capture";
import { getSpeechConfig, type SpeechConfig } from "./config";

export function useVoiceInput({
  active,
  english,
  onText,
}: {
  active: boolean;
  english: boolean;
  onText(text: string): void;
}) {
  const [state, setState] = useState<RecordingState>("idle");
  const [config, setConfig] = useState<SpeechConfig | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [live, setLive] = useState({ confirmed: "", interim: "" });
  const latest = useRef(onText);
  latest.current = onText;
  const capture = useRef<SpeechCapture | null>(null);
  if (!capture.current) {
    capture.current = new SpeechCapture({
      onState: setState,
      onTranscript: setLive,
      onFinish: (result) => {
        if (result.confirmed) latest.current(result.confirmed);
        setLive({ confirmed: "", interim: "" });
        setError(result.error ?? "");
        setNotice(
          result.partial
            ? "Only confirmed words were kept. Review the draft before sending."
            : result.confirmed
              ? "Review your transcript, then send when ready."
              : "No speech was captured. Try again or type your question.",
        );
      },
    });
  }
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const refresh = () =>
      void getSpeechConfig().then(
        (value) => {
          if (mounted) {
            setConfig(value);
            setError("");
          }
        },
        (reason: unknown) => {
          if (mounted)
            setError(
              reason instanceof Error
                ? reason.message
                : "Voice is unavailable.",
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
  }, [active]);
  useEffect(() => () => capture.current?.dispose(), []);
  useEffect(() => {
    if (!active || !english) capture.current?.stop();
  }, [active, english]);
  useEffect(() => {
    const stopWhenHidden = () => {
      if (document.hidden) capture.current?.stop();
    };
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () =>
      document.removeEventListener("visibilitychange", stopWhenHidden);
  }, []);

  return {
    state,
    live,
    error,
    notice,
    available: !!config?.enabled && english,
    unavailableReason: !english
      ? "English voice only · switch to English to record"
      : config === null
        ? "Voice is connecting. You can still type."
        : !config.enabled
          ? "Voice is not configured. You can still type."
          : "",
    start() {
      if (!active || !english || !config?.enabled || state !== "idle") return;
      setError("");
      setNotice("");
      void capture.current?.start(config.maxRecordingSeconds);
    },
    stop() {
      capture.current?.stop();
    },
  };
}
