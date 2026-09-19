export type Landmark = { x: number; y: number; z?: number };
export type HandObservation = {
  landmarks: Landmark[];
  worldLandmarks?: Landmark[];
  handedness?: string;
};
export type GestureControlMode = "pan" | "orbit" | "zoom";
export type GestureCameraDelta = {
  mode: GestureControlMode | "stop";
  dx: number;
  dy: number;
  zoomLog: number;
};
export type GestureResult = {
  input: GestureCameraDelta;
  status: "idle" | "arming" | GestureControlMode | "release" | "switching";
  handCount: number;
  controlMode: GestureControlMode;
  modeSwitchProgress: number;
};

type Point = { x: number; y: number };
type Observation = { point: Point; pinchRatio: number; isThumbUp: boolean };
type Track = Observation & { pinched: boolean; pinchSince: number };

const ENTER_PINCH = 0.38;
const EXIT_PINCH = 0.58;
const ARM_MS = 100;
const RELEASE_MS = 120;
const SWITCH_HOLD_MS = 700;
const SWITCH_POSITION_TOLERANCE = 0.12;
const MAX_GAP_MS = 250;
const SMOOTH_MS = 45;
const PAN_DEADZONE = 0.0018;
const ZOOM_DEADZONE = 0.004;
const ZOOM_GAIN = 3;
const PALM_INDICES = [0, 5, 9, 13, 17];
const MODES: GestureControlMode[] = ["pan", "orbit", "zoom"];
const distance = (a: Point, b: Point, aspect: number) =>
  Math.hypot((a.x - b.x) * aspect, a.y - b.y);

function jointBend(a: Landmark, joint: Landmark, b: Landmark): number | null {
  const ax = a.x - joint.x;
  const ay = a.y - joint.y;
  const az = (a.z ?? 0) - (joint.z ?? 0);
  const bx = b.x - joint.x;
  const by = b.y - joint.y;
  const bz = (b.z ?? 0) - (joint.z ?? 0);
  const length = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz);
  if (!Number.isFinite(length) || length < 1e-12) return null;
  const cosine = Math.max(
    -1,
    Math.min(1, (ax * bx + ay * by + az * bz) / length),
  );
  return 180 - (Math.acos(cosine) * 180) / Math.PI;
}

function classifyHand(
  hand: HandObservation,
  scale: number,
  aspect: number,
): { isThumbUp: boolean; pinchRatio: number } | null {
  const world = hand.worldLandmarks;
  if (
    world !== undefined &&
    (world.length !== 21 ||
      world.some(
        (point) =>
          !point ||
          !Number.isFinite(point.x) ||
          !Number.isFinite(point.y) ||
          !Number.isFinite(point.z),
      ))
  )
    return null;
  // World landmarks preserve finger bends when a palm turns side-on. The
  // fallback uses aspect-correct image x/y, never image z in mixed units.
  const geometry =
    world ??
    hand.landmarks.map((point) => ({ x: point.x * aspect, y: point.y, z: 0 }));
  const separation = (a: Landmark, b: Landmark) =>
    Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
  const palmScale = separation(geometry[0], geometry[9]);
  if (!Number.isFinite(palmScale) || palmScale < 1e-6) return null;
  const pinchRatio = separation(geometry[4], geometry[8]) / palmScale;
  if (!Number.isFinite(pinchRatio)) return null;
  const bends = [1, 5, 9, 13, 17].map((start) => {
    const first = jointBend(
      geometry[start],
      geometry[start + 1],
      geometry[start + 2],
    );
    const second = jointBend(
      geometry[start + 1],
      geometry[start + 2],
      geometry[start + 3],
    );
    return first === null || second === null ? null : first + second;
  });
  // Supplied but invalid 3D data cannot silently fall back to a different
  // classifier; an absent model output may use the screen-only fallback.
  if (bends.some((bend) => bend === null))
    return world === undefined ? { isThumbUp: false, pinchRatio } : null;
  const thumb = bends[0]!;
  const fingersCurled = bends.slice(1).every((bend) => bend! > 95);
  const up = hand.landmarks[1].y - hand.landmarks[4].y;
  const sideways = (hand.landmarks[1].x - hand.landmarks[4].x) * aspect;
  // Reject a real pinch using the same 3D geometry as the bend classifier.
  // Image-tip overlap alone must not reject a side-on thumb-up pose.
  return {
    pinchRatio,
    isThumbUp:
      thumb < 42 &&
      fingersCurled &&
      pinchRatio >= EXIT_PINCH &&
      up / scale > 0.45 &&
      up / Math.hypot(sideways, up) > 0.65,
  };
}

