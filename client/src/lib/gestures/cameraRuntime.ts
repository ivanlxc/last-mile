import {
  CameraRuntimeError,
  type CameraFrame,
  type CameraRuntimeState,
  type HandWorkerRequest,
  type HandWorkerResponse,
} from "./types";

export { CameraRuntimeError } from "./types";
export type {
  CameraErrorCode,
  CameraFrame,
  CameraRuntimeState,
  HandLandmark,
  TrackedHand,
} from "./types";

export interface CameraRuntimeCallbacks {
  onFrame(frame: CameraFrame): void;
  onState?(state: CameraRuntimeState): void;
  onError?(error: CameraRuntimeError): void;
}

const STARTUP_TIMEOUT_MS = 30_000;
const FRAME_TIMEOUT_MS = 3_000;
const MAX_RESULT_AGE_MS = 250;
const FRAME_INTERVAL_MS = 1_000 / 25;

function cancellation(): DOMException {
  return new DOMException("Camera tracking was stopped.", "AbortError");
}

function normalizeError(error: unknown): CameraRuntimeError {
  if (error instanceof CameraRuntimeError) return error;
  const name = error instanceof Error ? error.name : "";
  if (
    ["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(name)
  ) {
    return new CameraRuntimeError(
      "permission",
      "Camera access was not allowed.",
    );
  }
  if (
    ["NotFoundError", "OverconstrainedError", "NotReadableError"].includes(name)
  ) {
    return new CameraRuntimeError(
      "device",
      "The selected camera is unavailable.",
    );
  }
  return new CameraRuntimeError(
    "capture",
    error instanceof Error ? error.message : "Camera tracking could not start.",
  );
}

/**
 * Owns one explicit camera session and one inference worker. Video never leaves
 * the browser, and no inference call runs on the page's rendering thread.
 */
export class CameraRuntime {
  private generation = 0;
  private disposed = false;
  private state: CameraRuntimeState = "idle";
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private removeTrackListeners: (() => void) | null = null;
  private cancelStart: ((error: Error) => void) | null = null;
  private cancelModel: ((error: Error) => void) | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private animationId: number | null = null;
  private busy = false;
  private frameId = 0;
  private pendingFrameId = 0;
  private lastCaptureMs = -Infinity;
  private lastVideoTime = -1;
  private lastTimestampMs = -Infinity;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly callbacks: CameraRuntimeCallbacks,
  ) {}

  async start(deviceId?: string): Promise<void> {
    if (this.disposed) throw cancellation();
    this.stop();
    const generation = ++this.generation;
    this.setState("starting");
    if (
      !globalThis.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof Worker === "undefined" ||
      typeof OffscreenCanvas === "undefined" ||
      typeof createImageBitmap === "undefined"
    ) {
      const error = new CameraRuntimeError(
        "unsupported",
        "Camera tracking needs a supported browser on HTTPS or localhost.",
      );
      this.fail(error, generation);
      throw error;
    }

    let rejectCancellation!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    this.cancelStart = rejectCancellation;
    this.startupTimer = setTimeout(() => {
      this.fail(
        new CameraRuntimeError(
          "timeout",
          "Camera tracking took too long to start.",
        ),
        generation,
      );
    }, STARTUP_TIMEOUT_MS);

    try {
      await Promise.race([this.initialize(generation, deviceId), cancelled]);
    } catch (error) {
      if (!this.isCurrent(generation)) throw error;
      const normalized = normalizeError(error);
      this.fail(normalized, generation);
      throw normalized;
    } finally {
      if (this.cancelStart === rejectCancellation) this.cancelStart = null;
    }
  }

  stop(): void {
    this.release(cancellation());
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private setState(state: CameraRuntimeState): void {
    if (state === this.state) return;
    this.state = state;
    this.callbacks.onState?.(state);
  }

  private async initialize(
    generation: number,
    deviceId?: string,
  ): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 30 },
        ...(deviceId
          ? { deviceId: { exact: deviceId } }
          : { facingMode: "user" }),
      },
    });
    // A browser permission dialog cannot be aborted. Its eventual stream still
    // belongs to this old generation and must never restart a stopped session.
    if (!this.isCurrent(generation)) {
      stream.getTracks().forEach((track) => track.stop());
      throw cancellation();
    }
    this.stream = stream;
    const onEnded = (): void => {
      this.fail(
        new CameraRuntimeError("device", "The camera disconnected."),
        generation,
      );
    };
    for (const track of stream.getVideoTracks())
      track.addEventListener("ended", onEnded);
    this.removeTrackListeners = () => {
      for (const track of stream.getVideoTracks())
        track.removeEventListener("ended", onEnded);
    };
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = stream;
    await this.video.play();
    if (!this.isCurrent(generation)) throw cancellation();

    const worker = new Worker(
      new URL("./handLandmarker.worker.ts", import.meta.url),
      {
        type: "module",
        name: "last-mile-hand-tracking",
      },
    );
    this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      this.cancelModel = reject;
      worker.onmessage = (event: MessageEvent<HandWorkerResponse>): void => {
        if (!this.isCurrent(generation)) return;
        const response = event.data;
        if (response.type === "ready") {
          this.cancelModel = null;
          resolve();
        } else if (response.type === "error") {
          this.fail(
            new CameraRuntimeError(response.code, response.message),
            generation,
          );
        } else if (response.type === "frame") {
          if (!this.busy || response.frameId !== this.pendingFrameId) return;
          this.clearFrameTimer();
          this.busy = false;
          // A delayed answer must not move the map using a hand's old position.
          const age = performance.now() - response.frame.timestampMs;
          if (age >= 0 && age <= MAX_RESULT_AGE_MS) {
            this.callbacks.onFrame(response.frame);
          }
        }
      };
      worker.onerror = (): void => {
        this.fail(
          new CameraRuntimeError("worker", "The hand tracking worker stopped."),
          generation,
        );
      };
      worker.onmessageerror = (): void => {
        this.fail(
          new CameraRuntimeError(
            "worker",
            "A hand tracking frame could not be read.",
          ),
          generation,
        );
      };
      const request: HandWorkerRequest = { type: "initialize" };
      worker.postMessage(request);
    });
    if (!this.isCurrent(generation)) throw cancellation();
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.setState("running");
    this.scheduleFrame(generation);
  }

  private scheduleFrame(generation: number): void {
    this.animationId = requestAnimationFrame(() => {
      this.animationId = null;
      if (!this.isCurrent(generation)) return;
      this.scheduleFrame(generation);
      const now = performance.now();
      if (
        this.busy ||
        now - this.lastCaptureMs < FRAME_INTERVAL_MS ||
        this.video.readyState < 2 ||
        !this.video.videoWidth ||
        !this.video.videoHeight ||
        this.video.currentTime === this.lastVideoTime
      )
        return;
      this.lastCaptureMs = now;
      this.lastVideoTime = this.video.currentTime;
      this.lastTimestampMs = Math.max(now, this.lastTimestampMs + 0.001);
      void this.captureFrame(generation, this.lastTimestampMs);
    });
  }

  private async captureFrame(
    generation: number,
    timestampMs: number,
  ): Promise<void> {
    this.busy = true;
    const frameId = ++this.frameId;
    this.pendingFrameId = frameId;
    this.frameTimer = setTimeout(() => {
      this.fail(
        new CameraRuntimeError("timeout", "Hand tracking stopped responding."),
        generation,
      );
    }, FRAME_TIMEOUT_MS);

    let bitmap: ImageBitmap | null = null;
    try {
      const aspect = this.video.videoWidth / this.video.videoHeight;
      const scale = Math.min(
        640 / this.video.videoWidth,
        480 / this.video.videoHeight,
        1,
      );
      bitmap = await createImageBitmap(this.video, {
        resizeWidth: Math.max(1, Math.round(this.video.videoWidth * scale)),
        resizeHeight: Math.max(1, Math.round(this.video.videoHeight * scale)),
        resizeQuality: "low",
      });
      if (!this.isCurrent(generation) || !this.worker) return;
      const request: HandWorkerRequest = {
        type: "frame",
        frameId,
        bitmap,
        timestampMs,
        aspect,
      };
      this.worker.postMessage(request, [bitmap]);
      bitmap = null; // The worker now owns and closes it after detection.
    } catch (error) {
      if (this.isCurrent(generation))
        this.fail(normalizeError(error), generation);
    } finally {
      bitmap?.close();
    }
  }

  private clearFrameTimer(): void {
    if (this.frameTimer !== null) clearTimeout(this.frameTimer);
    this.frameTimer = null;
  }

  private fail(error: CameraRuntimeError, generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.release(error);
    this.callbacks.onError?.(error);
  }

  private release(reason: Error): void {
    ++this.generation;
    this.cancelStart?.(reason);
    this.cancelStart = null;
    this.cancelModel?.(reason);
    this.cancelModel = null;
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.clearFrameTimer();
    if (this.animationId !== null) cancelAnimationFrame(this.animationId);
    this.animationId = null;
    this.removeTrackListeners?.();
    this.removeTrackListeners = null;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.busy = false;
    this.pendingFrameId = 0;
    this.lastVideoTime = -1;
    this.lastCaptureMs = -Infinity;
    this.lastTimestampMs = -Infinity;
    this.setState("idle");
  }
}
