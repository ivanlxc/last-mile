export type Landmark = { x: number; y: number; z?: number };
export type HandObservation = {
  landmarks: Landmark[];
  handedness?: string;
};
export type GestureCameraDelta = {
  mode: "pan" | "zoom" | "stop";
  dx: number;
  dy: number;
  zoomLog: number;
};
export type GestureResult = {
  input: GestureCameraDelta;
  status: "idle" | "arming" | "pan" | "zoom" | "release";
  handCount: number;
};

type Point = { x: number; y: number };
type Observation = { point: Point; pinchRatio: number };
type Track = Observation & {
  id: number;
  pinched: boolean;
  pinchSince: number;
};

const ENTER_PINCH = 0.38;
const EXIT_PINCH = 0.58;
const ARM_MS = 100;
const MAX_GAP_MS = 250;
const SMOOTH_MS = 45;
const MIN_HAND_SEPARATION = 0.1;
const PAN_DEADZONE = 0.0018;
const ZOOM_DEADZONE = 0.004;
const PALM_INDICES = [0, 5, 9, 13, 17];

const distance = (a: Point, b: Point, aspect: number) =>
  Math.hypot((a.x - b.x) * aspect, a.y - b.y);

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
  ) {
    return null;
  }
  // Image x/y have different scales on a non-square camera feed. Per-hand
  // world landmarks cannot provide a shared distance between two hands.
  const scale = distance(hand.landmarks[0], hand.landmarks[9], aspect);
  if (scale < 0.015 || scale > 1) return null;
  const point = PALM_INDICES.reduce(
    (sum, index) => ({
      x: sum.x + hand.landmarks[index].x / PALM_INDICES.length,
      y: sum.y + hand.landmarks[index].y / PALM_INDICES.length,
    }),
    { x: 0, y: 0 },
  );
  return {
    // The source image stays unmirrored. Only the user's interaction space
    // is mirrored, matching the CSS-mirrored camera preview.
    point: { x: 1 - point.x, y: 1 - point.y },
    pinchRatio: distance(hand.landmarks[4], hand.landmarks[8], aspect) / scale,
  };
}

/** Converts hand landmarks to camera-only deltas, without owning camera state. */
export class GestureInterpreter {
  private tracks: Track[] = [];
  private nextId = 1;
  private previousTimestamp: number | null = null;
  private previousAspect: number | null = null;
  private requireRelease = false;
  private mode: "pan" | "zoom" | null = null;
  private activeIds: number[] = [];
  private smoothPoint: Point | null = null;
  private anchorPoint: Point | null = null;
  private smoothZoom = 0;
  private anchorZoom = 0;

  reset(requireRelease = false): void {
    this.tracks = [];
    this.previousTimestamp = null;
    this.previousAspect = null;
    this.requireRelease = requireRelease;
    this.clearMotion();
  }

