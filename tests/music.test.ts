import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MusicPlayer } from "../client/src/lib/music";
import { MUSIC_CUES } from "../client/src/lib/music-cues";

type Automation = {
  type: "set" | "ramp" | "target" | "hold" | "curve";
  time: number;
  value?: number;
  duration?: number;
  values?: Float32Array;
};
class Parameter {
  value = 1;
  events: Automation[] = [];
  setValueAtTime(value: number, time: number) {
    this.events.push({ type: "set", value, time });
    this.value = value;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ type: "ramp", value, time });
  }
  setTargetAtTime(value: number, time: number, duration: number) {
    this.events.push({ type: "target", value, time, duration });
  }
  setValueCurveAtTime(values: Float32Array, time: number, duration: number) {
    this.events.push({ type: "curve", values, time, duration });
  }
  cancelAndHoldAtTime(time: number) {
    this.events.push({ type: "hold", time });
  }
}
class Node {
  gain = new Parameter();
  destination: Node | null = null;
  connected = true;
  connect(destination: Node) {
    this.destination = destination;
    return destination;
  }
  disconnect() {
    this.connected = false;
  }
}
class Source extends Node {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  starts: [number, number][] = [];
  stops: (number | undefined)[] = [];
  start(time: number, offset: number) {
    this.starts.push([time, offset]);
  }
  stop(time?: number) {
    this.stops.push(time);
  }
}
class Context {
  currentTime = 0;
  state: AudioContextState = "running";
  destination = new Node();
  gains: Node[] = [];
  sources: Source[] = [];
  listeners = new Map<string, () => void>();
  close = vi.fn();
  resume = vi.fn();
  decodeAudioData = vi.fn(async () => ({ duration: 80 }) as AudioBuffer);
  createGain() {
    const gain = new Node();
    this.gains.push(gain);
    return gain;
  }
  createBufferSource() {
    const source = new Source();
    this.sources.push(source);
    return source;
  }
  addEventListener(type: string, callback: () => void) {
    this.listeners.set(type, callback);
  }
  removeEventListener(type: string) {
    this.listeners.delete(type);
  }
  tick(time: number) {
    this.currentTime = time;
    vi.advanceTimersByTime(250);
  }
}
const response = () =>
  ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) as Response;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function drain() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
function liveSources(ctx: Context) {
  return ctx.sources.filter((source) => source.connected);
}

