import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { P } from "./api";
import { Atmosphere } from "./atmosphere";
import { MusicPlayer } from "./music";
import { MUSIC_CUES, type MusicCue } from "./music-cues";
import {
  AUDIO_STORAGE_KEY,
  musicCueFor,
  parseAudioPreferences,
  type AudioPreferences,
} from "./audio-state";
import { getSpeechActivity, subscribeSpeechActivity } from "./speech/activity";

type SoundStatus = "blocked" | "loading" | "playing" | "off" | "error";
type SoundContext = {
  preferences: AudioPreferences;
  status: SoundStatus;
  cue: MusicCue;
  title: string;
  ducked: boolean;
  activate(): Promise<void>;
  toggle(): void;
  setVolume(kind: "music" | "ambience", value: number): void;
};
type AudioSession = {
  context: AudioContext;
  ambience: Atmosphere;
  music: MusicPlayer;
  cue: MusicCue | null;
  ready: boolean;
  revision: number;
};
const SoundContext = createContext<SoundContext | null>(null);

/** One audio session across every screen and every map renderer. */
export function GameAudioProvider({
  state,
  children,
}: {
  state: P.SessionProjection | null;
  children: ReactNode;
}) {
  const [preferences, setPreferences] = useState(() => {
    try {
      return parseAudioPreferences(localStorage.getItem(AUDIO_STORAGE_KEY));
    } catch {
      return parseAudioPreferences(null);
    }
  });
  const [status, setStatus] = useState<SoundStatus>(
    preferences.enabled ? "blocked" : "off",
  );
  const [speech, setSpeech] = useState(getSpeechActivity);
  const cue = musicCueFor(state);
  const current = useRef({ preferences, state, cue, speech });
  current.current = { preferences, state, cue, speech };
  const audio = useRef<AudioSession | null>(null);
  const mounted = useRef(false);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activation = useRef<Promise<void> | null>(null);

  const cancelPause = useCallback(() => {
    if (pauseTimer.current !== null) clearTimeout(pauseTimer.current);
    pauseTimer.current = null;
  }, []);
  const mix = useCallback(() => {
    const session = audio.current;
    if (!session) return;
    const { preferences: p, state: s, speech: voice } = current.current;
    const quiet = !p.enabled || document.hidden || voice.recording;
    session.music.setVolume(p.music, voice.playing, quiet);
    session.ambience.update(
      s?.sceneId ?? null,
      s?.phase === "resolving" && s.activeOperation?.operationKind !== "wait",
      voice.playing,
      quiet || s?.lifecycle !== "active",
      p.ambience,
    );
  }, []);
  const pause = useCallback(() => {
    cancelPause();
    mix();
    const session = audio.current;
    if (!session) return;
    // Let the master fade before freezing the shared timeline.
    pauseTimer.current = setTimeout(() => {
      pauseTimer.current = null;
      if (
        audio.current === session &&
        (!current.current.preferences.enabled || document.hidden)
      )
        void session.context.suspend().catch(() => {});
    }, 300);
  }, [cancelPause, mix]);

  const selectCue = useCallback(async (session: AudioSession) => {
    const next = current.current.cue;
    if (session.cue === next) return;
    session.cue = next;
    session.ready = false;
    const revision = ++session.revision;
    if (mounted.current) setStatus("loading");
    try {
      await session.music.setCue(next);
      if (audio.current !== session || session.revision !== revision) return;
      session.ready = true;
      if (mounted.current)
        setStatus(current.current.preferences.enabled ? "playing" : "off");
    } catch {
      if (audio.current !== session || session.revision !== revision) return;
      session.cue = null;
      if (mounted.current)
        setStatus(current.current.preferences.enabled ? "error" : "off");
    }
  }, []);

  const activate = useCallback((): Promise<void> => {
    if (!current.current.preferences.enabled || document.hidden)
      return Promise.resolve();
    cancelPause();
    let session = audio.current;
    try {
      if (!session) {
        const context = new AudioContext({ latencyHint: "playback" });
        try {
          const ambience = new Atmosphere(context);
          const music = new MusicPlayer(context);
          session = {
            context,
            ambience,
            music,
            cue: null,
            ready: false,
            revision: 0,
          };
          audio.current = session;
        } catch (error) {
          void context.close().catch(() => {});
          throw error;
        }
      }
      mix();
      // Call resume synchronously within the trusted interaction, before fetch.
      const resumed = session.context.resume();
      const active = session;
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Audio activation timed out")),
          8000,
        );
      });
      const work = Promise.race([resumed, timeout])
        .then(() => {
          if (
            audio.current !== active ||
            activation.current !== work ||
            !mounted.current
          )
            return;
          if (!current.current.preferences.enabled || document.hidden) {
            pause();
            return;
          }
          if (active.context.state !== "running")
            throw new Error("Audio is suspended");
          mix();
          if (active.cue === current.current.cue && active.ready)
            setStatus("playing");
          else {
            setStatus("loading");
            void selectCue(active);
          }
        })
        .catch(() => {
          if (
            mounted.current &&
            audio.current === active &&
            activation.current === work
          )
            setStatus(current.current.preferences.enabled ? "blocked" : "off");
        })
        .finally(() => {
          clearTimeout(timer!);
          if (activation.current === work) activation.current = null;
        });
      activation.current = work;
      return work;
    } catch {
      if (mounted.current) setStatus("error");
      return Promise.resolve();
    }
  }, [cancelPause, mix, pause, selectCue]);

  const save = useCallback(
    (next: AudioPreferences) => {
      current.current.preferences = next;
      setPreferences(next);
      try {
        localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* Sound remains usable when browser storage is unavailable. */
      }
      mix();
    },
    [mix],
  );
  const toggle = useCallback(() => {
    const next = {
      ...current.current.preferences,
      enabled: !current.current.preferences.enabled,
    };
    save(next);
    if (next.enabled) void activate();
    else {
      setStatus("off");
      pause();
    }
  }, [save, activate, pause]);
  const setVolume = useCallback(
    (kind: "music" | "ambience", value: number) => {
      if (!Number.isFinite(value)) return;
      save({
        ...current.current.preferences,
        [kind]: Math.max(0, Math.min(1, value)),
      });
    },
    [save],
  );

  useEffect(() => {
    mounted.current = true;
    const onSpeech = () => {
      const next = getSpeechActivity();
      current.current.speech = next;
      setSpeech(next);
      mix();
    };
    const unsubscribe = subscribeSpeechActivity(onSpeech);
    onSpeech();
    const visibility = () => {
      if (document.hidden) pause();
      else if (audio.current && current.current.preferences.enabled)
        void activate();
    };
    const gesture = (event: Event) => {
      if (
        !event.isTrusted ||
        !current.current.preferences.enabled ||
        (event.target instanceof Element &&
          event.target.closest("[data-sound-control]"))
      )
        return;
      if (
        event instanceof KeyboardEvent &&
        (event.repeat || event.ctrlKey || event.metaKey || event.altKey)
      )
        return;
      if (!audio.current || audio.current.context.state !== "running")
        void activate();
    };
    document.addEventListener("pointerdown", gesture, true);
    document.addEventListener("keydown", gesture, true);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      unsubscribe();
      cancelPause();
      document.removeEventListener("pointerdown", gesture, true);
      document.removeEventListener("keydown", gesture, true);
      document.removeEventListener("visibilitychange", visibility);
      const session = audio.current;
      audio.current = null;
      activation.current = null;
      session?.music.close();
      session?.ambience.close();
      void session?.context.close().catch(() => {});
    };
  }, [activate, cancelPause, mix, pause]);

  useEffect(() => {
    const session = audio.current;
    mix();
    if (
      session &&
      preferences.enabled &&
      session.context.state === "running" &&
      !document.hidden
    )
      void selectCue(session);
  }, [cue, preferences.enabled, mix, selectCue]);
  useEffect(mix, [
    state?.phase,
    state?.activeOperation?.operationKind,
    state?.lifecycle,
    mix,
  ]);
  const previous = useRef({
    sessionId: state?.sessionId,
    sceneId: state?.sceneId,
    count: state?.reports.length ?? 0,
  });
  useEffect(() => {
    const last = previous.current;
    previous.current = {
      sessionId: state?.sessionId,
      sceneId: state?.sceneId,
      count: state?.reports.length ?? 0,
    };
    if (
      state?.lifecycle === "active" &&
      last.sessionId === state.sessionId &&
      (last.sceneId !== state.sceneId || state.reports.length > last.count) &&
      preferences.enabled &&
      !document.hidden &&
      !speech.playing &&
      !speech.recording
    )
      audio.current?.ambience.radioCue();
  }, [
    state?.sessionId,
    state?.sceneId,
    state?.reports.length,
    state?.lifecycle,
    preferences.enabled,
    speech,
  ]);

  return (
    <SoundContext.Provider
      value={{
        preferences,
        status,
        cue,
        title: MUSIC_CUES[cue].title,
        ducked: speech.playing || speech.recording,
        activate,
        toggle,
        setVolume,
      }}
    >
      {children}
    </SoundContext.Provider>
  );
}

export function useGameAudio() {
  const sound = useContext(SoundContext);
  if (!sound) throw new Error("Sound controls require GameAudioProvider");
  return sound;
}