function readObservation(
  hand: HandObservation,
  aspect: number,
): Observation | null {
  if (
    hand.landmarks.length !== 21 ||
    hand.landmarks.some(
      (point) =>
        !point ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        (point.z !== undefined && !Number.isFinite(point.z)) ||
        point.x < -0.25 ||
        point.x > 1.25 ||
        point.y < -0.25 ||
        point.y > 1.25,
    )
  )
    return null;
  const scale = distance(hand.landmarks[0], hand.landmarks[9], aspect);
  if (scale < 0.015 || scale > 1) return null;
  const point = PALM_INDICES.reduce(
    (sum, index) => ({
      x: sum.x + hand.landmarks[index].x / PALM_INDICES.length,
      y: sum.y + hand.landmarks[index].y / PALM_INDICES.length,
    }),
    { x: 0, y: 0 },
  );
  // Pinch, neutral release and thumb-up share one geometry source. In 3D a
  // side-on projection cannot turn separated fingertips into a false grab.
  const classification = classifyHand(hand, scale, aspect);
  if (classification === null) return null;
  return {
    // Input stays unmirrored; interaction space matches the mirrored preview.
    point: { x: 1 - point.x, y: 1 - point.y },
    ...classification,
  };
}

/** One-hand camera controls; neither game state nor camera state is owned here. */
export class GestureInterpreter {
  private track: Track | null = null;
  private previousTimestamp: number | null = null;
  private previousAspect: number | null = null;
  private requireRelease = false;
  private controlMode: GestureControlMode = "pan";
  private smoothPoint: Point | null = null;
  private anchorPoint: Point | null = null;
  private neutralSince: number | null = null;
  private switchSince: number | null = null;
  private switchOrigin: Point | null = null;
  private switchLatched = false;
  private switchProgress = 0;

  getMode(): GestureControlMode {
    return this.controlMode;
  }

  setMode(mode: GestureControlMode): void {
    if (mode === this.controlMode) return;
    this.controlMode = mode;
    this.reset(true);
  }

  reset(requireRelease = false): void {
    this.track = null;
    this.previousTimestamp = null;
    this.previousAspect = null;
    this.requireRelease = requireRelease;
    this.neutralSince = null;
    this.clearMotion();
    this.clearSwitchHold();
    // A completed thumb-up stays latched across dropout or UI mode changes. Only
    // 120 ms of visible neutral/unpinched pose permits another switch.
  }

