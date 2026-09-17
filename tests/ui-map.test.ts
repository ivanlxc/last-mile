import { describe, it, expect } from "vitest";
import { locationPoint, pointOnRoute, mapData } from "../client/src/lib/map";
import { readFileSync } from "node:fs";
import {
  channelScopes,
  getChannelScopes,
} from "../client/src/components/ContextModal";
import { publicChannelScopeText } from "../server/ai/public-checks";
describe("public client geometry and attribution copy", () => {
  it("interpolates actual arc length on uneven segments and clamps ends", () => {
    const p = [
      [0, 0, 0],
      [1, 0, 0],
      [10, 0, 0],
    ];
    expect(pointOnRoute(p, 0.5)).toEqual([5, 0, 0]);
    expect(pointOnRoute(p, -1)).toEqual([0, 0, 0]);
    expect(pointOnRoute(p, 2)).toEqual([10, 0, 0]);
  });
  it("uses authored public waypoints including reverse fractions without coordinate re-conversion", () => {
    for (const r of mapData.routes) {
      expect(
        locationPoint({
          routeId: r.routeId,
          nodeId: null,
          progressPermille: 0,
        }),
      ).toEqual(r.waypoints[0]);
      expect(
        locationPoint({
          routeId: r.routeId,
          nodeId: null,
          progressPermille: 1000,
        }),
      ).toEqual(r.waypoints.at(-1));
    }
    expect(
      locationPoint({ routeId: null, nodeId: "N05", progressPermille: 0 }),
    ).toEqual(mapData.nodes.find((n) => n.nodeId === "N05")!.position);
  });
  it("ships exactly the same public map as the server", () => {
    expect(mapData).toEqual(
      JSON.parse(
        readFileSync("docs/engineering_v0.5/content/public-map.json", "utf8"),
      ),
    );
  });
  it("shows the precise capability limitations used by evaluation", () => {
    for (const channel of [
      "satellite",
      "drone",
      "localAgency",
      "witness",
    ] as const)
      expect(channelScopes[channel]).toEqual(publicChannelScopeText(channel));
  });
  it("keeps English channel limitations identical to the evaluation rules", () => {
    for (const channel of [
      "satellite",
      "drone",
      "localAgency",
      "witness",
    ] as const)
      expect(getChannelScopes("en-US")[channel]).toEqual(
        publicChannelScopeText(channel, "en-US"),
      );
  });
});