describe("chapter music playback", () => {
  let ctx: Context;
  let player: MusicPlayer;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  let errors: ReturnType<typeof vi.fn<(error: Error) => void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    ctx = new Context();
    fetcher = vi.fn(async () => response());
    errors = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    player = new MusicPlayer(ctx as unknown as AudioContext, errors);
  });
  afterEach(() => {
    player.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads only the requested cue and does not replay on repeated state updates", async () => {
    expect(fetcher).not.toHaveBeenCalled();
    const first = player.setCue("opening");
    expect(player.setCue("opening")).toBe(first);
    await first;
    await player.setCue("opening");
    player.setVolume(0.4, false, false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(MUSIC_CUES.opening.url);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].starts[0][1]).toBe(0);
    expect(ctx.close).not.toHaveBeenCalled();
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("keeps the audible chapter during loading, then crossfades for two seconds", async () => {
    await player.setCue("opening");
    const old = ctx.sources[0];
    ctx.tick(10);
    const download = deferred<Response>();
    fetcher.mockReturnValueOnce(download.promise);
    const next = player.setCue("E1");
    expect(liveSources(ctx)).toEqual([old]);
    expect(old.stops).toEqual([MUSIC_CUES.opening.loopEndSeconds + 0.02]);
    download.resolve(response());
    await next;
    expect(liveSources(ctx)).toHaveLength(2);
    expect(old.stops.at(-1)).toBe(12);
    expect(old.destination?.destination?.gain.events).toContainEqual({
      type: "ramp",
      value: 0,
      time: 12,
    });
    expect(ctx.sources[1].destination?.destination?.gain.events).toContainEqual(
      {
        type: "ramp",
        value: 1,
        time: 12,
      },
    );
    ctx.tick(12.1);
    expect(liveSources(ctx)).toEqual([ctx.sources[1]]);
  });

  it("repeats using scheduled equal-power overlap before the silent tail", async () => {
    await player.setCue("E2");
    const { loopEndSeconds: end, crossfadeSeconds: overlap } = MUSIC_CUES.E2;
    const start = ctx.sources[0].starts[0][0];
    ctx.tick(start + end - overlap - 0.5);
    expect(ctx.sources).toHaveLength(2);
    const second = ctx.sources[1];
    expect(second.starts[0]).toEqual([start + end - overlap, 0]);
    const out = ctx.sources[0].destination!.gain.events.find(
      (event) => event.type === "curve",
    )!;
    const incoming = second.destination!.gain.events.find(
      (event) => event.type === "curve",
    )!;
    expect(out.time).toBeCloseTo(incoming.time, 8);
    expect(out.duration).toBe(overlap);
    expect(incoming.duration).toBe(overlap);
    for (let i = 0; i < out.values!.length; i++) {
      expect(out.values![i] ** 2 + incoming.values![i] ** 2).toBeCloseTo(1, 5);
    }
    expect(ctx.sources[0].stops[0]).toBe(start + end);
    expect(ctx.sources[0].stops[0]).toBeLessThan(80);
    expect(fetcher).toHaveBeenCalledOnce();
    ctx.tick(start + end + 0.1);
    expect(liveSources(ctx)).toEqual([second]);
  });

  it("rejects only the current failed load, reports it once, and permits retry", async () => {
    await player.setCue("opening");
    fetcher.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    await expect(player.setCue("E1")).rejects.toThrow("503");
    expect(errors).toHaveBeenCalledOnce();
    expect(ctx.sources).toHaveLength(1);
    await player.setCue("E1");
    expect(ctx.sources).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("stopping after a failed chapter load still stops the previously audible cue", async () => {
    await player.setCue("opening");
    fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(player.setCue("E1")).rejects.toThrow("offline");
    await player.setCue(null);
    ctx.tick(3);
    expect(liveSources(ctx)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a superseded download and ignores its late response", async () => {
    const download = deferred<Response>();
    fetcher.mockReturnValueOnce(download.promise);
    const first = player.setCue("E1");
    const signal = fetcher.mock.calls[0][1]!.signal!;
    await player.setCue("E2");
    expect(signal.aborted).toBe(true);
    download.resolve(response());
    await first;
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.decodeAudioData).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  });

  it("discards late decoding and returning to the current cue cancels pending replacement", async () => {
    await player.setCue("opening");
    const decoding = deferred<AudioBuffer>();
    ctx.decodeAudioData.mockReturnValueOnce(decoding.promise);
    const replacement = player.setCue("E1");
    await drain();
    await player.setCue("opening");
    decoding.resolve({ duration: 80 } as AudioBuffer);
    await replacement;
    expect(ctx.sources).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("rapid chapter changes retain at most the incoming and outgoing chapter", async () => {
    await player.setCue("opening");
    await player.setCue("E1");
    await player.setCue("E2");
    await player.setCue("E3");
    expect(ctx.sources).toHaveLength(4);
    expect(liveSources(ctx)).toHaveLength(2);
    ctx.tick(3);
    expect(liveSources(ctx)).toEqual([ctx.sources[3]]);
  });

  it("reuses recent decoded buffers without restarting the current cue", async () => {
    await player.setCue("opening");
    await player.setCue("E1");
    await player.setCue("opening");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(2);
    await player.setCue("opening");
    expect(ctx.sources).toHaveLength(3);
  });

  it("ducks for speech, mutes a hidden tab and restores the user volume smoothly", () => {
    const master = ctx.gains[0].gain;
    player.setVolume(0.6, false, false);
    expect(master.events.at(-1)).toMatchObject({ type: "target", value: 0.6 });
    player.setVolume(0.6, true, false);
    expect(master.events.at(-1)).toMatchObject({ type: "target", value: 0.09 });
    player.setVolume(0.6, true, true);
    expect(master.events.at(-1)).toMatchObject({ type: "target", value: 0 });
    player.setVolume(0.6, false, false);
    expect(master.events.at(-1)).toMatchObject({ type: "target", value: 0.6 });
    const count = master.events.length;
    player.setVolume(0.6, false, false);
    expect(master.events).toHaveLength(count);
    player.setVolume(50, false, false);
    expect(master.events.at(-1)?.value).toBe(1);
    player.setVolume(Number.NaN, false, false);
    expect(master.events.at(-1)?.value).toBe(0);
  });

  it("does not pile up voices while the audio clock is suspended", async () => {
    await player.setCue("E3");
    ctx.state = "suspended";
    vi.advanceTimersByTime(180_000);
    expect(ctx.sources).toHaveLength(1);
    ctx.state = "running";
    ctx.listeners.get("statechange")?.();
    expect(ctx.sources).toHaveLength(1);
  });

  it("recovers the current phrase after timer throttling without replaying missed loops", async () => {
    await player.setCue("E2");
    const period =
      MUSIC_CUES.E2.loopEndSeconds - MUSIC_CUES.E2.crossfadeSeconds;
    const intended = 0.02 + period * 8;
    ctx.tick(intended + 12);
    expect(liveSources(ctx)).toHaveLength(1);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1].starts[0][1]).toBeCloseTo(12.01, 5);
    expect(ctx.sources[1].stops[0]).toBeCloseTo(
      intended + MUSIC_CUES.E2.loopEndSeconds,
    );
  });

  it("releases every source, gain, timer and load without closing the injected context", async () => {
    await player.setCue("opening");
    const download = deferred<Response>();
    fetcher.mockReturnValueOnce(download.promise);
    const pending = player.setCue("E1");
    const signal = fetcher.mock.calls[1][1]!.signal!;
    player.close();
    player.close();
    expect(signal.aborted).toBe(true);
    expect(liveSources(ctx)).toHaveLength(0);
    expect(ctx.gains.every((gain) => !gain.connected)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.listeners.size).toBe(0);
    expect(ctx.close).not.toHaveBeenCalled();
    download.resolve(response());
    await pending;
    await player.setCue("ending");
    expect(ctx.sources).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });
});
