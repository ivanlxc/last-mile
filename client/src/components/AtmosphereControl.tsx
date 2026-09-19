import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { Atmosphere } from "../lib/atmosphere";
import {
  getSpeechActivity,
  subscribeSpeechActivity,
} from "../lib/speech/activity";

export function AtmosphereControl({
  sceneId,
  travelling,
  reportCount,
}: {
  sceneId: string | null;
  travelling: boolean;
  reportCount: number;
}) {
  const { locale } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState(false);
  const audio = useRef<Atmosphere | null>(null);
  const speech = useRef(getSpeechActivity());
  const mounted = useRef(true);
  const latest = useRef({ sceneId, travelling });
  latest.current = { sceneId, travelling };
  const previous = useRef({ sceneId, reportCount });
  const update = useCallback(() => {
    audio.current?.update(
      latest.current.sceneId,
      latest.current.travelling,
      speech.current.recording || speech.current.playing,
      document.hidden,
    );
  }, []);
  useEffect(() => {
    mounted.current = true;
    const onSpeech = () => {
      speech.current = getSpeechActivity();
      update();
    };
    const unsubscribe = subscribeSpeechActivity(onSpeech);
    onSpeech();
    document.addEventListener("visibilitychange", update);
    return () => {
      mounted.current = false;
      unsubscribe();
      document.removeEventListener("visibilitychange", update);
      audio.current?.close();
      audio.current = null;
    };
  }, [update]);
  useEffect(() => {
    const changed =
      sceneId !== previous.current.sceneId ||
      reportCount > previous.current.reportCount;
    previous.current = { sceneId, reportCount };
    update();
    if (
      changed &&
      !document.hidden &&
      !speech.current.recording &&
      !speech.current.playing
    )
      audio.current?.radioCue();
  }, [sceneId, travelling, reportCount, update]);
  const toggle = async () => {
    if (audio.current) {
      audio.current.close();
      audio.current = null;
      setEnabled(false);
      return;
    }
    setError(false);
    let instance: Atmosphere | null = null;
    try {
      instance = new Atmosphere();
      audio.current = instance;
      await instance.resume();
      if (!mounted.current || audio.current !== instance) return;
      update();
      setEnabled(true);
    } catch {
      instance?.close();
      if (audio.current === instance) audio.current = null;
      if (mounted.current) {
        setEnabled(false);
        setError(true);
      }
    }
  };
  const en = locale === "en-US";
  return (
    <button
      type="button"
      className="atmosphere-toggle"
      aria-pressed={enabled}
      aria-label={
        en
          ? enabled
            ? "Mute ambience"
            : "Enable ambience"
          : enabled
            ? "关闭环境音"
            : "开启环境音"
      }
      title={
        error
          ? en
            ? "Audio unavailable. Click to retry."
            : "声音暂不可用，点击重试。"
          : undefined
      }
      onClick={() => void toggle()}
    >
      {enabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
      <span>
        {error
          ? en
            ? "Retry sound"
            : "重试声音"
          : enabled
            ? en
              ? "Sound on"
              : "声音开"
            : en
              ? "Sound off"
              : "声音关"}
      </span>
    </button>
  );
}
