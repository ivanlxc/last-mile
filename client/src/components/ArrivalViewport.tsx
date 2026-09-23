import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { loadMarketArt } from "../lib/marketArt";

/** Terminal-only reception art. No authority, timers or gameplay commands. */
export default function ArrivalViewport({ chinese }: { chinese: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "fallback">(
    "loading",
  );
  useEffect(() => {
    const element = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "low-power",
      });
    } catch {
      setStatus("fallback");
      return;
    }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#aabfc3");
    scene.fog = new THREE.Fog("#aabfc3", 35, 90);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 110);
    camera.position.set(-1, 2.3, 16);
    camera.lookAt(0, 1.9, -5);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    scene.add(new THREE.HemisphereLight("#d5e6fa", "#8b775b", 2.2));
    const sun = new THREE.DirectionalLight("#ffe2b1", 3.1);
    sun.position.set(10, 18, 8);
    sun.castShadow = true;
    Object.assign(sun.shadow.camera, {
      left: -22,
      right: 22,
      top: 24,
      bottom: -24,
      far: 80,
    });
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.normalBias = 0.025;
    scene.add(sun);
    element.append(renderer.domElement);
    renderer.domElement.setAttribute(
      "aria-label",
      chinese ? "黎明接收站三维场景" : "Daybreak reception point in 3D",
    );
    let alive = true;
    const draw = () => {
      if (alive) renderer.render(scene, camera);
    };
    const resize = new ResizeObserver(() => {
      const w = element.clientWidth,
        h = element.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      draw();
    });
    resize.observe(element);
    const art = loadMarketArt(
      renderer,
      (root) => {
        scene.add(root);
        setStatus("ready");
        draw();
      },
      () => setStatus("fallback"),
      "/assets/fields/reception-v1.glb",
    );
    const lost = (event: Event) => {
      event.preventDefault();
      setStatus("fallback");
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    return () => {
      alive = false;
      resize.disconnect();
      art.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      sun.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [chinese]);
  return (
    <div
      className="arrival-viewport"
      ref={host}
      data-testid="arrival-viewport"
      data-art-state={status}
    >
      {status !== "ready" && (
        <span role="status">
          {chinese
            ? status === "loading"
              ? "正在呈现接收站…"
              : "3D 场景暂不可用，结局与复盘仍可阅读。"
            : status === "loading"
              ? "Preparing the reception point…"
              : "3D is unavailable. Your ending and review are still available."}
        </span>
      )}
    </div>
  );
}
