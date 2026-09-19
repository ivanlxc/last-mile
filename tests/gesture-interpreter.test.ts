import { describe, expect, it } from "vitest";
import {
  GestureInterpreter,
  type GestureResult,
  type HandObservation,
} from "../client/src/lib/gestures/gestureInterpreter";

function hand(
  x = 0.4,
  y = 0.5,
  pinchRatio = 0.2,
  aspect = 1,
  handedness = "Left",
): HandObservation {
  const landmarks = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  landmarks[0] = { x, y: y + 0.08, z: 0 };
  landmarks[9] = { x, y: y - 0.02, z: 0 };
  landmarks[5] = { x: x - 0.04 / aspect, y: y - 0.02, z: 0 };
  landmarks[13] = { x: x + 0.02 / aspect, y: y - 0.02, z: 0 };
  landmarks[17] = { x: x + 0.02 / aspect, y: y - 0.02, z: 0 };
  landmarks[4] = { x, y: y - 0.12, z: 0 };
  landmarks[8] = { x: x + (pinchRatio * 0.1) / aspect, y: y - 0.12, z: 0 };
  return { landmarks, handedness };
}

function arm(
  interpreter: GestureInterpreter,
  hands: HandObservation[] = [hand()],
  aspect = 1,
): GestureResult {
  expect(interpreter.update(hands, 0, aspect).status).toBe("arming");
  return interpreter.update(hands, 100, aspect);
}

function expectStopped(result: GestureResult) {
  expect(result.input).toEqual({ mode: "stop", dx: 0, dy: 0, zoomLog: 0 });
}

