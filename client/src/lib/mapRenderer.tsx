import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { P } from "./api";
import { useI18n } from "./i18n";
import { mapData } from "./map";
import { buildUnityRenderState, loadUnityManifest } from "./unity";
import UnityViewport from "../components/UnityViewport";
import "../components/map-renderer.css";

export type MapRenderer = "three" | "two" | "unity";
const STORAGE_KEY = "last-mile-map-renderer-v1";
function preferredRenderer(): MapRenderer {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "two" || value === "unity") return value;
  } catch {
    /* Browser storage is optional. */
  }
  return "three";
}

interface MapRendererContextValue {
  mode: MapRenderer;
  selectMode(mode: MapRenderer): void;
  availability: "checking" | "available" | "unavailable";
  checking: boolean;
  ready: boolean;
  missionStarted: boolean;
  canStart: boolean;
  runtimeError: string | null;
  selectedNodeId: string | null;
  inputBlocked: boolean;
  setInputBlocked(blocked: boolean): void;
  selectNode(id: string | null): void;
  recheck(): void;
  attach(slot: HTMLElement): () => void;
}
const MapRendererContext = createContext<MapRendererContextValue | null>(null);

/** The portal target is stable across Briefing -> GameView. Moving its host
 * element preserves the actual Unity instance that passed the readiness gate. */
export function MapRendererProvider({
  state,
  children,
}: {
  state: P.SessionProjection | null;
  children: ReactNode;
}) {
  const { locale } = useI18n();
  const [mode, setMode] = useState<MapRenderer>(preferredRenderer);
  const [availability, setAvailability] =
    useState<MapRendererContextValue["availability"]>("checking");
  const [probe, setProbe] = useState(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [mountedKey, setMountedKey] = useState<string | null>(null);
  const [inputBlocked, setInputBlocked] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  useEffect(() => {
    const update = () => setModalOpen(!!document.querySelector("dialog[open]"));
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    update();
    return () => observer.disconnect();
  }, []);
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "unity-persistent-host";
    return element;
  });
  const parking = useRef<HTMLDivElement>(null);
  const runtimeKey = `${state?.sessionId ?? "none"}:${probe}`;
  useEffect(() => {
    if (mode === "unity") setMountedKey(runtimeKey);
  }, [mode, runtimeKey]);
  const selectMode = useCallback((next: MapRenderer) => {
    setMode(next);
    setRuntimeError(null);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* Optional. */
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let alive = true;
    setAvailability("checking");
    void loadUnityManifest(controller.signal)
      .then(() => {
        if (alive) setAvailability("available");
      })
      .catch(() => {
        if (!alive) return;
        setAvailability("unavailable");
        setMode((old) => (old === "unity" ? "three" : old));
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      alive = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [probe]);
  useEffect(() => setSelectedNodeId(null), [state?.sessionId, state?.sceneId]);
  const selectNode = useCallback((id: string | null) => {
    if (id === null || mapData.nodes.some((node) => node.nodeId === id))
      setSelectedNodeId(id);
  }, []);
  const attach = useCallback(
    (slot: HTMLElement) => {
      slot.appendChild(host);
      return () => {
        // An old map slot must not detach the host after a newer slot attached it.
        if (host.parentNode === slot) parking.current?.appendChild(host);
      };
    },
    [host],
  );
  useEffect(() => () => host.remove(), [host]);
  const renderState = useMemo(
    () =>
      state
        ? buildUnityRenderState(state, locale, selectedNodeId ?? undefined)
        : null,
    [state, locale, selectedNodeId],
  );
  const ready =
    mode === "unity" && availability === "available" && readyKey === runtimeKey;
  const active =
    (mode === "unity" || mountedKey === runtimeKey) &&
    availability === "available" &&
    state?.lifecycle !== "sealed" &&
    renderState;
  const value: MapRendererContextValue = {
    mode,
    selectMode,
    availability,
    checking: availability === "checking",
    ready,
    missionStarted: state?.lifecycle === "active",
    canStart: mode !== "unity" || ready,
    runtimeError,
    selectedNodeId,
    inputBlocked: modalOpen,
    setInputBlocked,
    selectNode,
    recheck: () => {
      setRuntimeError(null);
      setReadyKey(null);
      setProbe((n) => n + 1);
    },
    attach,
  };
  return (
    <MapRendererContext.Provider value={value}>
      {children}
      <div ref={parking} hidden aria-hidden="true" />
      {active &&
        createPortal(
          <UnityViewport
            key={runtimeKey}
            state={renderState}
            active={mode === "unity"}
            inputBlocked={modalOpen}
            gesturesSuspended={inputBlocked || modalOpen}
            onReady={() => setReadyKey(runtimeKey)}
            onFailure={(message) => {
              setRuntimeError(message);
              setReadyKey(null);
              setMountedKey(null);
              setMode("three");
            }}
            onSelectLocation={selectNode}
          />,
          host,
        )}
    </MapRendererContext.Provider>
  );
}

export function useMapRenderer() {
  const value = useContext(MapRendererContext);
  if (!value) throw new Error("MapRendererProvider is required");
  return value;
}

export function UnityMapSlot() {
  const { attach } = useMapRenderer();
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () => (slot.current ? attach(slot.current) : undefined),
    [attach],
  );
  return <div className="unity-map-slot" ref={slot} />;
}
