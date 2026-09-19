import type {
  KnownLocation,
  SceneId,
  SessionProjection,
} from "../../../docs/engineering_v0.5/contracts/public.types";
import type { Locale } from "./i18n";
import { mapData } from "./map";

export interface UnityManifest {
  schemaVersion: 1;
  loaderUrl: string;
  dataUrl: string;
  frameworkUrl: string;
  codeUrl: string;
  companyName: string;
  productName: string;
  productVersion: string;
}

export class UnityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnityUnavailableError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

// Deliberately accept only root-relative build assets. This manifest controls a
// script tag, so external URLs, traversal, encoded separators and redirects are
// not legitimate ways to select a build.
export function validateUnityManifest(value: unknown): UnityManifest {
  if (!isRecord(value) || value.schemaVersion !== 1)
    throw new UnityUnavailableError("Unsupported Unity build manifest.");
  const asset = (key: string): string => {
    const url = value[key];
    if (
      typeof url !== "string" ||
      !/^\/unity\/[A-Za-z0-9_./-]+$/.test(url) ||
      url.endsWith("/") ||
      url
        .split("/")
        .some((part, i) => i > 0 && (!part || part === "." || part === ".."))
    )
      throw new UnityUnavailableError(`Invalid Unity asset path: ${key}.`);
    return url;
  };
  const label = (key: string): string => {
    const item = value[key];
    if (typeof item !== "string" || !item.trim() || item.length > 150)
      throw new UnityUnavailableError(`Invalid Unity build metadata: ${key}.`);
    return item;
  };
  return {
    schemaVersion: 1,
    loaderUrl: asset("loaderUrl"),
    dataUrl: asset("dataUrl"),
    frameworkUrl: asset("frameworkUrl"),
    codeUrl: asset("codeUrl"),
    companyName: label("companyName"),
    productName: label("productName"),
    productVersion: label("productVersion"),
  };
}

export async function loadUnityManifest(
  signal?: AbortSignal,
): Promise<UnityManifest> {
  const deadline = AbortSignal.timeout(10000);
  const response = await fetch("/unity/manifest.json", {
    cache: "no-store",
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (response.status === 404)
    throw new UnityUnavailableError(
      "Unity Web build is not installed locally.",
    );
  if (!response.ok)
    throw new UnityUnavailableError(
      `Unity manifest request failed (${response.status}).`,
    );
  try {
    return validateUnityManifest(await response.json());
  } catch (error) {
    if (error instanceof UnityUnavailableError) throw error;
    throw new UnityUnavailableError(
      "Unity Web build manifest is missing or invalid.",
    );
  }
}

const nodeIds = new Set(mapData.nodes.map((node) => node.nodeId));
const routeIds = new Set(mapData.routes.map((route) => route.routeId));
export const isPublicUnityNode = (value: unknown): value is string =>
  typeof value === "string" && nodeIds.has(value);

export interface UnityRenderState {
  schemaVersion: 1;
  sessionId: string;
  runEpoch: string;
  stateVersion: number;
  /** Assigned by the viewport on each packet, including clock-only updates. */
  viewSequence: number;
  locale: Locale;
  sceneId: SceneId | null;
  phase: SessionProjection["phase"];
  lifecycle: SessionProjection["lifecycle"];
  missionTimeMs: number;
  location: KnownLocation;
  selectedNodeId: string | null;
  map: {
    nodes: Array<{
      nodeId: string;
      sceneId: string | null;
      position: number[];
    }>;
    routes: Array<{ routeId: string; enabled: boolean; waypoints: number[][] }>;
  };
}

/** Explicit projection; never serialize the session, reports or AI context. */
export function buildUnityRenderState(
  session: Pick<
    SessionProjection,
    | "sessionId"
    | "runEpoch"
    | "stateVersion"
    | "sceneId"
    | "phase"
    | "lifecycle"
    | "missionTimeMs"
    | "location"
  >,
  locale: Locale,
  selectedNodeId: string | null = null,
): UnityRenderState {
  return {
    schemaVersion: 1,
    sessionId: session.sessionId,
    runEpoch: session.runEpoch,
    stateVersion: session.stateVersion,
    viewSequence: 0,
    locale,
    sceneId: session.sceneId,
    phase: session.phase,
    lifecycle: session.lifecycle,
    missionTimeMs: session.missionTimeMs,
    location: {
      nodeId: isPublicUnityNode(session.location.nodeId)
        ? session.location.nodeId
        : null,
      routeId:
        session.location.routeId && routeIds.has(session.location.routeId)
          ? session.location.routeId
          : null,
      progressPermille: Number.isFinite(session.location.progressPermille)
        ? Math.min(1000, Math.max(0, session.location.progressPermille))
        : 0,
    },
    selectedNodeId: isPublicUnityNode(selectedNodeId) ? selectedNodeId : null,
    map: {
      nodes: mapData.nodes.map((node) => ({
        nodeId: node.nodeId,
        sceneId: node.sceneId,
        position: [...node.position],
      })),
      routes: mapData.routes.map((route) => ({
        routeId: route.routeId,
        enabled: route.enabled,
        waypoints: route.waypoints.map((point) => [...point]),
      })),
    },
  };
}

/** Reapply the allowlist at the bridge boundary, even for structurally wider props. */
export function serializeUnityRenderState(
  state: UnityRenderState,
  instanceId: string,
  viewSequence: number,
): string {
  return JSON.stringify({
    ...buildUnityRenderState(state, state.locale, state.selectedNodeId),
    instanceId,
    viewSequence,
  });
}

export type UnityBridgeEvent =
  | { schemaVersion: 1; instanceId: string; type: "ready" }
  | {
      schemaVersion: 1;
      instanceId: string;
      type: "select-location";
      nodeId: string;
    }
  | { schemaVersion: 1; instanceId: string; type: "error"; message: string };

export function parseUnityBridgeEvent(
  value: unknown,
  instanceId: string,
): UnityBridgeEvent | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.instanceId !== instanceId
  )
    return null;
  if (value.type === "ready")
    return { schemaVersion: 1, instanceId, type: "ready" };
  if (value.type === "select-location" && isPublicUnityNode(value.nodeId))
    return {
      schemaVersion: 1,
      instanceId,
      type: "select-location",
      nodeId: value.nodeId,
    };
  if (value.type === "error" && typeof value.message === "string")
    return {
      schemaVersion: 1,
      instanceId,
      type: "error",
      message: value.message.slice(0, 500),
    };
  return null;
}

