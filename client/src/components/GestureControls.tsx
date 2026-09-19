import { useEffect, useRef, useState } from "react";
import { Camera, Hand, ThumbsUp, X } from "lucide-react";
import {
  CameraRuntime,
  type CameraFrame,
  type CameraRuntimeError,
} from "../lib/gestures/cameraRuntime";
import {
  GestureInterpreter,
  type GestureCameraDelta,
  type GestureControlMode,
  type GestureResult,
} from "../lib/gestures/gestureInterpreter";
import "./gestures.css";

const STOP: GestureCameraDelta = { mode: "stop", dx: 0, dy: 0, zoomLog: 0 };
const EDGES = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];
const copy = {
  en: {
    title: "Gesture controls",
    experimental: "Experimental",
    open: "Gestures · try it",
    close: "Close gesture controls",
    enable: "Enable camera",
    disable: "Turn camera off",
    starting: "Starting camera and hand model…",
    privacy:
      "Camera frames stay in this browser. No recording or upload. Camera is off by default.",
    mode: "Single-hand mode",
    panLabel: "Pan",
    orbitLabel: "Rotate",
    zoomLabel: "Zoom",
    pan: "Pinch thumb + index; move your hand to pan.",
    orbit: "Pinch thumb + index; move sideways to rotate, up/down to tilt.",
    zoom: "Pinch thumb + index; move up to zoom in, down to zoom out.",
    cycle:
      "Thumb up for 0.7s: Pan → Rotate → Zoom. Open your hand before the next thumb up or pinch.",
    switchTitle: "Switch by gesture",
    switching: "Hold thumb up to switch",
    switched: "Switched to",
    oneHand: "Show only one hand to control the map",
    release:
      "Release to stop. After losing tracking or using the mouse, open your hand before pinching again.",
    fallback: "Mouse controls always work. Esc turns the camera off.",
    sensitivity: "Sensitivity",
    camera: "Camera",
    automatic: "Default camera",
    off: "Camera off",
    idle: "Show an open hand, then pinch",
    arming: "Hold the pinch briefly…",
    moving: "Panning the map",
    rotating: "Rotating the map",
    zooming: "Zooming the map",
    rearm: "Open your hand to rearm",
    mouse: "Mouse in control · release, then pinch again",
    hands: "hands",
    ms: "ms inference",
    hz: "Hz",
    background:
      "Camera stopped while this map was hidden. Enable it again to continue.",
  },
  zh: {
    title: "手势控制",
    experimental: "实验功能",
    open: "手势 · 试用",
    close: "关闭手势控制",
    enable: "启用摄像头",
    disable: "关闭摄像头",
    starting: "正在启动摄像头与手部模型…",
    privacy: "画面仅在本浏览器处理，不录制、不上传。摄像头默认关闭。",
    mode: "单手控制模式",
    panLabel: "平移",
    orbitLabel: "旋转",
    zoomLabel: "缩放",
    pan: "拇指与食指捏合，移动手掌平移地图。",
    orbit: "拇指与食指捏合，左右移动旋转，上下移动调整俯仰。",
    zoom: "拇指与食指捏合，向上移动放大，向下移动缩小。",
    cycle:
      "单手点赞保持 0.7 秒：平移 → 旋转 → 缩放。先张手，再次点赞或捏合操作。",
    switchTitle: "点赞切换模式",
    switching: "保持点赞切换模式",
    switched: "已切换到",
    oneHand: "请只用一只手控制地图",
    release: "松开即停止。丢失跟踪或使用鼠标后，请先张手再捏合。",
    fallback: "鼠标随时可用。按 Esc 关闭摄像头。",
    sensitivity: "灵敏度",
    camera: "摄像头",
    automatic: "默认摄像头",
    off: "摄像头已关闭",
    idle: "先展示张开的手，再捏合",
    arming: "保持捏合片刻…",
    moving: "正在平移地图",
    rotating: "正在旋转地图",
    zooming: "正在缩放地图",
    rearm: "请先张手，再重新捏合",
    mouse: "鼠标接管中 · 松开后重新捏合",
    hands: "只手",
    ms: "毫秒推理",
    hz: "帧/秒",
    background: "地图隐藏后已关闭摄像头，请重新启用。",
  },
};

