import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type {
  HandWorkerRequest,
  HandWorkerResponse,
  TrackedHand,
} from "./types";

// A module worker is required in both Vite development and production. Version
// 1.0.1's module WASM loader sets ModuleFactory after its same-origin ESM import.
const scope = globalThis as unknown as {
  location: Location;
  onmessage: ((event: MessageEvent<HandWorkerRequest>) => void) | null;
  postMessage(message: HandWorkerResponse): void;
};

let detector: HandLandmarker | null = null;
let initializing = false;

function reportError(code: "model" | "worker", error: unknown): void {
  scope.postMessage({
    type: "error",
    code,
    message: error instanceof Error ? error.message : "Hand tracking failed.",
  });
}

async function initialize(): Promise<void> {
  if (initializing || detector) return;
  initializing = true;
  try {
    if (typeof OffscreenCanvas === "undefined") {
      throw new Error(
        "This browser does not support a camera tracking worker.",
      );
    }
    const assetBase = new URL(
      "/gestures/mediapipe/1.0.1/wasm",
      scope.location.origin,
    ).href;
    const fileset = await FilesetResolver.forVisionTasks(assetBase, true);
    detector = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: new URL(
          "/gestures/models/hand_landmarker-float16-v1.task",
          scope.location.origin,
        ).href,
        delegate: "CPU",
      },
      canvas: new OffscreenCanvas(640, 480),
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });
    scope.postMessage({ type: "ready" });
  } catch (error) {
    detector?.close();
    detector = null;
    reportError("model", error);
  } finally {
    initializing = false;
  }
}

scope.onmessage = (event): void => {
  const request = event.data;
  if (request.type === "initialize") {
    void initialize();
    return;
  }
  if (request.type !== "frame") return;

  // detectForVideo is synchronous, but all of that work remains in this worker.
  // Ownership of this bitmap was transferred by the page; close it even on error.
  try {
    if (!detector) throw new Error("Hand tracking is not initialized.");
    const started = performance.now();
    const result = detector.detectForVideo(request.bitmap, request.timestampMs);
    const hands: TrackedHand[] = result.landmarks.map((landmarks, index) => ({
      landmarks: landmarks.map(({ x, y, z }) => ({ x, y, z })),
      worldLandmarks: result.worldLandmarks[index]?.map(({ x, y, z }) => ({
        x,
        y,
        z,
      })),
      // Preserve the Tasks label convention on this unmirrored bitmap. The
      // legacy Hands solution's selfie-label swap must not be applied here.
      handedness: result.handedness[index]?.[0]?.categoryName,
      confidence: result.handedness[index]?.[0]?.score,
    }));
    scope.postMessage({
      type: "frame",
      frameId: request.frameId,
      frame: {
        hands,
        timestampMs: request.timestampMs,
        aspect: request.aspect,
        inferenceMs: performance.now() - started,
      },
    });
  } catch (error) {
    reportError("worker", error);
  } finally {
    request.bitmap.close();
  }
};
