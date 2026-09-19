import { describe, expect, it } from "vitest";
import type { P } from "../client/src/lib/api";
import fixtures from "../docs/engineering_v0.5/contracts/fixtures/public-cases.json";
import { applyClockSample } from "../client/src/lib/clockSample";
import { buildUnityRenderState } from "../client/src/lib/unity";

const reference = fixtures.cases.find(
  (entry) => entry.name === "valid_SessionProjection",
)!.instance as P.SessionProjection;
const previous: P.SessionProjection = {
  ...reference,
  lifecycle: "active",
  phase: "resolving",
  stateVersion: 3,
  missionTimeMs: 1000,
  location: { nodeId: null, routeId: "R00", progressPermille: 33 },
};
const sample: P.SseClockSample = {
  eventType: "clock.sample",
  sessionId: previous.sessionId,
  runEpoch: previous.runEpoch,
  viewSequence: 20,
  stateVersion: 3,
  data: {
    missionTimeMs: 6000,
    serverNow: "2026-09-18T17:00:06.000Z",
    missionDeadlineMs: 600000,
    location: { nodeId: null, routeId: "R00", progressPermille: 200 },
  },
};

describe("authoritative clock and convoy samples", () => {
  it("advances the rendered convoy between game events without changing stateVersion", () => {
    const result = applyClockSample(previous, sample)!;
    expect(result.missionTimeMs).toBe(6000);
    expect(result.stateVersion).toBe(previous.stateVersion);
    expect(buildUnityRenderState(result, "en-US").location).toEqual(
      sample.data.location,
    );
    expect(previous.location.progressPermille).toBe(33);
  });
  it.each([
    { sessionId: "different-session" },
    { runEpoch: "previous-run" },
    { stateVersion: 2 },
    { stateVersion: 4 },
    { data: { ...sample.data, missionTimeMs: 999 } },
  ])("rejects an out-of-scope or stale packet: %o", (change) => {
    expect(applyClockSample(previous, { ...sample, ...change })).toBe(previous);
  });
  it("does not move a sealed session", () => {
    const sealed = { ...previous, lifecycle: "sealed" as const };
    expect(applyClockSample(sealed, sample)).toBe(sealed);
  });
  it("accepts historical clock packets without inventing a future position", () => {
    const { location: _, ...data } = sample.data;
    const result = applyClockSample(previous, { ...sample, data })!;
    expect(result.missionTimeMs).toBe(6000);
    expect(result.location).toEqual(previous.location);
  });
});
