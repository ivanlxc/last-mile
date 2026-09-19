export type Landmark = { x: number; y: number; z?: number };
export type HandObservation = { landmarks: Landmark[]; handedness?: string };
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
type Observation = { point: Point; pinchRatio: number; isV: boolean };
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

function jointCosine(a: Point, joint: Point, b: Point, aspect: number) {
  const ax = (a.x - joint.x) * aspect;
  const ay = a.y - joint.y;
  const bx = (b.x - joint.x) * aspect;
  const by = b.y - joint.y;
  const length = Math.hypot(ax, ay) * Math.hypot(bx, by);
  return length > 0.000001 ? (ax * bx + ay * by) / length : null;
}

function isVSign(landmarks: Landmark[], scale: number, aspect: number) {
  const extended = (mcp: number) => {
    const pipAngle = jointCosine(
      landmarks[mcp],
      landmarks[mcp + 1],
      landmarks[mcp + 2],
      aspect,
    );
    const dipAngle = jointCosine(
      landmarks[mcp + 1],
      landmarks[mcp + 2],
      landmarks[mcp + 3],
      aspect,
    );
    return (
      pipAngle !== null &&
      pipAngle < -0.7 &&
      dipAngle !== null &&
      dipAngle < -0.7 &&
      distance(landmarks[mcp], landmarks[mcp + 3], aspect) > scale * 0.7 &&
      distance(landmarks[0], landmarks[mcp + 3], aspect) >
        distance(landmarks[0], landmarks[mcp + 1], aspect) * 1.1
    );
  };
  const curled = (mcp: number) => {
    const angle = jointCosine(
      landmarks[mcp],
      landmarks[mcp + 1],
      landmarks[mcp + 2],
      aspect,
    );
    return (
      angle !== null &&
      angle > -0.35 &&
      distance(landmarks[mcp], landmarks[mcp + 3], aspect) <
        distance(landmarks[mcp], landmarks[mcp + 1], aspect) * 1.25
    );
  };
  // Bent ring/little fingers distinguish an intentional V from a released
  // pinch or an open palm; joint angles stay valid as the hand rotates.
  return (
    extended(5) &&
    extended(9) &&
    curled(13) &&
    curled(17) &&
    distance(landmarks[8], landmarks[12], aspect) > scale * 0.45
  );
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
  // Correct normalized image x for the camera aspect, including joint angles.
  const pinchRatio =
    distance(hand.landmarks[4], hand.landmarks[8], aspect) / scale;
  return {
    // Input stays unmirrored; interaction space matches the mirrored preview.
    point: { x: 1 - point.x, y: 1 - point.y },
    pinchRatio,
    isV: pinchRatio >= EXIT_PINCH && isVSign(hand.landmarks, scale, aspect),
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
    // A completed V stays latched across dropout or UI mode changes. Only
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

    if (!observation.isV && observation.pinchRatio >= EXIT_PINCH) {
      this.neutralSince ??= timestampMs;
      if (timestampMs - this.neutralSince >= RELEASE_MS) {
        this.switchLatched = false;
        this.requireRelease = false;
      }
    } else this.neutralSince = null;

    if (this.requireRelease) {
      this.track = { ...observation, pinched: false, pinchSince: timestampMs };
      this.clearMotion();
      this.clearSwitchHold();
      if (observation.isV && this.switchLatched) this.switchProgress = 1;
      return this.result("stop", "release", handCount);
    }

    if (observation.isV) {
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
