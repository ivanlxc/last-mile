import { describe, expect, it } from "vitest";
import palmThumbUp from "./fixtures/gestures/tasks-palm-thumb-up.json";
import {
  GestureInterpreter,
  type GestureControlMode,
  type GestureResult,
  type HandObservation,
} from "../client/src/lib/gestures/gestureInterpreter";

function hand(x = 0.4, y = 0.5, pinchRatio = 0.2, aspect = 1): HandObservation {
  const landmarks = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  landmarks[0] = { x, y: y + 0.08, z: 0 };
  landmarks[9] = { x, y: y - 0.02, z: 0 };
  landmarks[5] = { x: x - 0.04 / aspect, y: y - 0.02, z: 0 };
  landmarks[13] = { x: x + 0.02 / aspect, y: y - 0.02, z: 0 };
  landmarks[17] = { x: x + 0.02 / aspect, y: y - 0.02, z: 0 };
  landmarks[4] = { x, y: y - 0.12, z: 0 };
  landmarks[8] = { x: x + (pinchRatio * 0.1) / aspect, y: y - 0.12, z: 0 };
  return { landmarks, handedness: "Left" };
}

// A straight upward thumb with four bent fingers. The palm center matches
// hand(), making transitions usable by browser tests without a tracking jump.
function thumbUpHand(x = 0.4, y = 0.5, aspect = 1): HandObservation {
  const result = hand(x, y, 1, aspect);
  // Raw Tasks Right + positive ordered palm normal is the dorsal-facing pose.
  result.handedness = "Right";
  const offsets: Record<number, [number, number]> = {
    1: [-0.06, 0.025],
    2: [-0.06, -0.02],
    3: [-0.06, -0.075],
    4: [-0.06, -0.13],
    6: [-0.075, -0.045],
    7: [-0.045, -0.055],
    8: [-0.025, -0.025],
    10: [-0.02, -0.065],
    11: [0.015, -0.055],
    12: [0.025, -0.02],
    14: [0.035, -0.065],
    15: [0.04, -0.025],
    16: [0.025, 0.005],
    18: [0.065, -0.04],
    19: [0.055, -0.015],
    20: [0.035, 0.005],
  };
  for (const [index, [dx, dy]] of Object.entries(offsets)) {
    result.landmarks[Number(index)] = { x: x + dx / aspect, y: y + dy, z: 0 };
  }
  return result;
}

function withWorld(observation = thumbUpHand(), aspect = 1): HandObservation {
  return {
    ...observation,
    worldLandmarks: observation.landmarks.map((point) => ({
      x: (point.x - 0.4) * aspect * 0.5,
      y: (point.y - 0.5) * 0.5,
      z: 0,
    })),
  };
}

function arm(
  interpreter: GestureInterpreter,
  mode: GestureControlMode = "pan",
  aspect = 1,
) {
  interpreter.setMode(mode);
  interpreter.update([hand(0.4, 0.5, 0.8, aspect)], 0, aspect);
  expect(
    interpreter.update([hand(0.4, 0.5, 0.8, aspect)], 120, aspect).status,
  ).toBe("idle");
  expect(
    interpreter.update([hand(0.4, 0.5, 0.2, aspect)], 150, aspect).status,
  ).toBe("arming");
  return interpreter.update([hand(0.4, 0.5, 0.2, aspect)], 250, aspect);
}

function holdThumbUp(
  interpreter: GestureInterpreter,
  start: number,
  end: number,
  observation = thumbUpHand(),
  aspect = 1,
) {
  for (let timestamp = start; timestamp < end; timestamp += 100)
    interpreter.update([observation], timestamp, aspect);
  return interpreter.update([observation], end, aspect);
}
function expectStopped(result: GestureResult) {
  expect(result.input).toEqual({ mode: "stop", dx: 0, dy: 0, zoomLog: 0 });
}

