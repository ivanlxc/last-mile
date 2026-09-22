import { describe, expect, it } from "vitest";
import {
  FIELD_SPAWN,
  fieldPositionAllowed,
  moveInField,
  nearbyStation,
} from "../client/src/lib/marketField";

describe("market first-person movement", () => {
  it("keeps equal speed diagonally and caps a resumed frame", () => {
    const straight = moveInField(FIELD_SPAWN, 0, 1, 0.03);
    const diagonal = moveInField(FIELD_SPAWN, 1, 1, 0.03);
    expect(Math.hypot(diagonal.x, diagonal.z - 11)).toBeCloseTo(
      11 - straight.z,
    );
    expect(moveInField(FIELD_SPAWN, 0, 1, 90)).toEqual(
      moveInField(FIELD_SPAWN, 0, 1, 0.05),
    );
    expect(moveInField(FIELD_SPAWN, NaN, 0, 1)).toEqual(FIELD_SPAWN);
  });
  it("stops at buildings and the perimeter but permits sliding alongside props", () => {
    let p = { ...FIELD_SPAWN };
    for (let i = 0; i < 500; i++) p = moveInField(p, 0, 1, 0.05);
    expect(p.z).toBeGreaterThanOrEqual(-14.68);
    expect(fieldPositionAllowed(p)).toBe(true);
    p = { x: -3.0, z: 4, yaw: 0, pitch: 0 };
    for (let i = 0; i < 5; i++) p = moveInField(p, -1, 1, 0.05);
    expect(p.x).toBeGreaterThanOrEqual(-3.28);
    expect(p.z).toBeLessThan(4);
    expect(fieldPositionAllowed({ x: -9, z: -11 })).toBe(false);
    expect(fieldPositionAllowed({ x: 6.1, z: 10 })).toBe(false);
  });
  it("requires a clear, near, forward interaction target", () => {
    expect(nearbyStation(FIELD_SPAWN)).toBeNull();
    expect(nearbyStation({ x: -2.8, z: 6.7, yaw: 0, pitch: 0 })).toBe("noah");
    expect(
      nearbyStation({ x: -2.8, z: 6.7, yaw: Math.PI, pitch: 0 }),
    ).toBeNull();
    // Looking at Noah through his work table does not permit interaction.
    expect(
      nearbyStation({ x: -5.7, z: 5, yaw: -Math.PI / 2, pitch: 0 }),
    ).toBeNull();
  });
  it("crew bodies block walking without blocking their own interaction target", () => {
    let pose = { x: -1.5, z: 5, yaw: 0, pitch: 0 };
    for (let i = 0; i < 50; i++) pose = moveInField(pose, -1, 0, 0.05);
    expect(pose.x).toBeGreaterThanOrEqual(-2.64);
    expect(nearbyStation({ ...pose, yaw: Math.PI / 2 })).toBe("noah");
    expect(nearbyStation({ x: -2.45, z: 6.1, yaw: 0.9, pitch: 0 })).toBe(
      "noah",
    );
  });
});