function errorText(error: CameraRuntimeError, zh: boolean) {
  const messages: Record<string, [string, string]> = {
    unsupported: [
      "This browser cannot run camera gestures. Try a current Chrome browser on localhost or HTTPS.",
      "此浏览器不支持手势。请使用新版 Chrome，并通过 localhost 或 HTTPS 打开。",
    ],
    permission: [
      "Camera permission was not granted. Allow camera access in your browser, then retry.",
      "未获得摄像头权限。请在浏览器中允许访问后重试。",
    ],
    device: [
      "The camera is unavailable or in use. Check the device or select another camera.",
      "摄像头不可用或被占用，请检查设备或选择其他摄像头。",
    ],
    model: [
      "The hand model could not load. Check the local gesture assets and retry.",
      "手部模型加载失败，请检查本地手势资源后重试。",
    ],
    timeout: [
      "Camera or model response timed out. The camera has been stopped; retry when ready.",
      "摄像头或模型响应超时，已停止摄像头，请重试。",
    ],
    capture: [
      "Camera capture stopped. Check the camera and retry.",
      "摄像头画面采集已中断，请检查设备后重试。",
    ],
    worker: [
      "Hand recognition stopped. Turn the camera on again to retry.",
      "手部识别已停止，请重新启用摄像头。",
    ],
  };
  return (messages[error.code] ?? messages.worker)[zh ? 1 : 0];
}