  update(
    hands: HandObservation[],
    timestampMs: number,
    aspect: number,
  ): GestureResult {
    const handCount = hands.length;
    if (
      !Number.isFinite(timestampMs) ||
      timestampMs < 0 ||
      !Number.isFinite(aspect) ||
      aspect < 0.2 ||
      aspect > 5 ||
      hands.length !== 1
    )
      return this.release(handCount);
    const dt =
      this.previousTimestamp === null
        ? 0
        : timestampMs - this.previousTimestamp;
    const changedAspect =
      this.previousAspect !== null &&
      Math.abs(aspect - this.previousAspect) > 0.001;
    this.previousTimestamp = timestampMs;
    this.previousAspect = aspect;
    if (dt < 0 || dt > MAX_GAP_MS || changedAspect) this.release(handCount);
    else if (dt === 0 && this.track)
      return this.result(
        "stop",
        this.requireRelease
          ? "release"
          : this.switchSince !== null
            ? "switching"
            : "idle",
        handCount,
      );
    const observation = readObservation(hands[0], aspect);
    if (!observation) return this.release(handCount);
    const maxStep = Math.min(0.4, 0.12 + Math.max(dt, 0) * 0.002);
    if (
      this.track &&
      distance(observation.point, this.track.point, aspect) > maxStep
    )
      return this.release(handCount);

    if (!observation.isThumbUp && observation.pinchRatio >= EXIT_PINCH) {
      this.neutralSince ??= timestampMs;
      if (timestampMs - this.neutralSince >= RELEASE_MS) {
        this.switchLatched = false;
        this.requireRelease = false;
      }
    } else this.neutralSince = null;

    // An intentional held thumb-up may start directly after enable/reset. It
    // remains exclusive of pinching even when a side-on projection collapses
    // the thumb/index image distance. A completed switch still needs release.
    if (
      this.requireRelease &&
      !(observation.isThumbUp && !this.switchLatched)
    ) {
      this.track = { ...observation, pinched: false, pinchSince: timestampMs };
      this.clearMotion();
      this.clearSwitchHold();
      if (observation.isThumbUp && this.switchLatched) this.switchProgress = 1;
      return this.result("stop", "release", handCount);
    }

    if (observation.isThumbUp) {
      this.track = { ...observation, pinched: false, pinchSince: timestampMs };
      this.clearMotion();
      if (this.switchLatched) {
        this.requireRelease = true;
        this.switchProgress = 1;
        return this.result("stop", "release", handCount);
      }
      if (
        this.switchSince === null ||
        !this.switchOrigin ||
        distance(observation.point, this.switchOrigin, aspect) >
          SWITCH_POSITION_TOLERANCE
      ) {
        this.switchSince = timestampMs;
        this.switchOrigin = { ...observation.point };
      }
      this.switchProgress = Math.min(
        1,
        (timestampMs - this.switchSince) / SWITCH_HOLD_MS,
      );
      if (this.switchProgress >= 1) {
        this.setMode(
          MODES[(MODES.indexOf(this.controlMode) + 1) % MODES.length],
        );
        this.switchLatched = true;
        this.switchProgress = 1;
        return this.result("stop", "release", handCount);
      }
      return this.result("stop", "switching", handCount);
    }
    this.clearSwitchHold();
    const pinched = this.track?.pinched
      ? observation.pinchRatio < EXIT_PINCH
      : observation.pinchRatio < ENTER_PINCH;
    const pinchSince =
      pinched && this.track?.pinched ? this.track.pinchSince : timestampMs;
    this.track = { ...observation, pinched, pinchSince };
    if (!pinched) {
      this.clearMotion();
      return this.result("stop", "idle", handCount);
    }
    if (timestampMs - pinchSince < ARM_MS) {
      this.clearMotion();
      return this.result("stop", "arming", handCount);
    }
    const mode = this.controlMode;
    const point = observation.point;
    if (!this.smoothPoint || !this.anchorPoint) {
      this.smoothPoint = { ...point };
      this.anchorPoint = { ...point };
      return this.result(mode, mode, handCount);
    }
    const alpha = 1 - Math.exp(-dt / SMOOTH_MS);
    this.smoothPoint = {
      x: this.smoothPoint.x + alpha * (point.x - this.smoothPoint.x),
      y: this.smoothPoint.y + alpha * (point.y - this.smoothPoint.y),
    };
    const dx = this.smoothPoint.x - this.anchorPoint.x;
    const dy = this.smoothPoint.y - this.anchorPoint.y;
    if (mode === "zoom") {
      const zoomLog = dy * ZOOM_GAIN;
      if (Math.abs(zoomLog) > 0.45) return this.release(handCount);
      if (Math.abs(zoomLog) < ZOOM_DEADZONE)
        return this.result(mode, mode, handCount);
      this.anchorPoint = { ...this.smoothPoint };
      return this.result(mode, mode, handCount, 0, 0, zoomLog);
    }
    if (distance(this.smoothPoint, this.anchorPoint, aspect) < PAN_DEADZONE)
      return this.result(mode, mode, handCount);
    this.anchorPoint = { ...this.smoothPoint };
    return this.result(mode, mode, handCount, dx, dy);
  }

  private clearMotion(): void {
    this.smoothPoint = null;
    this.anchorPoint = null;
  }
  private clearSwitchHold(): void {
    this.switchSince = null;
    this.switchOrigin = null;
    this.switchProgress = 0;
  }
  private release(handCount: number): GestureResult {
    this.requireRelease = true;
    this.track = null;
    this.neutralSince = null;
    this.clearMotion();
    this.clearSwitchHold();
    return this.result("stop", "release", handCount);
  }
  private result(
    mode: GestureCameraDelta["mode"],
    status: GestureResult["status"],
    handCount: number,
    dx = 0,
    dy = 0,
    zoomLog = 0,
  ): GestureResult {
    return {
      input: { mode, dx, dy, zoomLog },
      status,
      handCount,
      controlMode: this.controlMode,
      modeSwitchProgress: this.switchProgress,
    };
  }
}