describe("camera gesture interpreter", () => {
  it("arms by elapsed time and anchors the first pinch without movement", () => {
    const interpreter = new GestureInterpreter();
    expect(interpreter.update([hand()], 0, 1).status).toBe("arming");
    expect(interpreter.update([hand(0.42)], 99, 1).status).toBe("arming");
    const start = interpreter.update([hand(0.44)], 100, 1);
    expect(start.status).toBe("pan");
    expect(start.input).toEqual({ mode: "pan", dx: 0, dy: 0, zoomLog: 0 });
  });

  it.each([10, 20, 25, 50, 100])(
    "uses the same arming delay at %i ms frame intervals",
    (interval) => {
      const interpreter = new GestureInterpreter();
      for (let timestamp = 0; timestamp < 100; timestamp += interval) {
        expect(interpreter.update([hand()], timestamp, 1).status).toBe(
          "arming",
        );
      }
      expect(interpreter.update([hand()], 100, 1).status).toBe("pan");
    },
  );

  it("mirrors horizontal input and makes upward motion positive", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter);
    const rightUp = interpreter.update([hand(0.36, 0.46)], 150, 1);
    expect(rightUp.input.dx).toBeGreaterThan(0);
    expect(rightUp.input.dy).toBeGreaterThan(0);
    expect(rightUp.input.dx).toBeLessThan(0.04);
    expect(rightUp.input.zoomLog).toBe(0);
    interpreter.reset();
    arm(interpreter);
    const leftDown = interpreter.update([hand(0.44, 0.54)], 150, 1);
    expect(leftDown.input.dx).toBeLessThan(0);
    expect(leftDown.input.dy).toBeLessThan(0);
  });

  it("uses pinch hysteresis and stops immediately on release without filter drift", () => {
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
    const released = interpreter.update([hand(0.32, 0.5, 0.59)], 180, 1);
    expect(released.status).toBe("idle");
    expectStopped(released);
    expectStopped(interpreter.update([hand(0.3, 0.5, 0.8)], 210, 1));
  });

  it("does not turn subpixel hand jitter into camera motion", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter);
    for (let i = 1; i <= 20; i++) {
      const result = interpreter.update(
        [hand(0.4 + (i % 2 ? 0.0005 : -0.0005))],
        100 + i * 33,
        1,
      );
      expect(result.input.dx).toBe(0);
      expect(result.input.dy).toBe(0);
    }
  });

  it("ignores duplicate timestamps without replaying a pan", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter);
    const moved = interpreter.update([hand(0.36)], 150, 1);
    expect(moved.input.dx).toBeGreaterThan(0);
    expectStopped(interpreter.update([hand(0.3)], 150, 1));
  });

  it("requires release after a dropout and reanchors a subsequent grab", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter);
    expect(interpreter.update([hand(0.36)], 150, 1).input.dx).toBeGreaterThan(
      0,
    );
    expect(interpreter.update([], 175, 1).status).toBe("release");
    const returned = interpreter.update([hand(0.7)], 200, 1);
    expect(returned.status).toBe("release");
    expectStopped(returned);
    expect(interpreter.update([hand(0.7, 0.5, 0.8)], 250, 1).status).toBe(
      "idle",
    );
    expect(interpreter.update([hand(0.7)], 300, 1).status).toBe("arming");
    const nextGrab = interpreter.update([hand(0.68)], 400, 1);
    expect(nextGrab.input).toEqual({ mode: "pan", dx: 0, dy: 0, zoomLog: 0 });
  });

  it("cancels a pinch that disappears before arming completes", () => {
    const interpreter = new GestureInterpreter();
    interpreter.update([hand()], 0, 1);
    interpreter.update([], 50, 1);
    expect(interpreter.update([hand()], 100, 1).status).toBe("release");
  });

  it("requires release after a long frame gap or nonmonotonic time", () => {
    for (const timestamp of [351, 80]) {
      const interpreter = new GestureInterpreter();
      arm(interpreter);
      const gap = interpreter.update([hand(0.35)], timestamp, 1);
      expect(gap.status).toBe("release");
      expectStopped(gap);
    }
  });

  it("supports an explicit release requirement when the mouse takes over", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter);
    interpreter.reset(true);
    expect(interpreter.update([hand()], 200, 1).status).toBe("release");
    expect(interpreter.update([hand(0.4, 0.5, 0.8)], 250, 1).status).toBe(
      "idle",
    );
    expect(interpreter.update([hand()], 300, 1).status).toBe("arming");
    expect(interpreter.update([hand()], 400, 1).status).toBe("pan");
  });

  it("pauses pan while a second pinch arms and starts zoom at zero", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter, [hand(0.3)]);
    const joining = interpreter.update([hand(0.28), hand(0.7)], 150, 1);
    expect(joining.status).toBe("arming");
    expectStopped(joining);
    const zoomStart = interpreter.update([hand(0.25), hand(0.75)], 250, 1);
    expect(zoomStart.status).toBe("zoom");
    expect(zoomStart.input).toEqual({ mode: "zoom", dx: 0, dy: 0, zoomLog: 0 });
    const wider = interpreter.update([hand(0.22), hand(0.78)], 300, 1);
    expect(wider.input.zoomLog).toBeGreaterThan(0);
    expect(wider.input.dx).toBe(0);
    expect(wider.input.dy).toBe(0);
  });

  it("does not zoom when both hands translate by the same distance", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter, [hand(0.3), hand(0.7)]);
    expect(
      interpreter.update([hand(0.32, 0.53), hand(0.72, 0.53)], 150, 1).input
        .zoomLog,
    ).toBe(0);
  });

  it("uses aspect-correct separation for diagonal two-hand zoom", () => {
    const results = [1, 2].map((aspect) => {
      const interpreter = new GestureInterpreter();
      const start = [
        hand(0.5 - 0.2 / aspect, 0.4, 0.2, aspect),
        hand(0.5 + 0.2 / aspect, 0.6, 0.2, aspect),
      ];
      arm(interpreter, start, aspect);
      return interpreter.update(
        [
          hand(0.5 - 0.2 / aspect, 0.35, 0.2, aspect),
          hand(0.5 + 0.2 / aspect, 0.65, 0.2, aspect),
        ],
        150,
        aspect,
      ).input.zoomLog;
    });
    expect(results[0]).toBeGreaterThan(0);
    expect(results[1]).toBeCloseTo(results[0], 10);
  });

  it("retains identity if observation order and handedness labels flip", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter, [
      hand(0.3, 0.5, 0.2, 1, "Left"),
      hand(0.7, 0.5, 0.8, 1, "Right"),
    ]);
    const reordered = interpreter.update(
      [hand(0.7, 0.5, 0.8, 1, "Left"), hand(0.26, 0.5, 0.2, 1, "Right")],
      150,
      1,
    );
    expect(reordered.status).toBe("pan");
    expect(reordered.input.dx).toBeGreaterThan(0);
  });

  it("keeps two-hand zoom stable when output order flips", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter, [hand(0.3), hand(0.7)]);
    const reordered = interpreter.update([hand(0.73), hand(0.27)], 150, 1);
    expect(reordered.status).toBe("zoom");
    expect(reordered.input.zoomLog).toBeGreaterThan(0);
  });

  it.each(["open", "lost"])(
    "prevents an accidental pan when one zoom hand is %s",
    (kind) => {
      const interpreter = new GestureInterpreter();
      arm(interpreter, [hand(0.3), hand(0.7)]);
      const remaining =
        kind === "open" ? [hand(0.28), hand(0.7, 0.5, 0.8)] : [hand(0.28)];
      const result = interpreter.update(remaining, 150, 1);
      expect(result.status).toBe("release");
      expectStopped(result);
      expect(interpreter.update([hand(0.25)], 200, 1).status).toBe("release");
    },
  );

  it("stops if an active hand disappears while another open hand remains", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter, [hand(0.3), hand(0.7, 0.5, 0.8)]);
    expect(interpreter.update([hand(0.7, 0.5, 0.8)], 150, 1).status).toBe(
      "release",
    );
  });

  it("stops at close/crossed hands instead of exchanging identities", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter, [hand(0.35), hand(0.65)]);
    const crossing = interpreter.update([hand(0.47), hand(0.53)], 150, 1);
    expect(crossing.status).toBe("release");
    expectStopped(crossing);
  });

  it("rejects an ambiguous geometric assignment even if hands are separated", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter, [hand(0.4), hand(0.6)]);
    const ambiguous = interpreter.update(
      [hand(0.5, 0.4), hand(0.5, 0.6)],
      150,
      1,
    );
    expect(ambiguous.status).toBe("release");
    expectStopped(ambiguous);
  });

  it("rejects a tracking teleport instead of sending a large camera delta", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter);
    const teleport = interpreter.update([hand(0.9)], 133, 1);
    expect(teleport.status).toBe("release");
    expectStopped(teleport);
  });

  it("rejects a sudden separation change even if each hand's step is small", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter, [hand(0.43), hand(0.57)]);
    const jump = interpreter.update([hand(0.35), hand(0.65)], 150, 1);
    expect(jump.status).toBe("release");
    expectStopped(jump);
  });

  it("releases if the camera feed changes aspect ratio mid-grab", () => {
    const interpreter = new GestureInterpreter();
    arm(interpreter);
    expect(interpreter.update([hand()], 150, 16 / 9).status).toBe("release");
  });

  it("rejects invalid observations and never emits NaN or infinity", () => {
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
      const result = interpreter.update([invalid], 150, 1);
      expect(result.status).toBe("release");
      expectStopped(result);
    }
    for (const aspect of [0, NaN, Infinity]) {
      expectStopped(new GestureInterpreter().update([hand()], 0, aspect));
    }
    expectStopped(new GestureInterpreter().update([hand()], NaN, 1));
    expectStopped(
      new GestureInterpreter().update([hand(), hand(), hand()], 0, 1),
    );
  });
});
