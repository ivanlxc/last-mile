import { useCallback, useEffect, useRef, useState } from "react";
import GestureControls from "./GestureControls";
import type { GestureCameraDelta } from "../lib/gestures/gestureInterpreter";
import {
  canApplyUnitySnapshot,
  loadUnityFactory,
  loadUnityManifest,
  parseUnityBridgeEvent,
  serializeUnityRenderState,
  type UnityInstance,
  type UnityRenderState,
} from "../lib/unity";
import "./unity.css";

export interface UnityViewportProps {
  state: UnityRenderState;
  onReady?: () => void;
  onFailure: (message: string) => void;
  onSelectLocation?: (nodeId: string) => void;
}

export default function UnityViewport(props: UnityViewportProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const flush = useRef<(() => void) | null>(null);
  const cameraInput = useRef<((input: GestureCameraDelta) => void) | null>(
    null,
  );
  const sendCameraInput = useCallback(
    (input: GestureCameraDelta) => cameraInput.current?.(input),
    [],
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let disposed = false;
    let configured = false;
    let ready = false;
    let engine: UnityInstance | undefined;
    let lastState: UnityRenderState | null = null;
    let lastPayload = "";
    let sequence = 0;
    let cameraSequence = 0;
    let cameraMoving = false;
    const instanceId = crypto.randomUUID();
    const controller = new AbortController();
    // A canvas per effect prevents a late StrictMode engine from sharing the
    // replacement effect's canvas while its asynchronous Quit is completing.
    const canvas = document.createElement("canvas");
    // Unity's Web runtime resolves its canvas through a CSS #id selector.
    // Keep it unique across StrictMode retries and simultaneously retiring engines.
    canvas.id = `last-mile-unity-${instanceId}`;
    canvas.className = "unity-canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "LAST MILE Unity tactical map");
    container.append(canvas);
    setStatus("loading");
    setProgress(0);
    setError("");

    const quit = (instance: UnityInstance) => {
      try {
        void Promise.resolve(instance.Quit()).catch(() => {});
      } catch {
        /* Already disposed. */
      }
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      clearTimeout(deadline);
      window.removeEventListener("last-mile-unity", receive);
      observer?.disconnect();
      canvas.remove();
      if (flush.current === sendState) flush.current = null;
      if (cameraInput.current === sendCamera) cameraInput.current = null;
      if (engine) {
        quit(engine);
        engine = undefined;
      }
    };
    const fail = (reason: unknown) => {
      if (disposed) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      dispose();
      setError(message);
      setStatus("error");
      latest.current.onFailure(message);
    };
    const sendState = () => {
      const state = latest.current.state;
      if (
        disposed ||
        !ready ||
        !engine ||
        !canApplyUnitySnapshot(lastState, state)
      )
        return;
      const payload = serializeUnityRenderState(state, instanceId, 0);
      if (payload === lastPayload) return;
      try {
        engine.SendMessage(
          "LastMileBridge",
          "ApplyRenderState",
          serializeUnityRenderState(state, instanceId, ++sequence),
        );
        lastState = state;
        lastPayload = payload;
      } catch (reason) {
        fail(reason);
      }
    };
    const sendCamera = (input: GestureCameraDelta) => {
      if (disposed || !ready || !engine) return;
      if (![input.dx, input.dy, input.zoomLog].every(Number.isFinite)) return;
      if (input.mode === "stop" && !cameraMoving) return;
      if (
        input.mode !== "stop" &&
        input.dx === 0 &&
        input.dy === 0 &&
        input.zoomLog === 0
      )
        return;
      cameraMoving = input.mode !== "stop";
      // Separate channel: camera input never enters the authoritative projection.
      engine.SendMessage(
        "LastMileBridge",
        "ApplyCameraInput",
        JSON.stringify({
          schemaVersion: 1,
          instanceId,
          sequence: ++cameraSequence,
          ...input,
        }),
      );
    };
    const receive = (event: Event) => {
      const message = parseUnityBridgeEvent(
        (event as CustomEvent<unknown>).detail,
        instanceId,
      );
      if (!message || disposed || !configured) return;
      if (message.type === "ready" && !ready) {
        ready = true;
        clearTimeout(deadline);
        sendState();
        if (disposed) return;
        setProgress(1);
        setStatus("ready");
        latest.current.onReady?.();
      } else if (message.type === "select-location" && ready) {
        latest.current.onSelectLocation?.(message.nodeId);
      } else if (message.type === "error") {
        fail(new Error(message.message || "Unity reported an error."));
      }
    };
    const resize = () => {
      if (disposed) return;
      const bounds = container.getBoundingClientRect();
      // Unity owns the render buffer size; only CSS dimensions follow the slot.
      canvas.style.width = `${Math.max(1, bounds.width)}px`;
      canvas.style.height = `${Math.max(1, bounds.height)}px`;
    };
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(container);
    resize();
    const deadline = setTimeout(
      () =>
        fail(
          new Error(
            "Unity initialization timed out. Select Unity again to retry.",
          ),
        ),
      90000,
    );
    window.addEventListener("last-mile-unity", receive);
    flush.current = sendState;
    cameraInput.current = sendCamera;

    void (async () => {
      const manifest = await loadUnityManifest(controller.signal);
      if (disposed) return;
      const createUnityInstance = await loadUnityFactory(manifest);
      if (disposed) return;
      const {
        schemaVersion: _schema,
        loaderUrl: _loader,
        ...config
      } = manifest;
      const created = await createUnityInstance(
        canvas,
        {
          ...config,
          matchWebGLToCanvasSize: true,
          devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
          showBanner: (message, kind) => {
            if (kind === "error") fail(new Error(message));
          },
        },
        (value) => {
          if (!disposed) setProgress(Math.max(0, Math.min(1, value)));
        },
      );
      if (disposed) {
        quit(created);
        return;
      }
      engine = created;
      // Configure may synchronously dispatch ready, so set the guard first.
      configured = true;
      engine.SendMessage("LastMileBridge", "Configure", instanceId);
    })().catch(fail);
    return dispose;
  }, []);

  useEffect(() => {
    flush.current?.();
  }, [props.state]);

  const chinese = props.state.locale === "zh-CN";
  return (
    <div className="unity-viewport" data-unity-status={status}>
      <div className="unity-canvas-host" ref={host} />
      {status === "ready" && (
        <GestureControls chinese={chinese} onInput={sendCameraInput} />
      )}
      {status !== "ready" && (
        <div className="unity-loading" role="status" aria-live="polite">
          {status === "loading" ? (
            <>
              <span className="spinner" />
              <span>
                {chinese ? "正在加载 Unity 场景" : "Loading Unity scene"} ·{" "}
                {Math.round(progress * 100)}%
              </span>
              <progress
                value={progress}
                max={1}
                aria-label={
                  chinese ? "Unity 加载进度" : "Unity loading progress"
                }
              />
            </>
          ) : (
            <span>{error}</span>
          )}
        </div>
      )}
    </div>
  );
}