describe("single-hand camera gesture interpreter", () => {
  it.each(["pan", "orbit", "zoom"] as const)(
    "controls %s using just one pinched hand",
    (mode) => {
      const interpreter = new GestureInterpreter();
      const start = arm(interpreter, mode);
      expect(start.input).toEqual({ mode, dx: 0, dy: 0, zoomLog: 0 });
      expect(start.controlMode).toBe(mode);
      const moved = interpreter.update([hand(0.36, 0.46)], 300, 1);
      expect(moved.status).toBe(mode);
      expect(moved.handCount).toBe(1);
      if (mode === "zoom") {
        expect(moved.input.zoomLog).toBeGreaterThan(0);
        expect(moved.input.dx).toBe(0);
        expect(moved.input.dy).toBe(0);
      } else {
        expect(moved.input.dx).toBeGreaterThan(0);
        expect(moved.input.dy).toBeGreaterThan(0);
        expect(moved.input.zoomLog).toBe(0);
      }
    },
  );

  it.each([10, 20, 25, 50, 100])(
    "arms after elapsed 100 ms, at %i ms frame intervals",
    (interval) => {
      const interpreter = new GestureInterpreter();
      for (let timestamp = 0; timestamp < 100; timestamp += interval)
        expect(interpreter.update([hand()], timestamp, 1).status).toBe(
          "arming",
        );
      const start = interpreter.update([hand(0.38)], 100, 1);
      expect(start.input).toEqual({ mode: "pan", dx: 0, dy: 0, zoomLog: 0 });
    },
  );

  it("mirrors horizontal movement and uses upward-positive orbit input", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter, "orbit");
    const moved = interpreter.update([hand(0.44, 0.54)], 300, 1);
    expect(moved.input.dx).toBeLessThan(0);
    expect(moved.input.dy).toBeLessThan(0);
  });

  it("ignores horizontal movement in zoom mode and zooms out on downward movement", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter, "zoom");
    expect(interpreter.update([hand(0.35)], 300, 1).input).toEqual({
      mode: "zoom",
      dx: 0,
      dy: 0,
      zoomLog: 0,
    });
    const down = interpreter.update([hand(0.35, 0.54)], 350, 1);
    expect(down.input.zoomLog).toBeLessThan(0);
    expect(down.input.dx).toBe(0);
    expect(down.input.dy).toBe(0);
  });

  it("uses pinch hysteresis and stops immediately when fingers separate", () => {
    const interpreter = new GestureInterpreter();
    expect(interpreter.update([hand(0.4, 0.5, 0.5)], 0, 1).status).toBe("idle");
    expect(interpreter.update([hand(0.4, 0.5, 0.37)], 20, 1).status).toBe(
      "arming",
    );
    expect(interpreter.update([hand(0.4, 0.5, 0.37)], 120, 1).status).toBe(
      "pan",
    );
    expect(
      interpreter.update([hand(0.36, 0.5, 0.5)], 150, 1).input.dx,
    ).toBeGreaterThan(0);
    expectStopped(interpreter.update([hand(0.32, 0.5, 0.59)], 180, 1));
    expectStopped(interpreter.update([hand(0.3, 0.5, 0.8)], 210, 1));
  });

  it.each(["pan", "orbit", "zoom"] as const)(
    "suppresses stationary jitter in %s mode",
    (mode) => {
      const interpreter = new GestureInterpreter();
      arm(interpreter, mode);
      for (let i = 1; i <= 20; i++) {
        const result = interpreter.update(
          [
            hand(
              0.4 + (i % 2 ? 0.0005 : -0.0005),
              0.5 + (i % 2 ? 0.0003 : -0.0003),
            ),
          ],
          250 + i * 33,
          1,
        );
        expect(result.input.dx).toBe(0);
        expect(result.input.dy).toBe(0);
        expect(result.input.zoomLog).toBe(0);
      }
    },
  );

  it("never turns two hands into a camera command in any selected mode", () => {
    for (const mode of ["pan", "orbit", "zoom"] as const) {
      const interpreter = new GestureInterpreter();
      arm(interpreter, mode);
      const second = interpreter.update([hand(0.35), hand(0.7)], 300, 1);
      expect(second.status).toBe("release");
      expect(second.handCount).toBe(2);
      expectStopped(second);
      expectStopped(interpreter.update([hand(0.3), hand(0.75)], 400, 1));
      expect(interpreter.update([hand(0.3)], 450, 1).status).toBe("release");
    }
  });

  it("keeps the selected mode across resets and requires neutral release after changing mode", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter);
    interpreter.setMode("orbit");
    expect(interpreter.getMode()).toBe("orbit");
    expect(interpreter.update([hand(0.35)], 300, 1).status).toBe("release");
    expect(interpreter.update([hand(0.35, 0.5, 0.8)], 350, 1).status).toBe(
      "release",
    );
    expect(interpreter.update([hand(0.35, 0.5, 0.8)], 469, 1).status).toBe(
      "release",
    );
    expect(interpreter.update([hand(0.35, 0.5, 0.8)], 470, 1).status).toBe(
      "idle",
    );
    expect(interpreter.update([hand(0.35)], 500, 1).status).toBe("arming");
    expect(interpreter.update([hand(0.33)], 600, 1).input).toEqual({
      mode: "orbit",
      dx: 0,
      dy: 0,
      zoomLog: 0,
    });
    interpreter.reset(true);
    expect(interpreter.getMode()).toBe("orbit");
  });

  it("does not reset an active grab when setting the already-selected mode", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter);
    interpreter.setMode("pan");
    expect(interpreter.update([hand(0.36)], 300, 1).input.dx).toBeGreaterThan(
      0,
    );
  });

  it("requires a neutral open pose after dropout and reanchors the next grab", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter);
    expect(interpreter.update([], 280, 1).status).toBe("release");
    expect(interpreter.update([hand(0.7)], 300, 1).status).toBe("release");
    expect(interpreter.update([hand(0.7, 0.5, 0.8)], 350, 1).status).toBe(
      "release",
    );
    expect(interpreter.update([hand(0.7, 0.5, 0.8)], 470, 1).status).toBe(
      "idle",
    );
    expect(interpreter.update([hand(0.7)], 500, 1).status).toBe("arming");
    expect(interpreter.update([hand(0.68)], 600, 1).input).toEqual({
      mode: "pan",
      dx: 0,
      dy: 0,
      zoomLog: 0,
    });
  });

  it("cancels an arming pinch on dropout and rejects long frame gaps", () => {
    const interpreter = new GestureInterpreter();
    interpreter.update([hand()], 0, 1);
    interpreter.update([], 50, 1);
    expect(interpreter.update([hand()], 100, 1).status).toBe("release");
    for (const timestamp of [501, 200]) {
      const other = new GestureInterpreter();
      arm(other);
      expect(other.update([hand(0.35)], timestamp, 1).status).toBe("release");
    }
  });

  it("ignores duplicate timestamps without replaying movement", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter);
    expect(interpreter.update([hand(0.36)], 300, 1).input.dx).toBeGreaterThan(
      0,
    );
    expectStopped(interpreter.update([hand(0.3)], 300, 1));
  });

  it("shows timed thumb-up progress and switches exactly once while thumb-up is held for two seconds", () => {
    const interpreter = new GestureInterpreter();
    expect(interpreter.update([thumbUpHand()], 0, 1).status).toBe("switching");
    const middle = holdThumbUp(interpreter, 100, 350);
    expect(middle.modeSwitchProgress).toBeCloseTo(0.5);
    expect(middle.controlMode).toBe("pan");
    const switched = holdThumbUp(interpreter, 450, 700);
    expect(switched.status).toBe("release");
    expect(switched.controlMode).toBe("orbit");
    expect(switched.modeSwitchProgress).toBe(1);
    expectStopped(switched);
    const held = holdThumbUp(interpreter, 800, 2000);
    expect(held.controlMode).toBe("orbit");
    expectStopped(held);
  });

  it("cycles pan → orbit → zoom → pan with neutral release between thumb-up holds", () => {
    const interpreter = new GestureInterpreter();
    expect(holdThumbUp(interpreter, 0, 700).controlMode).toBe("orbit");
    for (const [base, mode] of [
      [800, "zoom"],
      [1800, "pan"],
    ] as const) {
      expect(interpreter.update([hand(0.4, 0.5, 0.8)], base, 1).status).toBe(
        "release",
      );
      expect(
        interpreter.update([hand(0.4, 0.5, 0.8)], base + 120, 1).status,
      ).toBe("idle");
      expect(holdThumbUp(interpreter, base + 150, base + 850).controlMode).toBe(
        mode,
      );
    }
  });

  it("keeps thumb-up latched through a brief neutral misclassification and a dropped frame", () => {
    const interpreter = new GestureInterpreter();
    holdThumbUp(interpreter, 0, 700);
    interpreter.update([hand(0.4, 0.5, 0.8)], 750, 1);
    expect(holdThumbUp(interpreter, 783, 1500).controlMode).toBe("orbit");
    interpreter.update([], 1533, 1);
    expect(holdThumbUp(interpreter, 1566, 2300).controlMode).toBe("orbit");
  });

  it("can begin an intentional thumb-up switch directly after enable or explicit mode selection", () => {
    for (const selected of ["pan", "zoom"] as const) {
      const interpreter = new GestureInterpreter();
      interpreter.setMode(selected);
      interpreter.reset(true);
      expect(interpreter.update([thumbUpHand()], 0, 1).status).toBe(
        "switching",
      );
      const held = holdThumbUp(interpreter, 100, 700);
      expect(held.controlMode).toBe(selected === "pan" ? "orbit" : "pan");
      expect(held.status).toBe("release");
      expect(interpreter.update([hand()], 800, 1).status).toBe("release");
    }
  });

  it("cancels an incomplete thumb-up and starts a fresh hold next time", () => {
    const interpreter = new GestureInterpreter();
    expect(holdThumbUp(interpreter, 0, 400).status).toBe("switching");
    const cancelled = interpreter.update([hand(0.4, 0.5, 0.8)], 450, 1);
    expect(cancelled.modeSwitchProgress).toBe(0);
    expect(cancelled.controlMode).toBe("pan");
    expect(holdThumbUp(interpreter, 500, 1100).controlMode).toBe("pan");
    expect(interpreter.update([thumbUpHand()], 1200, 1).controlMode).toBe(
      "orbit",
    );
  });

  it("cancels the thumb-up timer on a long gap or second hand, requiring a fresh full hold", () => {
    for (const gap of [true, false]) {
      const interpreter = new GestureInterpreter();
      holdThumbUp(interpreter, 0, 400);
      const interrupted = gap
        ? interpreter.update([thumbUpHand()], 700, 1)
        : interpreter.update([thumbUpHand(), hand(0.7)], 500, 1);
      expect(interrupted.status).toBe(gap ? "switching" : "release");
      expect(interrupted.modeSwitchProgress).toBe(0);
      expect(interpreter.getMode()).toBe("pan");
      const freshStart = gap ? 700 : 750;
      expect(holdThumbUp(interpreter, 750, freshStart + 650).controlMode).toBe(
        "pan",
      );
      expect(
        interpreter.update([thumbUpHand()], freshStart + 700, 1).controlMode,
      ).toBe("orbit");
    }
  });

  it("resets thumb-up progress when the hand moves out of its hold position", () => {
    const interpreter = new GestureInterpreter();
    holdThumbUp(interpreter, 0, 400);
    const moved = interpreter.update([thumbUpHand(0.54)], 500, 1);
    expect(moved.status).toBe("switching");
    expect(moved.modeSwitchProgress).toBe(0);
    expect(
      holdThumbUp(interpreter, 600, 1100, thumbUpHand(0.54)).controlMode,
    ).toBe("pan");
    expect(interpreter.update([thumbUpHand(0.54)], 1200, 1).controlMode).toBe(
      "orbit",
    );
  });

  it("recognizes left/right thumbs-up at different image aspects with or without world geometry", () => {
    for (const aspect of [1, 16 / 9]) {
      for (const mirror of [false, true]) {
        for (const useWorld of [false, true]) {
          let observation = thumbUpHand(0.4, 0.5, aspect);
          if (useWorld) observation = withWorld(observation, aspect);
          if (mirror)
            observation = {
              ...observation,
              handedness: "Left",
              landmarks: observation.landmarks.map((p) => ({
                ...p,
                x: 0.8 - p.x,
              })),
              worldLandmarks: observation.worldLandmarks?.map((p) => ({
                ...p,
                x: -p.x,
              })),
            };
          expect(
            new GestureInterpreter().update([observation], 0, aspect).status,
          ).toBe("switching");
        }
      }
    }
  });

  it("rejects the official palm-facing thumb-up model output and its left-hand reflection", () => {
    // This is actual output from the installed Tasks model on a manually
    // inspected official photograph; reflection simulates the opposite hand.
    for (const mirror of [false, true]) {
      for (const useWorld of [false, true]) {
        const observation: HandObservation = {
          landmarks: palmThumbUp.hand.landmarks.map((p) => ({
            ...p,
            x: mirror ? 1 - p.x : p.x,
          })),
          worldLandmarks: useWorld
            ? palmThumbUp.hand.worldLandmarks.map((p) => ({
                ...p,
                x: mirror ? -p.x : p.x,
              }))
            : undefined,
          handedness: mirror ? "Left" : "Right",
          confidence: palmThumbUp.hand.confidence,
        };
        const result = holdThumbUp(
          new GestureInterpreter(),
          0,
          1500,
          observation,
          palmThumbUp.aspect,
        );
        expect(result.controlMode).toBe("pan");
        expect(result.modeSwitchProgress).toBe(0);
        expect(result.status).toBe("turn-hand");
        expectStopped(result);
      }
    }
  });

  it("accepts a relaxed back-facing closed hand without requiring a tightly squeezed fist", () => {
    const observation = withWorld();
    for (const start of [5, 9, 13, 17]) {
      const p = observation.worldLandmarks![start];
      // A folded MCP with 75° PIP + 10° DIP bend is a natural loose fist.
      observation.worldLandmarks![start + 1] = { ...p, y: p.y + 0.012 };
      observation.worldLandmarks![start + 2] = {
        x: p.x,
        y: p.y + 0.012 + Math.cos((75 * Math.PI) / 180) * 0.012,
        z: Math.sin((75 * Math.PI) / 180) * 0.012,
      };
      const dip = observation.worldLandmarks![start + 2];
      observation.worldLandmarks![start + 3] = {
        x: p.x,
        y: dip.y + Math.cos((85 * Math.PI) / 180) * 0.008,
        z: dip.z! + Math.sin((85 * Math.PI) / 180) * 0.008,
      };
    }
    const result = holdThumbUp(new GestureInterpreter(), 0, 700, observation);
    expect(result.controlMode).toBe("orbit");
    expectStopped(result);
  });

  it("requires a fresh back-facing hold after turning toward the palm and never rearms a latched switch by flipping the thumb", () => {
    const back = withWorld();
    const palm = { ...back, handedness: "Left" };
    const interpreter = new GestureInterpreter();
    expect(holdThumbUp(interpreter, 0, 400, back).controlMode).toBe("pan");
    expect(holdThumbUp(interpreter, 450, 1000, palm).status).toBe("turn-hand");
    expect(holdThumbUp(interpreter, 1100, 1700, back).controlMode).toBe("pan");
    expect(interpreter.update([back], 1800, 1).controlMode).toBe("orbit");
    holdThumbUp(interpreter, 1900, 2300, palm);
    expect(holdThumbUp(interpreter, 2400, 3400, back).controlMode).toBe(
      "orbit",
    );
  });

  it("does not guess a facing direction for missing/uncertain handedness or an edge-on hand", () => {
    const edge = withWorld();
    edge.landmarks = edge.landmarks.map((p) => ({
      ...p,
      x: 0.4 + (p.x - 0.4) * 0.1,
    }));
    edge.worldLandmarks = edge.worldLandmarks!.map((p) => ({
      x: p.x * 0.1,
      y: p.y,
      z: p.x * Math.sqrt(0.99),
    }));
    const variants = [
      { ...withWorld(), handedness: undefined },
      { ...withWorld(), handedness: "unknown" },
      { ...withWorld(), confidence: 0.55 },
      edge,
    ];
    for (const observation of variants) {
      const result = holdThumbUp(
        new GestureInterpreter(),
        0,
        1000,
        observation,
      );
      expect(result.status).toBe("turn-hand");
      expect(result.controlMode).toBe("pan");
      expectStopped(result);
    }
    // Handedness is irrelevant to grabbing/panning: orientation only gates the
    // discrete thumb-up mode switch.
    const interpreter = new GestureInterpreter();
    const pinch = { ...hand(), handedness: undefined };
    expect(interpreter.update([pinch], 0, 1).status).toBe("arming");
    expect(interpreter.update([pinch], 100, 1).status).toBe("pan");
  });

  it("does not accumulate switch time across changes in handedness", () => {
    const right = thumbUpHand();
    const left = {
      ...right,
      handedness: "Left",
      landmarks: right.landmarks.map((p) => ({ ...p, x: 0.8 - p.x })),
    };
    const interpreter = new GestureInterpreter();
    holdThumbUp(interpreter, 0, 400, right);
    expect(holdThumbUp(interpreter, 450, 1000, left).controlMode).toBe("pan");
    expect(holdThumbUp(interpreter, 1100, 1700, right).controlMode).toBe("pan");
    expect(interpreter.update([right], 1800, 1).controlMode).toBe("orbit");
  });

  it("uses 3D bends when an oblique back-facing projection looks straight or overlaps fingertips", () => {
    const observation = withWorld();
    // Rotating world geometry preserves joint angles. The image is an oblique
    // projection: the index tip may overlap the thumb without fingers touching.
    observation.worldLandmarks = observation.worldLandmarks!.map((p) => ({
      x: p.x * 0.5,
      y: p.y,
      z: p.x * Math.sqrt(0.75),
    }));
    observation.landmarks[8] = { ...observation.landmarks[4] };
    for (const index of [6, 7, 10, 11, 14, 15, 18, 19])
      observation.landmarks[index] = { x: 0.42, y: 0.46 };
    const interpreter = new GestureInterpreter();
    const result = holdThumbUp(interpreter, 0, 700, observation);
    expect(result.controlMode).toBe("orbit");
    expectStopped(result);
    expect(result.status).toBe("release");
  });

  it("rejects sideways/downward thumbs, fists, open fingers, pinches and V signs", () => {
    const variants: HandObservation[] = [hand(0.4, 0.5, 0.8), hand()];
    const original = thumbUpHand();
    for (const angle of [Math.PI / 2, Math.PI])
      variants.push({
        ...original,
        landmarks: original.landmarks.map((p) => ({
          x:
            0.4 + (p.x - 0.4) * Math.cos(angle) - (p.y - 0.5) * Math.sin(angle),
          y:
            0.5 + (p.x - 0.4) * Math.sin(angle) + (p.y - 0.5) * Math.cos(angle),
          z: 0,
        })),
      });
    const fist = thumbUpHand();
    fist.landmarks[3] = { x: 0.37, y: 0.48 };
    fist.landmarks[4] = { x: 0.39, y: 0.5 };
    variants.push(fist);
    const vSign = thumbUpHand();
    for (const [start, x] of [
      [5, 0.36],
      [9, 0.4],
    ]) {
      vSign.landmarks[start + 1] = { x, y: 0.42 };
      vSign.landmarks[start + 2] = { x, y: 0.36 };
      vSign.landmarks[start + 3] = { x, y: 0.3 };
    }
    variants.push(vSign);
    const openRing = thumbUpHand();
    openRing.landmarks[14] = { x: 0.43, y: 0.43 };
    openRing.landmarks[15] = { x: 0.44, y: 0.38 };
    openRing.landmarks[16] = { x: 0.45, y: 0.33 };
    variants.push(openRing);
    for (const observation of variants) {
      const result = holdThumbUp(
        new GestureInterpreter(),
        0,
        1000,
        observation,
      );
      expect(result.controlMode).toBe("pan");
      expect(result.modeSwitchProgress).toBe(0);
    }
  });

  it("fails closed for supplied invalid world data instead of accepting screen-only thumbs-up", () => {
    const good = withWorld();
    const malformed = [
      [],
      good.worldLandmarks!.slice(0, 20),
      good.worldLandmarks!.map((point, i) =>
        i === 4 ? { ...point, z: NaN } : point,
      ),
      good.worldLandmarks!.map((point, i) =>
        i === 4 ? { ...point, x: Infinity } : point,
      ),
      good.worldLandmarks!.map((point) => ({ x: point.x, y: point.y })),
      Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })),
    ];
    for (const worldLandmarks of malformed) {
      const observation = { ...good, worldLandmarks };
      const result = holdThumbUp(
        new GestureInterpreter(),
        0,
        1000,
        observation,
      );
      expect(result.status).toBe("release");
      expect(result.controlMode).toBe("pan");
      expectStopped(result);
    }
  });

  it("rejects a real 3D thumb/index pinch despite a thumb-up-looking image", () => {
    const observation = withWorld();
    observation.worldLandmarks![8] = { ...observation.worldLandmarks![4] };
    const result = holdThumbUp(new GestureInterpreter(), 0, 1000, observation);
    expect(result.controlMode).toBe("pan");
    expect(result.modeSwitchProgress).toBe(0);
  });

  it("trusts valid world finger geometry over a misleading thumb-up screen projection", () => {
    const observation = withWorld();
    // A straight index in 3D must reject thumb-up even if the image looks curled.
    observation.worldLandmarks![6] = { x: -0.02, y: -0.04, z: 0 };
    observation.worldLandmarks![7] = { x: -0.02, y: -0.07, z: 0 };
    observation.worldLandmarks![8] = { x: -0.02, y: -0.1, z: 0 };
    expect(
      holdThumbUp(new GestureInterpreter(), 0, 1000, observation).controlMode,
    ).toBe("pan");
  });

  it.each(["pan", "orbit", "zoom"] as const)(
    "does not grab in %s when fingertips overlap only in the image",
    (mode) => {
      const observation = withWorld();
      // This index is extended in 3D, so the pose is neither a pinch nor a
      // thumb-up. A side-on image still puts both fingertips at the same pixel.
      observation.worldLandmarks![6] = { x: -0.02, y: -0.04, z: 0 };
      observation.worldLandmarks![7] = { x: -0.02, y: -0.07, z: 0 };
      observation.worldLandmarks![8] = { x: -0.02, y: -0.1, z: 0 };
      observation.landmarks[8] = { ...observation.landmarks[4] };
      const interpreter = new GestureInterpreter();
      interpreter.setMode(mode);
      interpreter.reset(true);
      expect(interpreter.update([observation], 0, 1).status).toBe("release");
      // The same 3D separation also counts as neutral release, even though
      // the 2D-only test would have incorrectly kept the grab latched.
      expect(interpreter.update([observation], 120, 1).status).toBe("idle");
      for (const timestamp of [150, 250, 300]) {
        observation.landmarks = observation.landmarks.map((point) => ({
          ...point,
          x: point.x - 0.02,
          y: point.y - 0.02,
        }));
        const result = interpreter.update([observation], timestamp, 1);
        expect(result.status).toBe("idle");
        expectStopped(result);
      }
    },
  );

  it("arms, drags and releases using 3D pinch hysteresis when image fingertips look separated", () => {
    const observation = withWorld();
    const thumb = observation.worldLandmarks![4];
    const setPinchRatio = (ratio: number) => {
      // This fixture's world wrist-to-middle-MCP palm length is 0.05 m.
      observation.worldLandmarks![8] = {
        ...thumb,
        x: thumb.x + ratio * 0.05,
      };
    };
    const interpreter = new GestureInterpreter();
    setPinchRatio(0.5);
    expect(interpreter.update([observation], 0, 1).status).toBe("idle");
    setPinchRatio(0.37);
    expect(interpreter.update([observation], 20, 1).status).toBe("arming");
    expect(interpreter.update([observation], 120, 1).status).toBe("pan");
    setPinchRatio(0.5);
    observation.landmarks = observation.landmarks.map((point) => ({
      ...point,
      x: point.x - 0.04,
    }));
    const moved = interpreter.update([observation], 150, 1);
    expect(moved.status).toBe("pan");
    expect(moved.input.dx).toBeGreaterThan(0);
    setPinchRatio(0.59);
    // Prevent a deliberate thumb-up while verifying ordinary pinch release.
    observation.landmarks[1].y = observation.landmarks[4].y - 0.05;
    const released = interpreter.update([observation], 180, 1);
    expect(released.status).toBe("idle");
    expectStopped(released);
  });

  it("rejects tracking teleports and changes in camera aspect ratio", () => {
    for (const [observation, aspect] of [
      [hand(0.9), 1],
      [hand(), 16 / 9],
    ] as const) {
      const interpreter = new GestureInterpreter();
      arm(interpreter);
      const result = interpreter.update([observation], 283, aspect);
      expect(result.status).toBe("release");
      expectStopped(result);
    }
  });

  it("rejects malformed landmarks and never emits nonfinite camera commands", () => {
    const malformed: HandObservation[] = [
      { landmarks: [] },
      {
        landmarks: hand().landmarks.map((point, index) =>
          index === 8 ? { ...point, x: NaN } : point,
        ),
      },
      {
        landmarks: hand().landmarks.map((point, index) =>
          index === 4 ? { ...point, z: Infinity } : point,
        ),
      },
      { landmarks: hand().landmarks.map((point) => ({ ...point, y: 3 })) },
      { landmarks: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 })) },
    ];
    for (const invalid of malformed) {
      const interpreter = new GestureInterpreter();
      arm(interpreter);
      expectStopped(interpreter.update([invalid], 300, 1));
    }
    for (const aspect of [0, NaN, Infinity])
      expectStopped(new GestureInterpreter().update([hand()], 0, aspect));
    expectStopped(new GestureInterpreter().update([hand()], NaN, 1));
  });
});