export function canApplyUnitySnapshot(
  previous: UnityRenderState | null,
  next: UnityRenderState,
): boolean {
  if (
    !previous ||
    previous.sessionId !== next.sessionId ||
    previous.runEpoch !== next.runEpoch
  )
    return true;
  return (
    next.stateVersion > previous.stateVersion ||
    (next.stateVersion === previous.stateVersion &&
      next.missionTimeMs >= previous.missionTimeMs)
  );
}

export interface UnityInstance {
  SendMessage(objectName: string, methodName: string, value: string): void;
  Quit(): Promise<void>;
}
type UnityFactory = (
  canvas: HTMLCanvasElement,
  config: Omit<UnityManifest, "schemaVersion" | "loaderUrl"> & {
    matchWebGLToCanvasSize: boolean;
    devicePixelRatio: number;
    showBanner(message: string, type: string): void;
  },
  onProgress: (progress: number) => void,
) => Promise<UnityInstance>;

declare global {
  interface Window {
    createUnityInstance?: UnityFactory;
  }
}

const loaders = new Map<string, Promise<UnityFactory>>();

/** Cache only the loader factory, never a canvas, engine instance or session. */
export function loadUnityFactory(
  manifest: UnityManifest,
): Promise<UnityFactory> {
  const { loaderUrl } = validateUnityManifest(manifest);
  const existing = loaders.get(loaderUrl);
  if (existing) return existing;
  const pending = new Promise<UnityFactory>((resolve, reject) => {
    const script = document.createElement("script");
    const timer = setTimeout(
      () => finish(new Error("Unity loader timed out.")),
      20000,
    );
    const finish = (error?: Error) => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      script.remove();
      if (error) reject(error);
      else if (typeof window.createUnityInstance === "function")
        resolve(window.createUnityInstance);
      else
        reject(new Error("Unity loader did not expose createUnityInstance."));
    };
    script.src = loaderUrl;
    script.async = true;
    script.onload = () => finish();
    script.onerror = () =>
      finish(new Error("Unity loader could not be loaded."));
    document.head.append(script);
  });
  loaders.set(loaderUrl, pending);
  void pending.catch(() => {
    if (loaders.get(loaderUrl) === pending) loaders.delete(loaderUrl);
  });
  return pending;
}
