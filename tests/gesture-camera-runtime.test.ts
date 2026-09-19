import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CameraRuntime,
  type CameraRuntimeCallbacks,
} from "../client/src/lib/gestures/cameraRuntime";
import type {
  HandWorkerRequest,
  HandWorkerResponse,
} from "../client/src/lib/gestures/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function drain() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<HandWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage =
    vi.fn<(request: HandWorkerRequest, transfer?: Transferable[]) => void>();
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  send(response: HandWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<HandWorkerResponse>);
  }
}

function mediaStream() {
  const events = new EventTarget();
  const track = {
    stop: vi.fn(),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return {
    stream,
    track,
    disconnect: () => events.dispatchEvent(new Event("ended")),
  };
}

describe("camera runtime lifecycle", () => {
  let getUserMedia: ReturnType<
    typeof vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>
  >;
  let createBitmap: ReturnType<typeof vi.fn<() => Promise<ImageBitmap>>>;
  let frames: Map<number, FrameRequestCallback>;
  let video: HTMLVideoElement;
  let runtime: CameraRuntime;
  let onState: ReturnType<
    typeof vi.fn<NonNullable<CameraRuntimeCallbacks["onState"]>>
  >;
  let onError: ReturnType<
    typeof vi.fn<NonNullable<CameraRuntimeCallbacks["onError"]>>
  >;
  let onFrame: ReturnType<typeof vi.fn<CameraRuntimeCallbacks["onFrame"]>>;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    getUserMedia = vi.fn();
    createBitmap = vi.fn();
    frames = new Map();
    let frameSequence = 0;
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal("createImageBitmap", createBitmap);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++frameSequence;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    video = {
      srcObject: null,
      muted: false,
      playsInline: false,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      readyState: 4,
      videoWidth: 640,
      videoHeight: 480,
      currentTime: 1,
    } as unknown as HTMLVideoElement;
    onState = vi.fn();
    onError = vi.fn();
    onFrame = vi.fn();
    runtime = new CameraRuntime(video, { onState, onError, onFrame });
  });

  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function running() {
    const media = mediaStream();
    getUserMedia.mockResolvedValueOnce(media.stream);
    const start = runtime.start();
    await drain();
    const worker = FakeWorker.instances.at(-1)!;
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "initialize" });
    worker.send({ type: "ready" });
    await start;
    return { ...media, worker };
  }

  function nextAnimationFrame() {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    callback(performance.now());
  }

  it("stops a permission-pending start immediately and closes its eventual stream", async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    const stopped = runtime.start().catch((error: unknown) => error);
    runtime.stop();
    expect(await stopped).toMatchObject({ name: "AbortError" });
    const media = mediaStream();
    permission.resolve(media.stream);
    await drain();
    expect(media.track.stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(video.play).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(onState.mock.calls.map(([state]) => state)).toEqual([
      "starting",
      "idle",
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not let a superseded permission response steal a newer running stream", async () => {
    const oldPermission = deferred<MediaStream>();
    getUserMedia.mockReturnValueOnce(oldPermission.promise);
    const oldStart = runtime.start().catch((error: unknown) => error);
    const current = await running();
    expect(await oldStart).toMatchObject({ name: "AbortError" });
    const obsolete = mediaStream();
    oldPermission.resolve(obsolete.stream);
    await drain();
    expect(obsolete.track.stop).toHaveBeenCalledTimes(1);
    expect(current.track.stop).not.toHaveBeenCalled();
    expect(current.worker.terminate).not.toHaveBeenCalled();
    expect(video.srcObject).toBe(current.stream);
    expect(onState).toHaveBeenLastCalledWith("running");
    expect(onError).not.toHaveBeenCalled();
  });

  it("releases the stream while video playback is pending and never starts a late worker", async () => {
    const playback = deferred<void>();
    vi.mocked(video.play).mockReturnValueOnce(playback.promise);
    const media = mediaStream();
    getUserMedia.mockResolvedValueOnce(media.stream);
    const start = runtime.start().catch((error: unknown) => error);
    await drain();
    expect(video.srcObject).toBe(media.stream);
    runtime.stop();
    expect(await start).toMatchObject({ name: "AbortError" });
    expect(media.track.stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    playback.resolve();
    await drain();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("terminates model initialization and ignores a late ready message after disposal", async () => {
    const media = mediaStream();
    getUserMedia.mockResolvedValueOnce(media.stream);
    const start = runtime.start().catch((error: unknown) => error);
    await drain();
    const worker = FakeWorker.instances[0];
    const lateMessage = worker.onmessage!;
    runtime.dispose();
    expect(await start).toMatchObject({ name: "AbortError" });
    lateMessage({
      data: { type: "ready" },
    } as MessageEvent<HandWorkerResponse>);
    await drain();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(media.track.stop).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(onState).not.toHaveBeenCalledWith("running");
    await expect(runtime.start()).rejects.toMatchObject({ name: "AbortError" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("times out a pending permission request and closes a stream granted after timeout", async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    const start = runtime.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await start).toMatchObject({ code: "timeout" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "timeout" }),
    );
    const media = mediaStream();
    permission.resolve(media.stream);
    await drain();
    expect(media.track.stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports permission denial once and leaves no camera, worker or timer alive", async () => {
    getUserMedia.mockRejectedValueOnce(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    await expect(runtime.start()).rejects.toMatchObject({ code: "permission" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenLastCalledWith("idle");
    expect(video.srcObject).toBeNull();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a bitmap created after stop without transferring it to the old worker", async () => {
    const { worker, track } = await running();
    const bitmapCreation = deferred<ImageBitmap>();
    createBitmap.mockReturnValueOnce(bitmapCreation.promise);
    nextAnimationFrame();
    expect(createBitmap).toHaveBeenCalledTimes(1);
    runtime.stop();
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    bitmapCreation.resolve(bitmap);
    await drain();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("never lets an old capture transfer its bitmap into a replacement worker", async () => {
    const old = await running();
    const bitmapCreation = deferred<ImageBitmap>();
    createBitmap.mockReturnValueOnce(bitmapCreation.promise);
    nextAnimationFrame();
    const current = await running();
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    bitmapCreation.resolve(bitmap);
    await drain();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(old.worker.postMessage).toHaveBeenCalledTimes(1);
    expect(current.worker.postMessage).toHaveBeenCalledTimes(1);
    expect(current.worker.terminate).not.toHaveBeenCalled();
    expect(video.srcObject).toBe(current.stream);
    expect(onError).not.toHaveBeenCalled();
  });

  it("releases running capture on device disconnection without reporting duplicate errors", async () => {
    const media = await running();
    media.disconnect();
    media.disconnect();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "device" }),
    );
    expect(media.worker.terminate).toHaveBeenCalledTimes(1);
    expect(media.track.stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
