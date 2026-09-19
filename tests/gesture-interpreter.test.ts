import { describe, expect, it } from "vitest";
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

// A palm-facing V with straight index/middle and bent ring/little fingers.
// Coordinates stay independent of camera aspect and support rotated-hand tests.
function vHand(x = 0.4, y = 0.5, aspect = 1): HandObservation {
  const result = hand(x, y, 1, aspect);
  const offsets: Record<number, [number, number]> = {
    4: [-0.07, 0.04],
    6: [-0.055, -0.085],
    7: [-0.065, -0.13],
    8: [-0.075, -0.17],
    10: [0.02, -0.09],
    11: [0.03, -0.14],
    12: [0.04, -0.19],
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

function holdV(
  interpreter: GestureInterpreter,
  start: number,
  end: number,
  observation = vHand(),
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

  it("shows timed V progress and switches exactly once while V is held for two seconds", () => {
    const interpreter = new GestureInterpreter();
    expect(interpreter.update([vHand()], 0, 1).status).toBe("switching");
    const middle = holdV(interpreter, 100, 350);
    expect(middle.modeSwitchProgress).toBeCloseTo(0.5);
    expect(middle.controlMode).toBe("pan");
    const switched = holdV(interpreter, 450, 700);
    expect(switched.status).toBe("release");
    expect(switched.controlMode).toBe("orbit");
    expect(switched.modeSwitchProgress).toBe(1);
    expectStopped(switched);
    const held = holdV(interpreter, 800, 2000);
    expect(held.controlMode).toBe("orbit");
    expectStopped(held);
  });

  it("cycles pan → orbit → zoom → pan with neutral release between V holds", () => {
    const interpreter = new GestureInterpreter();
    expect(holdV(interpreter, 0, 700).controlMode).toBe("orbit");
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
      expect(holdV(interpreter, base + 150, base + 850).controlMode).toBe(mode);
    }
  });

  it("keeps V latched through a brief neutral misclassification and a dropped frame", () => {
    const interpreter = new GestureInterpreter();
    holdV(interpreter, 0, 700);
    interpreter.update([hand(0.4, 0.5, 0.8)], 750, 1);
    expect(holdV(interpreter, 783, 1500).controlMode).toBe("orbit");
    interpreter.update([], 1533, 1);
    expect(holdV(interpreter, 1566, 2300).controlMode).toBe("orbit");
  });

  it("does not treat V as the required neutral release after a mode change", () => {
    const interpreter = new GestureInterpreter();
    interpreter.setMode("zoom");
    const held = holdV(interpreter, 0, 1000);
    expect(held.controlMode).toBe("zoom");
    expect(held.status).toBe("release");
    expect(interpreter.update([hand()], 1100, 1).status).toBe("release");
  });

  it("cancels an incomplete V and starts a fresh hold next time", () => {
    const interpreter = new GestureInterpreter();
    expect(holdV(interpreter, 0, 400).status).toBe("switching");
    const cancelled = interpreter.update([hand(0.4, 0.5, 0.8)], 450, 1);
    expect(cancelled.modeSwitchProgress).toBe(0);
    expect(cancelled.controlMode).toBe("pan");
    expect(holdV(interpreter, 500, 1100).controlMode).toBe("pan");
    expect(interpreter.update([vHand()], 1200, 1).controlMode).toBe("orbit");
  });

  it("cancels the V timer on a long gap or second hand", () => {
    for (const gap of [true, false]) {
      const interpreter = new GestureInterpreter();
      holdV(interpreter, 0, 400);
      const interrupted = gap
        ? interpreter.update([vHand()], 700, 1)
        : interpreter.update([vHand(), hand(0.7)], 500, 1);
      expect(interrupted.status).toBe("release");
      expect(interrupted.modeSwitchProgress).toBe(0);
      expect(interpreter.getMode()).toBe("pan");
      expect(holdV(interpreter, 750, 1500).controlMode).toBe("pan");
    }
  });

  it("resets V progress when the hand moves out of its hold position", () => {
    const interpreter = new GestureInterpreter();
    holdV(interpreter, 0, 400);
    const moved = interpreter.update([vHand(0.54)], 500, 1);
    expect(moved.status).toBe("switching");
    expect(moved.modeSwitchProgress).toBe(0);
    expect(holdV(interpreter, 600, 1100, vHand(0.54)).controlMode).toBe("pan");
    expect(interpreter.update([vHand(0.54)], 1200, 1).controlMode).toBe(
      "orbit",
    );
  });

  it("recognizes the same V with wide camera pixels or a rotated hand", () => {
    for (const aspect of [1, 16 / 9]) {
      const original = vHand(0.5, 0.5, aspect);
      const rotated = {
        ...original,
        landmarks: original.landmarks.map((p) => ({
          ...p,
          x: 0.5 - (p.y - 0.5) / aspect,
          y: 0.5 + (p.x - 0.5) * aspect,
        })),
      };
      expect(
        new GestureInterpreter().update([original], 0, aspect).status,
      ).toBe("switching");
      expect(new GestureInterpreter().update([rotated], 0, aspect).status).toBe(
        "switching",
      );
    }
  });

  it("rejects open palms, pinches, and partly extended fingers as V commands", () => {
    const variants: HandObservation[] = [hand(0.4, 0.5, 0.8), hand()];
    const openRing = vHand();
    openRing.landmarks[14] = { x: 0.43, y: 0.43 };
    openRing.landmarks[15] = { x: 0.44, y: 0.38 };
    openRing.landmarks[16] = { x: 0.45, y: 0.33 };
    variants.push(openRing);
    const bentIndex = vHand();
    bentIndex.landmarks[7] = { x: 0.36, y: 0.47 };
    bentIndex.landmarks[8] = { x: 0.36, y: 0.5 };
    variants.push(bentIndex);
    const pinchedV = vHand();
    pinchedV.landmarks[4] = { ...pinchedV.landmarks[8] };
    variants.push(pinchedV);
    for (const observation of variants) {
      const interpreter = new GestureInterpreter();
      const result = holdV(interpreter, 0, 1000, observation);
      expect(result.controlMode).toBe("pan");
      expect(result.modeSwitchProgress).toBe(0);
    }
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
