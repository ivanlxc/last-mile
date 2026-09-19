import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUnityRenderState,
  canApplyUnitySnapshot,
  loadUnityFactory,
  loadUnityManifest,
  parseUnityBridgeEvent,
  serializeUnityRenderState,
  validateUnityManifest,
} from "../client/src/lib/unity";
import { mapData } from "../client/src/lib/map";

const manifest = {
  schemaVersion: 1,
  loaderUrl: "/unity/Build/LastMile.loader.js",
  dataUrl: "/unity/Build/LastMile.data.br",
  frameworkUrl: "/unity/Build/LastMile.framework.js.br",
  codeUrl: "/unity/Build/LastMile.wasm.br",
  companyName: "LAST MILE",
  productName: "LAST MILE",
  productVersion: "0.1.0",
};
const session = {
  sessionId: "session-1",
  runEpoch: "run-1",
  stateVersion: 12,
  sceneId: "E1" as const,
  phase: "scene" as const,
  lifecycle: "active" as const,
  missionTimeMs: 1000,
  location: { nodeId: "N01", routeId: null, progressPermille: 0 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Unity asset trust boundary", () => {
  it("accepts the build manifest without forwarding additional script config", () => {
    expect(
      validateUnityManifest({
        ...manifest,
        streamingAssetsUrl: "https://example.org/hidden",
      }),
    ).toEqual(manifest);
  });
  it.each([
    "https://example.org/evil.js",
    "//example.org/evil.js",
    "/api/v1/evil.js",
    "/unity/../../evil.js",
    "/unity/./evil.js",
    "/unity/%2e%2e/evil.js",
    "/unity/%252e%252e/evil.js",
    "/unity/Build\\evil.js",
    "/unity//evil.js",
    "/unity/Build/evil.js?redirect=1",
    "/unity/Build/evil.js#x",
    "javascript:alert(1)",
    "/unity/Build/",
  ])("rejects non-build or ambiguous executable path %s", (loaderUrl) => {
    expect(() => validateUnityManifest({ ...manifest, loaderUrl })).toThrow();
  });
  it("guards every resource and the version, not just the loader", () => {
    for (const key of ["dataUrl", "frameworkUrl", "codeUrl"])
      expect(() =>
        validateUnityManifest({
          ...manifest,
          [key]: "https://example.org/payload",
        }),
      ).toThrow();
    expect(() =>
      validateUnityManifest({ ...manifest, schemaVersion: 2 }),
    ).toThrow();
    expect(() =>
      validateUnityManifest({ ...manifest, productVersion: "" }),
    ).toThrow();
  });
  it("treats missing builds and SPA HTML fallbacks as unavailable", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("<!doctype html><html></html>"));
    vi.stubGlobal("fetch", fetcher);
    await expect(loadUnityManifest()).rejects.toThrow("not installed");
    await expect(loadUnityManifest()).rejects.toThrow("missing or invalid");
    expect(fetcher).toHaveBeenCalledWith(
      "/unity/manifest.json",
      expect.objectContaining({ redirect: "error", cache: "no-store" }),
    );
  });
  it("retries a failed loader and shares only a successful factory", async () => {
    const scripts: Array<{
      onload: (() => void) | null;
      onerror: (() => void) | null;
      remove: () => void;
    }> = [];
    vi.stubGlobal("document", {
      createElement: () => ({ remove: vi.fn() }),
      head: {
        append: (script: (typeof scripts)[number]) => scripts.push(script),
      },
    });
    const factory = vi.fn();
    vi.stubGlobal("window", { createUnityInstance: factory });
    const config = validateUnityManifest({
      ...manifest,
      loaderUrl: "/unity/Build/retry.loader.js",
    });
    const failure = loadUnityFactory(config);
    const rejected = expect(failure).rejects.toThrow("could not be loaded");
    scripts[0].onerror?.();
    await rejected;
    const retry = loadUnityFactory(config);
    expect(loadUnityFactory(config)).toBe(retry);
    expect(scripts).toHaveLength(2);
    scripts[1].onload?.();
    await expect(retry).resolves.toBe(factory);
    expect(factory).not.toHaveBeenCalled();
    expect(scripts[0].remove).toHaveBeenCalled();
    expect(scripts[1].remove).toHaveBeenCalled();
  });
});

