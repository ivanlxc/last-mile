import { useEffect, useId, useRef, useState } from "react";
import { Volume2, VolumeX, X } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { useGameAudio } from "../lib/gameAudio";
import "./sound.css";

export function AtmosphereControl() {
  const { locale } = useI18n();
  const sound = useGameAudio();
  const en = locale === "en-US";
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    root.current
      ?.querySelector<HTMLButtonElement>("[data-testid=sound-toggle]")
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div
      className="sound-control"
      ref={root}
      data-sound-control
      data-cue={sound.cue}
      data-status={sound.status}
      data-ducked={sound.ducked}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="atmosphere-toggle"
        data-testid="sound-settings"
        aria-label={en ? "Sound settings" : "声音设置"}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen(!open);
          if (!open && sound.preferences.enabled && sound.status === "blocked")
            void sound.activate();
        }}
      >
        {sound.preferences.enabled ? (
          <Volume2 size={15} />
        ) : (
          <VolumeX size={15} />
        )}
        <span>
          {sound.status === "error"
            ? en
              ? "Sound · retry"
              : "声音 · 重试"
            : sound.preferences.enabled
              ? en
                ? "Sound"
                : "声音"
              : en
                ? "Sound off"
                : "声音关"}
        </span>
      </button>
      {open && (
        <div
          className="sound-popover"
          id={panelId}
          role="group"
          aria-label={en ? "Sound settings" : "声音设置"}
        >
          <div className="sound-heading">
            <strong>{en ? "Sound" : "声音"}</strong>
            <button
              type="button"
              onClick={close}
              aria-label={en ? "Close sound settings" : "关闭声音设置"}
            >
              <X size={15} />
            </button>
          </div>
          <button
            type="button"
            data-testid="sound-toggle"
            className="sound-master-toggle"
            aria-pressed={sound.preferences.enabled}
            onClick={sound.toggle}
          >
            {sound.preferences.enabled ? (
              <Volume2 size={15} />
            ) : (
              <VolumeX size={15} />
            )}
            {sound.preferences.enabled
              ? en
                ? "Mute sound"
                : "静音"
              : en
                ? "Enable sound"
                : "开启声音"}
          </button>
          {(["music", "ambience"] as const).map((kind) => (
            <label className="sound-volume" key={kind}>
              <span>
                {kind === "music"
                  ? en
                    ? "Music"
                    : "音乐"
                  : en
                    ? "Ambience"
                    : "环境音"}
                <output>{Math.round(sound.preferences[kind] * 100)}%</output>
              </span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                aria-label={
                  kind === "music"
                    ? en
                      ? "Music volume"
                      : "音乐音量"
                    : en
                      ? "Ambience volume"
                      : "环境音音量"
                }
                value={Math.round(sound.preferences[kind] * 100)}
                onChange={(event) =>
                  sound.setVolume(kind, Number(event.target.value) / 100)
                }
              />
            </label>
          ))}
          <p className="sound-track">{sound.title}</p>
          {(sound.status === "error" || sound.status === "blocked") &&
          sound.preferences.enabled ? (
            <div className="sound-notice" role="status">
              <span>
                {sound.status === "error"
                  ? en
                    ? "Music could not load."
                    : "音乐暂时无法加载。"
                  : en
                    ? "Tap Play to start sound."
                    : "点击播放以开启声音。"}
              </span>
              <button type="button" onClick={() => void sound.activate()}>
                {sound.status === "error"
                  ? en
                    ? "Retry music"
                    : "重试音乐"
                  : en
                    ? "Play sound"
                    : "播放声音"}
              </button>
            </div>
          ) : (
            <p className="sound-hint" role="status">
              {sound.status === "loading"
                ? en
                  ? "Loading music…"
                  : "正在加载音乐…"
                : en
                  ? "Music softens during narration."
                  : "朗读时音乐自动降低。"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
