export interface HandLandmark {
  x: number;
  y: number;
  z?: number;
}

export interface TrackedHand {
  /** Unmirrored normalized video coordinates; x goes right and y goes down. */
  landmarks: HandLandmark[];
  /** Coordinates relative to this hand's center, not a shared two-hand space. */
  worldLandmarks?: HandLandmark[];
  handedness?: string;
  /** Handedness confidence, not a per-landmark tracking confidence. */
  confidence?: number;
}

export interface CameraFrame {
  hands: TrackedHand[];
  /** Capture time on the page's performance.now() clock. */
  timestampMs: number;
  aspect: number;
  inferenceMs: number;
}

export type CameraRuntimeState = "idle" | "starting" | "running";
export type CameraErrorCode =
  | "unsupported"
  | "permission"
  | "device"
  | "model"
  | "timeout"
  | "capture"
  | "worker";

export class CameraRuntimeError extends Error {
  constructor(
    public readonly code: CameraErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CameraRuntimeError";
  }
}

export type HandWorkerRequest =
  | { type: "initialize" }
  | {
      type: "frame";
      frameId: number;
      bitmap: ImageBitmap;
      timestampMs: number;
      aspect: number;
    };

export type HandWorkerResponse =
  | { type: "ready" }
  | { type: "frame"; frameId: number; frame: CameraFrame }
  | { type: "error"; code: "model" | "worker"; message: string };
