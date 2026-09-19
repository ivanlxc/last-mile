import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Pcm16Resampler,
  pcm16LittleEndian,
} from "../client/public/audio/pcm16.js";
import {
  appendTranscript,
  TranscriptBuffer,
} from "../client/src/lib/speech/transcript";
import {
  SpeechCapture,
  type RecordingResult,
} from "../client/src/lib/speech/capture";
import { getSpeechActivity } from "../client/src/lib/speech/activity";

describe("streaming microphone audio", () => {
  it.each([44100, 48000])(
    "keeps exact fractional positions across %i Hz render blocks",
    (sampleRate) => {
      const input = Float32Array.from({ length: sampleRate }, (_, index) =>
        Math.sin(index * 0.036),
      );
      const reference = new Pcm16Resampler(sampleRate).push(input);
      const streaming = new Pcm16Resampler(sampleRate);
      const blocks: number[] = [];
      for (let start = 0; start < input.length; start += 128) {
        blocks.push(...streaming.push(input.subarray(start, start + 128)));
      }
      expect(blocks).toEqual(Array.from(reference));
      expect(blocks).toHaveLength(16000);
    },
  );
  it("clamps invalid samples and emits explicit little-endian signed PCM", () => {
    const samples = new Pcm16Resampler(16000).push(
      Float32Array.from([-2, 2, NaN, 0.5, -0.5]),
    );
    expect(Array.from(samples)).toEqual([-32768, 32767, 0, 16384, -16384]);
    expect(
      Array.from(new Uint8Array(pcm16LittleEndian(samples))).slice(0, 6),
    ).toEqual([0, 128, 255, 127, 0, 0]);
  });
});

describe("transcription draft", () => {
  it("replaces interim guesses, deduplicates final segment IDs, and keeps deliberate repeated sentences", () => {
    const transcript = new TranscriptBuffer();
    transcript.accept({
      type: "transcript",
      text: "Check the",
      isFinal: false,
      speechFinal: false,
    });
    expect(
      transcript.accept({
        type: "transcript",
        text: "Check the bridge",
        isFinal: false,
        speechFinal: false,
      }).interim,
    ).toBe("Check the bridge");
    const final = {
      type: "transcript" as const,
      text: "Check the bridge.",
      isFinal: true,
      speechFinal: true,
      segmentId: "0:1.6",
    };
    transcript.accept(final);
    transcript.accept(final);
    transcript.accept({ ...final, segmentId: "2:1.6" });
    expect(transcript.snapshot()).toEqual({
      confirmed: "Check the bridge. Check the bridge.",
      interim: "",
    });
  });
  it("preserves a typed draft and marks limit truncation for explicit review", () => {
    expect(
      appendTranscript("My constraint: ", "the convoy needs fuel."),
    ).toEqual({
      text: "My constraint: the convoy needs fuel.",
      truncated: false,
    });
    expect(appendTranscript("abc", "def", 5)).toEqual({
      text: "abc d",
      truncated: true,
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function drain() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor() {
    FakeSocket.instances.push(this);
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
class FakeContext {
  static instances: FakeContext[] = [];
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  source = { connect: vi.fn(), disconnect: vi.fn() };
  createMediaStreamSource = vi.fn(() => this.source);
  constructor() {
    FakeContext.instances.push(this);
  }
}
class FakeNode {
  static instances: FakeNode[] = [];
  port = {
    onmessage: null as
      | ((event: { data: { type: string; buffer?: ArrayBuffer } }) => void)
      | null,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  onprocessorerror: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() {
    FakeNode.instances.push(this);
  }
  send(data: { type: string; buffer?: ArrayBuffer }) {
    this.port.onmessage?.({ data });
  }
}
function microphone() {
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return {
    track,
    stream: {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream,
  };
}

describe("microphone session cleanup and final draining", () => {
  let capture: SpeechCapture;
  let media: ReturnType<typeof microphone>;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let onFinish: ReturnType<typeof vi.fn<(result: RecordingResult) => void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    FakeNode.instances = [];
    FakeContext.instances = [];
    media = microphone();
    getUserMedia = vi.fn(async () => media.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("window", {
      location: { href: "http://localhost:5173/" },
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal("AudioContext", FakeContext);
    vi.stubGlobal("AudioWorkletNode", FakeNode);
    vi.stubGlobal("WebSocket", FakeSocket);
    onFinish = vi.fn();
    capture = new SpeechCapture({
      onState: vi.fn(),
      onTranscript: vi.fn(),
      onFinish,
    });
  });
  afterEach(() => {
    capture.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  async function start() {
    const starting = capture.start();
    await drain();
    const socket = FakeSocket.instances[0];
    expect(FakeNode.instances).toHaveLength(0);
    socket.receive({ type: "ready" });
    await starting;
    return {
      socket,
      node: FakeNode.instances[0],
      context: FakeContext.instances[0],
    };
  }
  it("releases a late permission grant without ever opening a voice connection", async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    const starting = capture.start();
    capture.stop();
    permission.resolve(media.stream);
    await starting;
    expect(media.track.stop).toHaveBeenCalledOnce();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(FakeContext.instances[0].close).toHaveBeenCalledOnce();
    expect(getSpeechActivity().recording).toBe(false);
  });
  it("sends the last PCM packet before stop and preserves finals received after the mic closes", async () => {
    const { socket, node, context } = await start();
    capture.stop();
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: "stop" });
    expect(socket.send).not.toHaveBeenCalled();
    const last = new ArrayBuffer(32);
    node.send({ type: "pcm", buffer: last });
    node.send({ type: "flushed" });
    expect(socket.send.mock.calls.map(([data]) => data)).toEqual([
      last,
      '{"type":"stop"}',
    ]);
    expect(media.track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(socket.close).not.toHaveBeenCalled();
    socket.receive({
      type: "transcript",
      text: "Keep the convoy together.",
      isFinal: true,
      speechFinal: true,
      segmentId: "0:2",
    });
    socket.receive({ type: "done" });
    expect(onFinish).toHaveBeenCalledWith({
      confirmed: "Keep the convoy together.",
      partial: false,
    });
    expect(socket.close).toHaveBeenCalledOnce();
    expect(getSpeechActivity().recording).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps confirmed words but never promotes interim guesses after a connection error", async () => {
    const { socket, context } = await start();
    socket.receive({
      type: "transcript",
      text: "Which report",
      isFinal: true,
      speechFinal: false,
    });
    socket.receive({
      type: "transcript",
      text: "proves it",
      isFinal: false,
      speechFinal: false,
    });
    socket.onerror?.();
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: "Which report", partial: true }),
    );
    expect(context.close).toHaveBeenCalledOnce();
    expect(media.track.stop).toHaveBeenCalledOnce();
  });
  it("bounds a missing final response and cleans up all audio resources on disposal", async () => {
    const { node, socket, context } = await start();
    capture.stop();
    node.send({ type: "flushed" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        partial: true,
        error: expect.stringContaining("timed out"),
      }),
    );
    capture.dispose();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(node.port.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("flushes before the server's recording limit instead of losing the final packet", async () => {
    const { node, socket } = await start();
    await vi.advanceTimersByTimeAsync(89_000);
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: "stop" });
    node.send({ type: "pcm", buffer: new ArrayBuffer(20) });
    node.send({ type: "flushed" });
    expect(socket.send.mock.calls.at(-1)).toEqual(['{"type":"stop"}']);
    socket.receive({ type: "done" });
    expect(onFinish).toHaveBeenCalledWith({ confirmed: "", partial: false });
  });
});
