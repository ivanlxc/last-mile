import { MUSIC_CUES, type MusicCue } from "./music-cues";

const CHAPTER_FADE_SECONDS = 2;
const LOOKAHEAD_SECONDS = 1;
const SCHEDULER_MS = 250;
const MAX_CACHED_CUES = 3;

type Voice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  end: number;
};

type PlayingCue = {
  cue: MusicCue;
  buffer: AudioBuffer;
  gain: GainNode;
  voices: Set<Voice>;
  loopEnd: number;
  overlap: number;
  nextStart: number;
  retireAt: number | null;
};

function hold(param: AudioParam, time: number) {
  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(time);
  } else {
    const value = param.value;
    param.cancelScheduledValues(time);
    param.setValueAtTime(value, time);
  }
}

/** Presentation-only score playback. The caller owns the shared AudioContext. */
export class MusicPlayer {
  private readonly master: GainNode;
  private readonly cache = new Map<MusicCue, AudioBuffer>();
  private readonly groups = new Set<PlayingCue>();
  private current: PlayingCue | null = null;
  private requested: MusicCue | null = null;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private targetVolume = 0;

  constructor(
    private readonly context: AudioContext,
    private readonly onError?: (error: Error) => void,
  ) {
    this.master = context.createGain();
    this.master.gain.value = 0;
    this.master.connect(context.destination);
    context.addEventListener("statechange", this.schedule);
  }

  /** Repeated requests for the same cue retain both its playhead and pending load. */
  setCue(cue: MusicCue | null): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (cue === this.requested) return this.pending ?? Promise.resolve();
    this.requested = cue;
    const generation = ++this.generation;
    this.controller?.abort();
    this.controller = null;
    this.pending = null;

    if (cue === null) {
      this.retireCurrent();
      return Promise.resolve();
    }
    // Returning to the audible cue while another asset loads is cancellation,
    // not a request to replay the audible track from its beginning.
    if (this.current?.cue === cue) return Promise.resolve();