  update(
    hands: HandObservation[],
    timestampMs: number,
    aspect: number,
  ): GestureResult {
    const handCount = Math.min(hands.length, 2);
    if (
      !Number.isFinite(timestampMs) ||
      timestampMs < 0 ||
      !Number.isFinite(aspect) ||
      aspect < 0.2 ||
      aspect > 5 ||
      hands.length > 2
    ) {
      return this.release(handCount);
    }
    const dt =
      this.previousTimestamp === null
        ? 0
        : timestampMs - this.previousTimestamp;
    const changedAspect =
      this.previousAspect !== null &&
      Math.abs(aspect - this.previousAspect) > 0.001;
    this.previousTimestamp = timestampMs;
    this.previousAspect = aspect;
    if (dt < 0 || dt > MAX_GAP_MS || changedAspect) {
      this.release(handCount);
    } else if (dt === 0 && this.tracks.length > 0) {
      // A duplicate frame cannot arm a gesture or replay a movement.
      return this.result(
        "stop",
        this.requireRelease ? "release" : "idle",
        handCount,
      );
    }

    if (hands.length === 0) return this.release(0);
    const parsed = hands.map((hand) => readObservation(hand, aspect));
    if (parsed.some((hand) => hand === null)) return this.release(handCount);
    const observations = parsed as Observation[];

    if (this.requireRelease) {
      // Never resume an interrupted grab when a still-pinched hand returns.
      // Every visible hand must open before the next grab may be armed.
      if (observations.some((hand) => hand.pinchRatio < EXIT_PINCH)) {
        return this.result("stop", "release", handCount);
      }
      this.requireRelease = false;
      this.tracks = observations.map((hand) =>
        this.newTrack(hand, timestampMs),
      );
      return this.result("stop", "idle", handCount);
    }

    const matched = this.match(observations, aspect, dt);
    if (matched === null) return this.release(handCount);
    const nextTracks = observations.map((hand, index) => {
      const previous = matched[index];
      if (!previous) return this.newTrack(hand, timestampMs);
      const pinched = previous.pinched
        ? hand.pinchRatio < EXIT_PINCH
        : hand.pinchRatio < ENTER_PINCH;
      return {
        ...hand,
        id: previous.id,
        pinched,
        pinchSince:
          pinched && previous.pinched ? previous.pinchSince : timestampMs,
      };
    });

    // Losing even an arming pinch cancels the grab; a different hand must
    // not silently inherit its identity or elapsed arming time.
    if (
      this.tracks.some(
        (old) => old.pinched && !nextTracks.some((next) => next.id === old.id),
      )
    ) {
      return this.release(handCount);
    }
    this.tracks = nextTracks;
    const pinches = nextTracks.filter((track) => track.pinched);
    if (this.mode === "zoom" && pinches.length === 1) {
      return this.release(handCount);
    }
    if (pinches.length === 0) {
      this.clearMotion();
      return this.result("stop", "idle", handCount);
    }
    if (pinches.some((hand) => timestampMs - hand.pinchSince < ARM_MS)) {
      // A second pinch pauses pan while zoom arms, avoiding a diagonal
      // camera twitch during the one-hand to two-hand transition.
      this.clearMotion();
      return this.result("stop", "arming", handCount);
    }

    const mode = pinches.length === 2 ? "zoom" : "pan";
    const ids = pinches.map((hand) => hand.id).sort((a, b) => a - b);
    const fresh =
      mode !== this.mode ||
      ids.length !== this.activeIds.length ||
      ids.some((id, index) => this.activeIds[index] !== id);
    this.mode = mode;
    this.activeIds = ids;
    const alpha = 1 - Math.exp(-dt / SMOOTH_MS);

    if (mode === "pan") {
      const point = pinches[0].point;
      if (fresh || !this.smoothPoint || !this.anchorPoint) {
        this.smoothPoint = { ...point };
        this.anchorPoint = { ...point };
        return this.result("pan", "pan", handCount);
      }
      this.smoothPoint = {
        x: this.smoothPoint.x + alpha * (point.x - this.smoothPoint.x),
        y: this.smoothPoint.y + alpha * (point.y - this.smoothPoint.y),
      };
      if (distance(this.smoothPoint, this.anchorPoint, aspect) < PAN_DEADZONE) {
        return this.result("pan", "pan", handCount);
      }
      const dx = this.smoothPoint.x - this.anchorPoint.x;
      const dy = this.smoothPoint.y - this.anchorPoint.y;
      this.anchorPoint = { ...this.smoothPoint };
      return this.result("pan", "pan", handCount, dx, dy);
    }

    const separation = distance(pinches[0].point, pinches[1].point, aspect);
    if (separation < MIN_HAND_SEPARATION) return this.release(handCount);
    const zoom = Math.log(separation);
    if (fresh) {
      this.smoothZoom = zoom;
      this.anchorZoom = zoom;
      return this.result("zoom", "zoom", handCount);
    }
    if (Math.abs(zoom - this.smoothZoom) > 0.45) {
      return this.release(handCount);
    }
    this.smoothZoom += alpha * (zoom - this.smoothZoom);
    const zoomLog = this.smoothZoom - this.anchorZoom;
    if (Math.abs(zoomLog) < ZOOM_DEADZONE) {
      return this.result("zoom", "zoom", handCount);
    }
    this.anchorZoom = this.smoothZoom;
    return this.result("zoom", "zoom", handCount, 0, 0, zoomLog);
  }

  private match(
    observations: Observation[],
    aspect: number,
    dt: number,
  ): (Track | undefined)[] | null {
    if (!this.tracks.length) return observations.map(() => undefined);
    const maxStep = Math.min(0.4, 0.12 + Math.max(dt, 0) * 0.002);
    if (
      observations.length === 2 &&
      distance(observations[0].point, observations[1].point, aspect) <
        MIN_HAND_SEPARATION
    ) {
      // Landmark array order and handedness labels may flip at a crossing.
      // Stop while the geometric assignment is ambiguous.
      return null;
    }
    const cost = (hand: Observation, track: Track) =>
      distance(hand.point, track.point, aspect);
    if (observations.length === 2 && this.tracks.length === 2) {
      const straight =
        cost(observations[0], this.tracks[0]) +
        cost(observations[1], this.tracks[1]);
      const swapped =
        cost(observations[0], this.tracks[1]) +
        cost(observations[1], this.tracks[0]);
      if (Math.abs(straight - swapped) < 0.04) return null;
      const assigned =
        straight < swapped ? this.tracks : [this.tracks[1], this.tracks[0]];
      return assigned.some((track, i) => cost(observations[i], track) > maxStep)
        ? null
        : assigned;
    }
    if (this.tracks.length === 1 && observations.length === 1) {
      return cost(observations[0], this.tracks[0]) > maxStep
        ? null
        : [this.tracks[0]];
    }
    const candidates =
      observations.length === 2
        ? observations.map((hand) => cost(hand, this.tracks[0]))
        : this.tracks.map((track) => cost(observations[0], track));
    if (Math.abs(candidates[0] - candidates[1]) < 0.04) return null;
    const best = candidates[0] < candidates[1] ? 0 : 1;
    if (candidates[best] > maxStep) return null;
    if (observations.length === 1) return [this.tracks[best]];
    return observations.map((_, index) =>
      index === best ? this.tracks[0] : undefined,
    );
  }

  private newTrack(hand: Observation, timestamp: number): Track {
    return {
      ...hand,
      id: this.nextId++,
      pinched: hand.pinchRatio < ENTER_PINCH,
      pinchSince: timestamp,
    };
  }

  private clearMotion(): void {
    this.mode = null;
    this.activeIds = [];
    this.smoothPoint = null;
    this.anchorPoint = null;
    this.smoothZoom = 0;
    this.anchorZoom = 0;
  }

  private release(handCount: number): GestureResult {
    this.requireRelease = true;
    this.tracks = [];
    this.clearMotion();
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
    return { input: { mode, dx, dy, zoomLog }, status, handCount };
  }
}
