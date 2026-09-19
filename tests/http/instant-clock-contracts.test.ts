import { describe, expect, it } from "vitest";
import examples from "../../docs/engineering_v0.5/contracts/examples.json";
import { ContractRegistry } from "../../server/http/contracts";

const contracts = new ContractRegistry(process.cwd());

describe("instant-action and elapsed-time wire compatibility", () => {
  it("accepts historical projections, outcomes and clock samples without the new fields", () => {
    for (const schema of [
      "SessionProjection",
      "OutcomeView",
      "SseClockSample",
    ] as const)
      expect(contracts.errors(schema, examples[schema])).toEqual([]);
  });

  it.each(["instant", "realtime"])(
    "accepts %s projections with independent simulation and player times",
    (actionTiming) => {
      expect(
        contracts.errors("SessionProjection", {
          ...examples.SessionProjection,
          actionTiming,
          missionTimeMs: 475000,
          playerElapsedMs: 17000,
        }),
      ).toEqual([]);
    },
  );

  it("accepts sealed actual play time and elapsed-only clock updates", () => {
    expect(
      contracts.errors("OutcomeView", {
        ...examples.OutcomeView,
        sealedAtMissionMs: 475000,
        playerElapsedMs: 17000,
      }),
    ).toEqual([]);
    expect(
      contracts.errors("SseClockSample", {
        ...examples.SseClockSample,
        data: {
          ...examples.SseClockSample.data,
          missionTimeMs: 30000,
          playerElapsedMs: 17000,
        },
      }),
    ).toEqual([]);
  });

  it.each([-1, 0.5, null, "15000", Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid player elapsed values across public shapes: %s",
    (playerElapsedMs) => {
      expect(
        contracts.errors("SessionProjection", {
          ...examples.SessionProjection,
          playerElapsedMs,
        }),
      ).not.toEqual([]);
      expect(
        contracts.errors("OutcomeView", {
          ...examples.OutcomeView,
          playerElapsedMs,
        }),
      ).not.toEqual([]);
      expect(
        contracts.errors("SseClockSample", {
          ...examples.SseClockSample,
          data: { ...examples.SseClockSample.data, playerElapsedMs },
        }),
      ).not.toEqual([]);
    },
  );

  it("does not accept an unknown timing mode or expose timing overrides in commands", () => {
    expect(
      contracts.errors("SessionProjection", {
        ...examples.SessionProjection,
        actionTiming: "arbitrary",
      }),
    ).not.toEqual([]);
    expect(
      contracts.errors("CreateSessionRequest", {
        ...examples.CreateSessionRequest,
        actionTiming: "realtime",
      }),
    ).not.toEqual([]);
  });
});