    const controller = new AbortController();
    this.controller = controller;
    const isCurrent = () => !this.closed && this.generation === generation;
    const pending = this.load(cue, controller.signal)
      .then((buffer) => {
        if (!isCurrent()) return;
        this.activate(cue, buffer);
        this.remember(cue, buffer);
      })
      .catch((reason: unknown) => {
        if (!isCurrent()) return;
        this.requested = this.current?.cue ?? null;
        const error =
          reason instanceof Error ? reason : new Error("Music could not load.");
        this.onError?.(error);
        throw error;
      })
      .finally(() => {
        if (!isCurrent()) return;
        this.controller = null;
        this.pending = null;
      });
    this.pending = pending;
    return pending;
  }

  setVolume(volume: number, ducked: boolean, hidden: boolean) {
    if (this.closed) return;
    const level = Number.isFinite(volume)
      ? Math.max(0, Math.min(1, volume))
      : 0;
    const target = hidden ? 0 : level * (ducked ? 0.15 : 1);
    if (target !== this.targetVolume) {
      this.targetVolume = target;
      const now = this.context.currentTime;
      hold(this.master.gain, now);
      this.master.gain.setTargetAtTime(target, now, 0.15);
    }
    // Visibility changes can be the first callback after a throttled tab wakes.
    this.schedule();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.pending = null;
    this.current = null;
    this.requested = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.context.removeEventListener("statechange", this.schedule);
    for (const group of [...this.groups]) this.disposeGroup(group);
    this.cache.clear();
    this.master.disconnect();
  }

  private async load(cue: MusicCue, signal: AbortSignal): Promise<AudioBuffer> {
    const cached = this.cache.get(cue);
    if (cached) return cached;
    const response = await fetch(MUSIC_CUES[cue].url, { signal });
    if (!response.ok)
      throw new Error(`Music download failed (${response.status}).`);
    const bytes = await response.arrayBuffer();
    if (signal.aborted)
      throw new DOMException("Music load cancelled.", "AbortError");
    return this.context.decodeAudioData(bytes);
  }

  private remember(cue: MusicCue, buffer: AudioBuffer) {
    this.cache.delete(cue);
    this.cache.set(cue, buffer);
    while (this.cache.size > MAX_CACHED_CUES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private activate(cue: MusicCue, buffer: AudioBuffer) {
    const metadata = MUSIC_CUES[cue];
    const loopEnd = Math.min(metadata.loopEndSeconds, buffer.duration);
    const overlap = metadata.crossfadeSeconds;
    if (
      !Number.isFinite(loopEnd) ||
      !Number.isFinite(overlap) ||
      overlap <= 0 ||
      loopEnd <= overlap * 2
    ) {
      throw new Error("Music has invalid playback timing.");
    }
    this.retireCurrent();
    const now = this.context.currentTime;
    const start = now + 0.02;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + CHAPTER_FADE_SECONDS);
    gain.connect(this.master);
    const group: PlayingCue = {
      cue,
      buffer,
      gain,
      voices: new Set(),
      loopEnd,
      overlap,
      nextStart: start + loopEnd - overlap,
      retireAt: null,
    };
    this.current = group;
    this.groups.add(group);
    this.startVoice(group, start, true);
    if (this.timer === null)
      this.timer = setInterval(this.schedule, SCHEDULER_MS);
  }

  private retireCurrent() {
    // At most one outgoing chapter is retained even during rapid navigation.
    for (const group of [...this.groups]) {
      if (group !== this.current) this.disposeGroup(group);
    }
    if (!this.current) return;
    const now = this.context.currentTime;
    const group = this.current;
    group.retireAt = now + CHAPTER_FADE_SECONDS;
    hold(group.gain.gain, now);
    group.gain.gain.linearRampToValueAtTime(0, group.retireAt);
    for (const voice of group.voices) {
      voice.end = Math.min(voice.end, group.retireAt);
      voice.source.stop(voice.end);
    }
    this.current = null;
  }

  private readonly schedule = () => {
    if (this.closed) return;
    const now = this.context.currentTime;
    for (const group of [...this.groups]) {
      for (const voice of [...group.voices]) {
        if (voice.end <= now) this.disposeVoice(group, voice);
      }
      if (group.retireAt !== null && group.retireAt <= now) {
        this.disposeGroup(group);
      }
    }
    const group = this.current;
    if (group) {
      const period = group.loopEnd - group.overlap;
      // Skip expired repetitions in one step after long background throttling.
      if (group.nextStart + group.loopEnd <= now) {
        group.nextStart +=
          (Math.floor((now - group.nextStart - group.loopEnd) / period) + 1) *
          period;
      }
      while (group.nextStart < now + LOOKAHEAD_SECONDS) {
        this.startVoice(group, group.nextStart, false);
        group.nextStart += period;
      }
    }
    if (this.groups.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  };

  private startVoice(group: PlayingCue, intendedStart: number, first: boolean) {
    const now = this.context.currentTime;
    const start = Math.max(intendedStart, now + 0.01);
    const offset = start - intendedStart;
    const end = intendedStart + group.loopEnd;
    if (start >= end) return;
    const source = this.context.createBufferSource();
    source.buffer = group.buffer;
    const gain = this.context.createGain();
    const fadeOutStart = end - group.overlap;
    const curve = (from: number, to: number, rise: boolean) =>
      Float32Array.from({ length: 65 }, (_, i) => {
        const phase = from + ((to - from) * i) / 64;
        return rise
          ? Math.sin((phase * Math.PI) / 2)
          : Math.cos((phase * Math.PI) / 2);
      });
    if (!first && offset < group.overlap) {
      gain.gain.setValueCurveAtTime(
        curve(offset / group.overlap, 1, true),
        start,
        group.overlap - offset,
      );
    } else if (start < fadeOutStart) {
      gain.gain.setValueAtTime(1, start);
    }
    // Equal-power overlap avoids a dip when two uncorrelated phrases meet.
    const decayStart = Math.max(start, fadeOutStart);
    gain.gain.setValueCurveAtTime(
      curve((decayStart - fadeOutStart) / group.overlap, 1, false),
      decayStart,
      end - decayStart,
    );
    source.connect(gain).connect(group.gain);
    const voice: Voice = { source, gain, end };
    group.voices.add(voice);
    source.onended = () => this.disposeVoice(group, voice);
    source.start(start, offset);
    source.stop(end);
  }

  private disposeVoice(group: PlayingCue, voice: Voice) {
    if (!group.voices.delete(voice)) return;
    voice.source.onended = null;
    try {
      voice.source.stop();
    } catch {
      // A source can already be stopped by a scheduled boundary or close().
    }
    voice.source.disconnect();
    voice.gain.disconnect();
  }

  private disposeGroup(group: PlayingCue) {
    for (const voice of [...group.voices]) this.disposeVoice(group, voice);
    group.gain.disconnect();
    this.groups.delete(group);
  }
}