/** Opt-in and scoped to the currently mounted Unity viewport; never persisted on. */
export default function GestureControls({
  chinese,
  onInput,
  suspended = false,
}: {
  chinese: boolean;
  suspended?: boolean;
  onInput(input: GestureCameraDelta): void;
}) {
  const t = copy[chinese ? "zh" : "en"];
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "starting" | "running">("idle");
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState("");
  const [sensitivity, setSensitivity] = useState(1);
  const [mode, setMode] = useState<GestureControlMode>("pan");
  const [stats, setStats] = useState({
    hands: 0,
    inference: 0,
    hz: 0,
    gesture: "idle" as GestureResult["status"],
    mouse: false,
    switchProgress: 0,
  });
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const skeleton = useRef<HTMLCanvasElement>(null);
  const runtime = useRef<CameraRuntime | null>(null);
  const interpreter = useRef(new GestureInterpreter());
  const latest = useRef({ chinese, onInput, sensitivity, state, suspended });
  latest.current = { chinese, onInput, sensitivity, state, suspended };
  const pointerHeld = useRef(false);
  const manualUntil = useRef(0);

  useEffect(() => {
    if (!video.current) return;
    let live = true;
    let lastUi = 0;
    let frames = 0;
    let rateStart = performance.now();
    let hz = 0;
    let lastFrameAt = 0;
    let stale = false;
    const reset = () => {
      interpreter.current.reset(true);
      latest.current.onInput(STOP);
    };
    const draw = (frame: CameraFrame, active: boolean) => {
      const canvas = skeleton.current;
      if (!canvas) return;
      const width = 320;
      const height = Math.round(width / frame.aspect);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = active ? "#ffd582" : "#9cecc3";
      ctx.fillStyle = ctx.strokeStyle;
      for (const hand of frame.hands) {
        for (const [a, b] of EDGES) {
          const p = hand.landmarks[a],
            q = hand.landmarks[b];
          if (!p || !q) continue;
          ctx.beginPath();
          ctx.moveTo((1 - p.x) * width, p.y * height);
          ctx.lineTo((1 - q.x) * width, q.y * height);
          ctx.stroke();
        }
        for (const p of hand.landmarks) {
          ctx.beginPath();
          ctx.arc((1 - p.x) * width, p.y * height, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    const camera = new CameraRuntime(video.current, {
      onState(next) {
        if (!live) return;
        setState(next);
        if (next !== "running") {
          reset();
          setStats({
            hands: 0,
            inference: 0,
            hz: 0,
            gesture: "idle",
            mouse: false,
            switchProgress: 0,
          });
          const canvas = skeleton.current;
          canvas
            ?.getContext("2d")
            ?.clearRect(0, 0, canvas.width, canvas.height);
        } else {
          frames = 0;
          rateStart = performance.now();
          void navigator.mediaDevices
            .enumerateDevices()
            .then((list) => {
              if (live)
                setDevices(list.filter((item) => item.kind === "videoinput"));
            })
            .catch(() => {});
        }
      },
      onError(reason) {
        if (live) setError(errorText(reason, latest.current.chinese));
      },
      onFrame(frame) {
        if (!live) return;
        if (document.hidden || !root.current?.getClientRects().length) {
          camera.stop();
          setError(copy[latest.current.chinese ? "zh" : "en"].background);
          return;
        }
        const now = performance.now();
        lastFrameAt = now;
        stale = false;
        const mouse =
          latest.current.suspended ||
          pointerHeld.current ||
          now < manualUntil.current;
        if (mouse) reset();
        const result = mouse
          ? {
              input: STOP,
              status: "release" as const,
              handCount: frame.hands.length,
              controlMode: interpreter.current.getMode(),
              modeSwitchProgress: 0,
            }
          : interpreter.current.update(
              frame.hands,
              frame.timestampMs,
              frame.aspect,
            );
        const gain = latest.current.sensitivity;
        const input = result.input;
        latest.current.onInput({
          mode: input.mode,
          dx: Math.max(-0.15, Math.min(0.15, input.dx * gain)),
          dy: Math.max(-0.15, Math.min(0.15, input.dy * gain)),
          zoomLog: Math.max(-0.35, Math.min(0.35, input.zoomLog * gain)),
        });
        setMode(result.controlMode);
        draw(
          frame,
          result.status === "pan" ||
            result.status === "orbit" ||
            result.status === "zoom",
        );
        frames++;
        if (now - rateStart >= 1000) {
          hz = (frames * 1000) / (now - rateStart);
          frames = 0;
          rateStart = now;
        }
        if (now - lastUi >= 120) {
          lastUi = now;
          setStats({
            hands: result.handCount,
            inference: Math.round(frame.inferenceMs),
            hz: Math.round(hz),
            gesture: result.status,
            mouse,
            switchProgress: result.modeSwitchProgress,
          });
        }
      },
    });
    runtime.current = camera;
    const freshness = setInterval(() => {
      if (
        latest.current.state !== "running" ||
        stale ||
        performance.now() - lastFrameAt < 350
      )
        return;
      stale = true;
      reset();
      const canvas = skeleton.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      setStats({
        hands: 0,
        inference: 0,
        hz: 0,
        gesture: "release",
        mouse: false,
        switchProgress: 0,
      });
    }, 150);
    const manual = () => {
      manualUntil.current = performance.now() + 650;
      reset();
    };
    const down = () => {
      pointerHeld.current = true;
      manual();
    };
    const up = () => {
      pointerHeld.current = false;
      manual();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        camera.stop();
        reset();
      } else manual();
    };
    const hidden = () => {
      if (document.hidden) {
        camera.stop();
        reset();
      }
    };
    const blur = () => {
      pointerHeld.current = false;
      manual();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("wheel", manual, { passive: true, capture: true });
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      live = false;
      clearInterval(freshness);
      camera.dispose();
      runtime.current = null;
      reset();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("wheel", manual, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);

  useEffect(() => {
    if (suspended) {
      interpreter.current.reset(true);
      onInput(STOP);
    }
  }, [suspended, onInput]);
  const start = () => {
    setError("");
    interpreter.current.reset(true);
    // Runtime reports actionable errors through onError; cancellation is normal.
    void runtime.current?.start(device || undefined).catch(() => {});
  };
  const close = () => {
    runtime.current?.stop();
    setOpen(false);
  };
  const nextMode = { pan: t.orbitLabel, orbit: t.zoomLabel, zoom: t.panLabel }[
    mode
  ];
  const modeLabel = { pan: t.panLabel, orbit: t.orbitLabel, zoom: t.zoomLabel }[
    mode
  ];
  const status =
    stats.hands > 1
      ? t.oneHand
      : stats.mouse
        ? t.mouse
        : {
            idle: t.idle,
            arming: t.arming,
            pan: t.moving,
            orbit: t.rotating,
            zoom: t.zooming,
            switching: `${t.switching} → ${nextMode} · ${Math.round(stats.switchProgress * 100)}%`,
            release:
              stats.switchProgress === 1
                ? `${t.switched}${chinese ? "" : " "}${modeLabel} · ${t.rearm}`
                : t.rearm,
          }[stats.gesture];
  return (
    <div
      className="gesture-controls"
      ref={root}
      data-gesture-state={state}
      data-control-mode={mode}
    >
      <button
        type="button"
        className={`gesture-toggle ${state === "running" ? "is-on" : ""}`}
        aria-expanded={open}
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            // Give the preview and hand instructions room in the existing map UI.
            root.current?.dispatchEvent(
              new Event("last-mile-gesture-open", { bubbles: true }),
            );
          }
        }}
      >
        <Hand size={15} />
        {t.open}
        {state === "running" && <span className="gesture-live-dot" />}
      </button>
      <section className="gesture-panel" hidden={!open} aria-label={t.title}>
        <div className="gesture-title">
          <strong>{t.title}</strong>
          <span>{t.experimental}</span>
          <button type="button" aria-label={t.close} onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div className="gesture-modes" role="group" aria-label={t.mode}>
          {(["pan", "orbit", "zoom"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={mode === value}
              onClick={() => {
                interpreter.current.setMode(value);
                onInput(STOP);
                setMode(value);
                setStats((old) => ({
                  ...old,
                  gesture: "release",
                  switchProgress: 0,
                }));
              }}
            >
              {
                { pan: t.panLabel, orbit: t.orbitLabel, zoom: t.zoomLabel }[
                  value
                ]
              }
            </button>
          ))}
        </div>
        <div className="gesture-switch-cue">
          <div>
            <ThumbsUp size={18} aria-hidden="true" />
            <strong>
              {t.switchTitle} → {nextMode}
            </strong>
          </div>
          <p>{t.cycle}</p>
          <progress
            max={1}
            value={stats.gesture === "switching" ? stats.switchProgress : 0}
            aria-label={t.switching}
          />
        </div>
        <div className="gesture-preview" hidden={state === "idle"}>
          <video
            ref={video}
            autoPlay
            playsInline
            muted
            aria-label={chinese ? "本地摄像头预览" : "Local camera preview"}
          />
          <canvas ref={skeleton} aria-hidden="true" />
        </div>
        <p
          className="gesture-status"
          role="status"
          data-gesture-mode={stats.gesture}
        >
          {state === "starting"
            ? t.starting
            : state === "running"
              ? status
              : t.off}
        </p>
        {state === "running" && (
          <p className="gesture-metrics">
            {stats.hands} {t.hands} · {stats.hz} {t.hz} · {stats.inference}{" "}
            {t.ms}
          </p>
        )}
        <p className="gesture-instruction">
          {{ pan: t.pan, orbit: t.orbit, zoom: t.zoom }[mode]}
        </p>
        <p className="gesture-hint">
          {t.release} {t.fallback}
        </p>
        {devices.length > 1 && (
          <label className="gesture-field">
            {t.camera}
            <select
              value={device}
              disabled={state !== "idle"}
              onChange={(event) => setDevice(event.target.value)}
            >
              <option value="">{t.automatic}</option>
              {devices.map((item, index) => (
                <option key={item.deviceId} value={item.deviceId}>
                  {item.label || `${t.camera} ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="gesture-field">
          {t.sensitivity}
          <span>{sensitivity.toFixed(1)}×</span>
          <input
            aria-label={t.sensitivity}
            type="range"
            min="0.5"
            max="1.8"
            step="0.1"
            value={sensitivity}
            onChange={(event) => setSensitivity(Number(event.target.value))}
          />
        </label>
        {error && (
          <p className="gesture-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="gesture-enable"
          onClick={state === "idle" ? start : () => runtime.current?.stop()}
        >
          <Camera size={15} />
          {state === "idle" ? t.enable : t.disable}
        </button>
        <p className="gesture-privacy">{t.privacy}</p>
      </section>
    </div>
  );
}
