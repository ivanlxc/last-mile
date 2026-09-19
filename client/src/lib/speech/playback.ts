import {
  getSpeechActivity,
  setSpeechActivity,
  subscribeSpeechActivity,
} from "./activity";
import { getSpeechConfig, speechError, type SpeechConfig } from "./config";
import { splitSpeechText } from "./readout";

export type PlaybackState = {
  id: string | null;
  status: "idle" | "loading" | "playing" | "blocked" | "ended" | "error";
  error: string | null;
  /** Elapsed playback within the current part, never inferred from downloads. */
  seconds?: number;
  part?: number;
  parts?: number;
};
type Dependencies = {
  fetch: typeof fetch;
  config: () => Promise<SpeechConfig>;
  audio: () => HTMLAudioElement;
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
};
const browserDependencies: Dependencies = {
  fetch: (...args) => fetch(...args),
  config: getSpeechConfig,
  audio: () => new Audio(),
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
};

/** One voice at a time for the whole game. Cancellation revokes both audio and
 * pending requests; completion means every chunk reached its ended event. */
export class SpeechPlayer {
  private state: PlaybackState = { id: null, status: "idle", error: null };
  private listeners = new Set<() => void>();
  private generation = 0;
  private controller: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private rejectPlayback: ((error: Error) => void) | null = null;
  private resumePlayback: (() => void) | null = null;
  private playbackStartTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeActivity: () => void;

