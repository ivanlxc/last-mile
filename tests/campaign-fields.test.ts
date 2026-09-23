import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  fieldLayout,
  fieldCopy,
  FIELD_TOPICS,
} from "../client/src/lib/campaignField";
import {
  fieldPositionAllowed,
  nearbyStation,
} from "../client/src/lib/marketField";
import {
  chapterReceipt,
  arrivalStory,
} from "../client/src/lib/chapterPresentation";
import type {
  SceneId,
  OutcomeView,
  OperationView,
} from "../docs/engineering_v0.5/contracts/public.types";

describe("continuous chapter fields", () => {
  for (const scene of ["E1", "E2", "E3"] as SceneId[]) {
    it(`${scene}: all stations are reachable, public topics match role briefings`, () => {
      const layout = fieldLayout(scene);
      expect(fieldPositionAllowed(layout.spawn, layout)).toBe(true);
      const found = new Set<string>(),
        seen = new Set<string>(),
        queue = [{ x: layout.spawn.x, z: layout.spawn.z }];
      for (let i = 0; i < queue.length; i++) {
        const p = queue[i]!;
        for (const station of layout.stations) {
          const yaw = Math.atan2(-(station.x - p.x), -(station.z - p.z));
          const target = nearbyStation({ ...p, yaw, pitch: 0 }, layout);
          if (target) found.add(target);
        }
        for (const [dx, dz] of [
          [0.5, 0],
          [-0.5, 0],
          [0, 0.5],
          [0, -0.5],
        ]) {
          const next = { x: p.x + dx!, z: p.z + dz! },
            key = `${next.x}:${next.z}`;
          if (!seen.has(key) && fieldPositionAllowed(next, layout)) {
            seen.add(key);
            queue.push(next);
          }
        }
      }
      expect([...found].sort()).toEqual(["command", "noah", "recon", "samira"]);
      // Compare public menu to both authored variants without importing either in the client.
      const campaign = JSON.parse(
        readFileSync(
          "docs/engineering_v0.5/content/campaign-reference.json",
          "utf8",
        ),
      );
      for (const variant of campaign.cases)
        for (const role of ["analyst", "liaison"] as const)
          for (const topic of FIELD_TOPICS[scene][role])
            expect(
              variant.evidenceDefinitions.some(
                (d: any) =>
                  d.sceneId === scene &&
                  d.sourceRole === role &&
                  d.topicId === topic &&
                  d.acquisition === "preloaded",
              ),
            ).toBe(true);
      expect(fieldCopy(scene, false).title).not.toEqual(
        fieldCopy(scene, true).title,
      );
    });
  }
  it("does not infer permission or arrival before a confirmed public result", () => {
    const op = {
      status: "running",
      operationKind: "action",
      actionId: "E3_BRIDGE",
      currentLocation: { nodeId: "N05" },
      publicProgressLabel: "Pending",
    } as OperationView;
    expect(chapterReceipt(op, false)).toBeNull();
    expect(chapterReceipt({ ...op, status: "completed" }, false)?.refused).toBe(
      true,
    );
    expect(
      chapterReceipt(
        {
          ...op,
          status: "completed",
          currentLocation: {
            nodeId: "N07",
            routeId: null,
            progressPermille: 0,
          },
        },
        false,
      )?.refused,
    ).toBe(false);
  });
  it("distinguishes arrival from unfinished handover and does not invent arrival", () => {
    const out = {
      finalLocation: { nodeId: "N07" },
      taskSuccess: true,
      terminationReason: "awaiting_transfer",
      pendingTasks: { manifest: "pending", inspection: "notRequired" },
    } as OutcomeView;
    expect(arrivalStory(out, false)?.scene).toContain(
      "waiting for the handover",
    );
    expect(
      arrivalStory(
        {
          ...out,
          finalLocation: { nodeId: "N05", routeId: null, progressPermille: 0 },
        },
        false,
      ),
    ).toBeNull();
    expect(
      arrivalStory(
        {
          ...out,
          terminationReason: "arrived",
          pendingTasks: { manifest: "completed", inspection: "notRequired" },
        },
        true,
      )?.scene,
    ).toContain("家门钥匙");
  });
  for (const level of ["gate", "bridge", "reception"])
    it(`${level}: asset is embedded, bounded and excludes cameras/lights`, () => {
      const bytes = readFileSync(`client/public/assets/fields/${level}-v1.glb`);
      const asset = JSON.parse(
        bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12)),
      );
      expect(bytes.toString("ascii", 0, 4)).toBe("glTF");
      expect(bytes.length).toBeLessThan(8 * 1024 * 1024);
      expect(asset.cameras ?? []).toHaveLength(0);
      expect(asset.extensions?.KHR_lights_punctual).toBeUndefined();
      expect(asset.buffers.every((b: any) => !b.uri)).toBe(true);
      expect(
        asset.images.every((i: any) => !i.uri && i.bufferView !== undefined),
      ).toBe(true);
      const manifest = JSON.parse(
        readFileSync(
          "assets/authoring/campaign-fields-v1/manifest.json",
          "utf8",
        ),
      ).find((m: any) => m.level === level);
      expect(manifest.bytes).toBe(bytes.length);
      expect(asset.meshes.length).toBeLessThanOrEqual(20);
    });
});