describe("Unity public rendering boundary", () => {
  it("excludes report contents, AI context and hidden fields at both boundaries", () => {
    const untrustedExtra = {
      ...session,
      reports: [{ body: "REPORT_CONTENT_SECRET" }],
      truth: "WORLD_TRUTH_SECRET",
      latestAdviceJob: { answer: "AI_CONTEXT_SECRET" },
      location: { ...session.location, truth: "LOCATION_SECRET" },
    };
    const state = buildUnityRenderState(untrustedExtra, "zh-CN", "N05");
    const contaminated = {
      ...state,
      truth: "SECOND_BOUNDARY_SECRET",
      map: {
        ...state.map,
        nodes: [
          ...state.map.nodes,
          { nodeId: "SECRET_NODE", sceneId: null, position: [1, 2, 3] },
        ],
      },
    };
    const wire = serializeUnityRenderState(contaminated, "instance-a", 41);
    expect(wire).not.toContain("SECRET");
    const value = JSON.parse(wire);
    expect(value.instanceId).toBe("instance-a");
    expect(value.viewSequence).toBe(41);
    expect(value.selectedNodeId).toBe("N05");
    expect(value.map.nodes).toHaveLength(mapData.nodes.length);
    expect(value.map.routes[0]).not.toHaveProperty("durationMs");
    expect(value).not.toHaveProperty("reports");
  });
  it("does not let unknown locations or invalid progress become renderable facts", () => {
    const state = buildUnityRenderState(
      {
        ...session,
        location: {
          nodeId: "private-node",
          routeId: "private-route",
          progressPermille: NaN,
        },
      },
      "en-US",
      "private-node",
    );
    expect(state.location).toEqual({
      nodeId: null,
      routeId: null,
      progressPermille: 0,
    });
    expect(state.selectedNodeId).toBeNull();
  });
  it("accepts a clock update at equal stateVersion but rejects old snapshots within a run", () => {
    const first = buildUnityRenderState(session, "en-US");
    expect(
      canApplyUnitySnapshot(first, { ...first, missionTimeMs: 2000 }),
    ).toBe(true);
    expect(canApplyUnitySnapshot(first, { ...first, missionTimeMs: 900 })).toBe(
      false,
    );
    expect(
      canApplyUnitySnapshot(first, {
        ...first,
        stateVersion: 11,
        missionTimeMs: 2000,
      }),
    ).toBe(false);
    expect(
      canApplyUnitySnapshot(first, {
        ...first,
        runEpoch: "run-2",
        stateVersion: 1,
        missionTimeMs: 0,
      }),
    ).toBe(true);
    expect(
      canApplyUnitySnapshot(first, { ...first, selectedNodeId: "N05" }),
    ).toBe(true);
  });
  it("rejects events from retired instances, unknown nodes and command attempts", () => {
    const event = {
      schemaVersion: 1,
      instanceId: "instance-a",
      type: "select-location",
      nodeId: "N01",
    };
    expect(parseUnityBridgeEvent(event, "instance-a")).toEqual(event);
    expect(parseUnityBridgeEvent(event, "instance-b")).toBeNull();
    expect(
      parseUnityBridgeEvent({ ...event, nodeId: "SECRET_NODE" }, "instance-a"),
    ).toBeNull();
    expect(
      parseUnityBridgeEvent(
        { ...event, type: "start-investigation" },
        "instance-a",
      ),
    ).toBeNull();
    expect(
      parseUnityBridgeEvent({ ...event, schemaVersion: 2 }, "instance-a"),
    ).toBeNull();
    expect(
      parseUnityBridgeEvent(
        { ...event, type: "ready", hidden: "x" },
        "instance-a",
      ),
    ).toEqual({ schemaVersion: 1, instanceId: "instance-a", type: "ready" });
  });
});