  constructor(
    private readonly dependencies: Dependencies = browserDependencies,
  ) {
    this.unsubscribeActivity = subscribeSpeechActivity(() => {
      if (getSpeechActivity().recording && this.controller) this.stop();
    });
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async play(id: string, text: string, onComplete?: () => void): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    if (getSpeechActivity().recording) {
      this.update({
        id,
        status: "error",
        error: "Stop recording before playing audio.",
      });
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.update({ id, status: "loading", error: null });
    try {
      const config = await this.dependencies.config();
      if (generation !== this.generation) return;
      if (!config.enabled)
        throw new Error(
          "Read aloud is unavailable. You can still read the text.",
        );
      const chunks = splitSpeechText(
        text,
        Math.min(config.maxTextLength, 2000),
      );
      if (!chunks.length) throw new Error("There is no text to read.");
      for (const [index, chunk] of chunks.entries()) {
        if (generation !== this.generation) return;
        const progress = { part: index + 1, parts: chunks.length, seconds: 0 };
        this.update({ id, status: "loading", error: null, ...progress });
        const response = await this.dependencies.fetch(
          "/api/v1/speech/synthesize",
          {
            method: "POST",
            credentials: "same-origin",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: chunk }),
          },
        );
        if (!response.ok) throw await speechError(response);
        const blob = await response.blob();
        if (generation !== this.generation) return;
        const audio = this.dependencies.audio();
        this.audio = audio;
        this.audioUrl = this.dependencies.createUrl(blob);
        audio.src = this.audioUrl;
        if (typeof document !== "undefined") {
          audio.dataset.speechAudio = "";
          audio.hidden = true;
          audio.preload = "auto";
          audio.setAttribute("playsinline", "");
          audio.setAttribute("aria-hidden", "true");
          document.body.append(audio);
        }
        await new Promise<void>((resolve, reject) => {
          this.rejectPlayback = reject;
          const isCurrent = () =>
            generation === this.generation && this.audio === audio;
          let attempt = 0;
          let waitingForStart = false;
          const startedPlaying = (thisAttempt: number) => {
            if (!isCurrent() || thisAttempt !== attempt || !waitingForStart)
              return;
            waitingForStart = false;
            this.clearStartTimer();
            this.update({
              id,
              status: "playing",
              error: null,
              ...progress,
              seconds: Math.floor(audio.currentTime || 0),
            });
          };
          const failed = (error: unknown, thisAttempt: number) => {
            if (!isCurrent() || thisAttempt !== attempt) return;
            waitingForStart = false;
            this.clearStartTimer();
            if (
              error &&
              typeof error === "object" &&
              "name" in error &&
              error.name === "NotAllowedError"
            ) {
              this.update({
                id,
                status: "blocked",
                error: null,
                ...progress,
                seconds: Math.floor(audio.currentTime || 0),
              });
              return;
            }
            reject(
              new Error(
                "Audio could not play. Try Listen again or read the text.",
              ),
            );
          };
          const startAudio = () => {
            if (!isCurrent()) return;
            const thisAttempt = ++attempt;
            waitingForStart = true;
            this.clearStartTimer();
            this.update({
              id,
              status: "loading",
              error: null,
              ...progress,
              seconds: Math.floor(audio.currentTime || 0),
            });
            // Called directly by the Play audio click when blocked. No promise
            // or fetch may precede play(), or browser activation can be lost.
            try {
              const started = audio.play();
              this.playbackStartTimer = setTimeout(() => {
                if (!isCurrent() || thisAttempt !== attempt || !waitingForStart)
                  return;
                waitingForStart = false;
                ++attempt;
                this.playbackStartTimer = null;
                // Some embedded browsers leave play() pending forever. Pause
                // that attempt so a late resolution cannot start behind Play.
                audio.pause();
                this.update({
                  id,
                  status: "blocked",
                  error: null,
                  ...progress,
                  seconds: Math.floor(audio.currentTime || 0),
                });
              }, 10_000);
              void started.then(
                () => startedPlaying(thisAttempt),
                (error: unknown) => failed(error, thisAttempt),
              );
            } catch (error) {
              failed(error, thisAttempt);
            }
          };
          this.resumePlayback = startAudio;
          audio.onended = () => resolve();
          audio.onplaying = () => startedPlaying(attempt);
          audio.ontimeupdate = () => {
            if (!isCurrent() || this.state.status !== "playing") return;
            const seconds = Math.floor(audio.currentTime || 0);
            if (seconds !== this.state.seconds)
              this.update({ ...this.state, seconds });
          };
          audio.onerror = () =>
            reject(
              new Error(
                "Audio could not play. Try Listen again or read the text.",
              ),
            );
          startAudio();
        });
        if (generation !== this.generation) return;
        this.releaseAudio();
      }
      if (generation !== this.generation) return;
      this.controller = null;
      this.update({ id, status: "ended", error: null });
      onComplete?.();
    } catch (error) {
      if (generation !== this.generation) return;
      controller.abort();
      this.controller = null;
      this.releaseAudio();
      this.update({
        id,
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Read aloud is unavailable. You can still read the text.",
      });
    }
  }

  /** Synchronous entry point for a fresh browser user gesture. */
  resume(id: string) {
    if (
      this.state.id !== id ||
      this.state.status !== "blocked" ||
      getSpeechActivity().recording
    )
      return;
    this.resumePlayback?.();
  }

  stop(id?: string) {
    if (id && this.state.id !== id) return;
    ++this.generation;
    this.controller?.abort();
    this.controller = null;
    const reject = this.rejectPlayback;
    this.rejectPlayback = null;
    this.releaseAudio();
    reject?.(new Error("Playback stopped."));
    this.update({ id: null, status: "idle", error: null });
  }

  dispose() {
    this.stop();
    this.unsubscribeActivity();
    this.listeners.clear();
  }

  private releaseAudio() {
    this.clearStartTimer();
    this.rejectPlayback = null;
    this.resumePlayback = null;
    if (this.audio) {
      this.audio.onended =
        this.audio.onerror =
        this.audio.ontimeupdate =
        this.audio.onplaying =
          null;
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.audio.remove();
      this.audio = null;
    }
    if (this.audioUrl) this.dependencies.revokeUrl(this.audioUrl);
    this.audioUrl = null;
  }

  private clearStartTimer() {
    if (this.playbackStartTimer !== null) clearTimeout(this.playbackStartTimer);
    this.playbackStartTimer = null;
  }

  private update(state: PlaybackState) {
    this.state = state;
    setSpeechActivity({
      playing: state.status === "playing" || state.status === "loading",
    });
    this.listeners.forEach((listener) => listener());
  }
}

export const speechPlayer = new SpeechPlayer();
export const stopSpeech = (id?: string) => speechPlayer.stop(id);
