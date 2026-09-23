import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { SceneId } from "../../../docs/engineering_v0.5/contracts/public.types";
import { fieldCopy, fieldLayout } from "../lib/campaignField";
import { loadMarketArt } from "../lib/marketArt";
import {
  FIELD_BUILDINGS,
  moveInField,
  nearbyStation,
  type StationId,
  type FieldPose,
} from "../lib/marketField";

type Props = {
  sceneId?: SceneId;
  chinese: boolean;
  blocked: boolean;
  onInteract: (station: StationId) => void;
};

/** A neutral staging area: it receives no session, reports, AI output or case. */
export default function MarketViewport({
  sceneId = "E2",
  chinese,
  blocked,
  onInteract,
}: Props) {
  const copy = fieldCopy(sceneId, chinese);
  const layout = fieldLayout(sceneId);
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ blocked, onInteract });
  latest.current = { blocked, onInteract };
  const pose = useRef<FieldPose>({ ...layout.spawn });
  const control = useRef(new Set<string>());
  const [nearby, setNearby] = useState<StationId | null>(null);
  const [locked, setLocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const [artState, setArtState] = useState<"loading" | "ready" | "fallback">(
    "loading",
  );
  useEffect(() => {
    if (blocked) {
      control.current.clear();
      if (
        document.pointerLockElement &&
        host.current?.contains(document.pointerLockElement)
      )
        document.exitPointerLock();
    }
  }, [blocked]);
  useEffect(() => {
    const element = host.current!;
    pose.current = { ...layout.spawn };
    setFailed(false);
    setArtState("loading");
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#bfced0");
    scene.fog = new THREE.Fog("#bfced0", 28, 72);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "low-power",
      });
    } catch {
      setFailed(true);
      return;
    }
    const camera = new THREE.PerspectiveCamera(66, 1, 0.1, 90);
    camera.rotation.order = "YXZ";
    camera.position.set(layout.spawn.x, 1.68, layout.spawn.z);
    camera.rotation.set(layout.spawn.pitch, layout.spawn.yaw, 0, "YXZ");
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", copy.title);
    canvas.setAttribute("data-testid", "market-canvas");
    element.append(canvas);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    const palette = new Map<string, THREE.MeshStandardMaterial>();
    const sampleFallback = new THREE.Group();
    scene.add(sampleFallback);
    let placementRoot: THREE.Object3D = scene;
    const stationLabels: THREE.Sprite[] = [];
    function material(color: string) {
      if (!palette.has(color)) {
        const m = new THREE.MeshStandardMaterial({ color, roughness: 0.88 });
        palette.set(color, m);
        materials.add(m);
      }
      return palette.get(color)!;
    }
    function box(
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      color: string,
      parent: THREE.Object3D = placementRoot,
    ) {
      const geometry = new THREE.BoxGeometry(w, h, d);
      geometries.add(geometry);
      const mesh = new THREE.Mesh(geometry, material(color));
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    }
    function cylinder(
      x: number,
      y: number,
      z: number,
      radius: number,
      height: number,
      color: string,
      parent: THREE.Object3D = placementRoot,
    ) {
      const geometry = new THREE.CylinderGeometry(radius, radius, height, 10);
      geometries.add(geometry);
      const mesh = new THREE.Mesh(geometry, material(color));
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    }
    function sign(
      text: string,
      x: number,
      y: number,
      z: number,
      width: number,
    ) {
      const image = document.createElement("canvas");
      image.width = 768;
      image.height = 128;
      const ctx = image.getContext("2d")!;
      ctx.fillStyle = "#172d32";
      ctx.fillRect(0, 0, 768, 128);
      ctx.fillStyle = "#6fdacb";
      ctx.fillRect(0, 0, 8, 128);
      ctx.font = "500 34px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#f0e8d5";
      ctx.fillText(text, 384, 64, 720);
      const texture = new THREE.CanvasTexture(image);
      texture.colorSpace = THREE.SRGBColorSpace;
      textures.add(texture);
      const m = new THREE.SpriteMaterial({
        map: texture,
        depthTest: true,
        toneMapped: false,
      });
      materials.add(m);
      const sprite = new THREE.Sprite(m);
      sprite.position.set(x, y, z);
      sprite.scale.set(width, width / 6, 1);
      scene.add(sprite);
      stationLabels.push(sprite);
    }
    // Stylized crew silhouettes, not enemy indicators or authoritative NPC dialogue.
    function crew(x: number, z: number, coat: string) {
      cylinder(x, 0.98, z, 0.22, 0.65, coat);
      box(x - 0.12, 0.35, z, 0.17, 0.7, 0.21, "#333f40");
      box(x + 0.12, 0.35, z, 0.17, 0.7, 0.21, "#333f40");
      cylinder(x, 1.5, z, 0.15, 0.32, "#997355");
      cylinder(x, 1.68, z, 0.18, 0.07, "#536869");
      box(x, 1.06, z + 0.23, 0.34, 0.4, 0.05, "#d6b871");
    }
    scene.add(new THREE.HemisphereLight("#e0efff", "#877257", 2.2));
    const sun = new THREE.DirectionalLight("#ffe4bd", 3.1);
    sun.position.set(12, 18, 2);
    sun.castShadow = true;
    Object.assign(sun.shadow.camera, {
      left: -24,
      right: 24,
      top: 28,
      bottom: -28,
      near: 0.5,
      far: 70,
    });
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.normalBias = 0.025;
    sun.shadow.bias = -0.00015;
    scene.add(sun);
    if (sceneId === "E2") {
      placementRoot = sampleFallback;
      box(0, -0.24, 0, 100, 0.4, 100, "#a9977d");
      box(0, -0.02, 0, 12, 0.14, 33, "#c7b596");
      for (let z = -15; z < 16; z += 2.4) {
        box(-5.8, 0.08, z, 0.3, 0.2, 2.25, "#e6cfab");
        box(5.8, 0.08, z, 0.3, 0.2, 2.25, "#e6cfab");
      }
      // Closed courtyards deliberately keep the route, incident and rumor sources off screen.
      for (const [index, b] of FIELD_BUILDINGS.entries()) {
        placementRoot = index === 2 ? sampleFallback : scene;
        box(b.x, b.height / 2, b.z, b.width, b.height, b.depth, b.color);
        box(
          b.x,
          b.height + 0.13,
          b.z,
          b.width + 0.3,
          0.26,
          b.depth + 0.3,
          "#e3c59a",
        );
        box(b.x, 0.25, b.z, b.width + 0.15, 0.5, b.depth + 0.15, "#887965");
        if (index < 5) {
          const inner =
            b.x < 0 ? b.x + b.width / 2 + 0.03 : b.x - b.width / 2 - 0.03;
          for (let z = b.z - b.depth / 2 + 1; z < b.z + b.depth / 2; z += 2.2) {
            box(inner, 1.2, z, 0.1, 2.1, 1.15, "#466569");
            box(inner, 3.7, z, 0.14, 1.2, 0.85, "#35494a");
            box(inner, 3.05, z, 0.35, 0.14, 1, "#d8bd95");
            if (b.height > 6) box(inner, 5.6, z, 0.12, 1, 0.85, "#435d5e");
          }
          cylinder(b.x, b.height + 0.6, b.z, 0.8, 1, "#626f68");
        }
      }
      placementRoot = scene;
      for (const z of [-15.5, 15.5]) {
        box(0, 0.5, z, 20, 1, 0.45, "#b69b75");
        for (let x = -8; x <= 8; x += 2.6)
          box(x, 0.65, z, 0.7, 0.2, 0.5, "#d6c2a0");
      }
      for (const x of [-10.5, 10.5]) box(x, 0.55, 0, 0.4, 1.1, 30, "#ae9476");
      // Awnings and stalls, deliberately free of evidence-bearing text or props.
      for (const [x, z, color] of [
        [-4.5, 5, "#476f72"],
        [4.5, -2, "#ad7752"],
        [-4.5, -9, "#506664"],
      ] as const) {
        placementRoot = z === 5 ? sampleFallback : scene;
        box(x, 0.75, z, 1.7, 0.18, 2.5, "#6b6250");
        for (const dx of [-0.75, 0.75])
          for (const dz of [-1.1, 1.1])
            cylinder(x + dx, 1.4, z + dz, 0.035, 2.8, "#465250");
        const awning = box(x, 2.8, z, 2.6, 0.09, 3, color);
        awning.rotation.z = x < 0 ? -0.12 : 0.12;
        for (const dz of [-0.65, 0.65])
          box(x, 0.32, z + dz, 1.2, 0.6, 0.85, "#967759");
      }
      placementRoot = scene;
      box(-4.5, 0.99, -9, 0.8, 0.3, 0.6, "#253d42");
      box(-4.2, 1.2, -9, 0.1, 0.55, 0.75, "#92b9ae");
      cylinder(-4.6, 1.6, -9.5, 0.015, 1.5, "#2c4046");
      crew(-3.2, 5, "#4d7777");
      crew(3.2, -2, "#8c7862");
      const van = new THREE.Group();
      scene.add(van);
      van.position.set(6.1, 0, 10);
      box(0, 0.95, 0, 2.4, 1.4, 4.9, "#d5d5ba", van);
      box(0, 1.95, -0.4, 2.3, 1.1, 3.6, "#e2deca", van);
      box(0, 2.03, -2.22, 1.9, 0.62, 0.05, "#344d57", van);
      for (const x of [-1.21, 1.21]) {
        box(x, 1.94, -1.25, 0.04, 0.67, 1.35, "#344d57", van);
        box(x, 1.3, 0.45, 0.05, 0.25, 2.5, "#54797b", van);
        for (const z of [-1.6, 1.6]) {
          const wheel = cylinder(x, 0.48, z, 0.45, 0.25, "#303a3b", van);
          wheel.rotation.z = Math.PI / 2;
        }
      }
      box(0, 0.55, -2.52, 2.5, 0.25, 0.15, "#526263", van);
      for (const x of [-0.8, 0.8])
        box(x, 1.1, -2.48, 0.4, 0.25, 0.05, "#f3dfb0", van);
    } else {
      placementRoot = sampleFallback;
      box(0, -0.12, 0, 30, 0.2, 35, "#a3947b");
      for (const station of layout.stations) {
        if (station.id === "noah" || station.id === "samira") continue;
        box(station.x, 0.8, station.z, 1.4, 0.1, 2, "#5f685c");
      }
      placementRoot = scene;
      for (const station of layout.stations)
        if (station.id === "noah" || station.id === "samira")
          crew(
            station.x,
            station.z,
            station.id === "noah" ? "#4d7777" : "#8c7862",
          );
    }
    for (const station of layout.stations)
      sign(copy[station.id], station.x, 2.25, station.z, 2.2);
    // Decorative distant skyline and cable, no raycast or hidden-state input.
    if (sceneId === "E2")
      for (let i = 0; i < 13; i++)
        box(
          -35 + i * 6,
          3 + (i % 3),
          -35 - (i % 2) * 4,
          5,
          6 + (i % 3) * 2,
          8,
          "#9da49a",
        );
    if (sceneId === "E2") {
      const lineGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-7, 6.5, -4),
        new THREE.Vector3(0, 5.4, -4),
        new THREE.Vector3(7, 6.5, -4),
      ]);
      geometries.add(lineGeometry);
      const lineMaterial = new THREE.LineBasicMaterial({ color: "#526363" });
      materials.add(lineMaterial);
      scene.add(new THREE.Line(lineGeometry, lineMaterial));
    }
    let frame = 0,
      previous = performance.now(),
      dragging = false,
      disposed = false;
    // Authored art replaces only this sample's placeholder meshes. Interaction
    // points/collision remain public data and do not come from the GLB.
    const art = loadMarketArt(
      renderer,
      (root) => {
        scene.add(root);
        sampleFallback.visible = false;
        canvas.dataset.artState = "ready";
        setArtState("ready");
      },
      () => {
        canvas.dataset.artState = "fallback";
        setArtState("fallback");
      },
      sceneId === "E2"
        ? undefined
        : `/assets/fields/${sceneId === "E1" ? "gate" : "bridge"}-v1.glb`,
    );
    canvas.dataset.artState = "loading";
    let previousNearby: StationId | null = null;
    const pause = () => {
      control.current.clear();
      dragging = false;
    };
    const lockChange = () => {
      pause();
      setLocked(document.pointerLockElement === canvas);
    };
    const lockError = () => {
      setLocked(false);
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      pause();
      setFailed(true);
    };
    const move = (event: MouseEvent) => {
      if (latest.current.blocked || document.hidden) return;
      if (document.pointerLockElement !== canvas && !dragging) return;
      pose.current.yaw -= event.movementX * 0.0024;
      pose.current.pitch = THREE.MathUtils.clamp(
        pose.current.pitch - event.movementY * 0.0024,
        -0.85,
        0.85,
      );
    };
    const down = (event: PointerEvent) => {
      if (latest.current.blocked || event.button !== 0) return;
      canvas.focus();
      dragging = true;
      if (
        event.pointerType === "mouse" &&
        !document.pointerLockElement &&
        canvas.requestPointerLock
      ) {
        const result = canvas.requestPointerLock();
        if (result && typeof result.catch === "function")
          void result.catch(lockError);
      }
    };
    const up = () => {
      dragging = false;
    };
    const interact = () => {
      const station = nearbyStation(pose.current, layout);
      if (!latest.current.blocked && station) {
        pause();
        document.exitPointerLock?.();
        latest.current.onInteract(station);
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        latest.current.blocked ||
        document.hidden ||
        (document.activeElement !== canvas &&
          document.pointerLockElement !== canvas)
      )
        return;
      if (
        event.code === "Enter" ||
        (event.code === "KeyE" && document.pointerLockElement === canvas)
      ) {
        event.preventDefault();
        if (!event.repeat) interact();
        return;
      }
      if (
        [
          "KeyW",
          "KeyA",
          "KeyS",
          "KeyD",
          "KeyQ",
          "KeyE",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
        ].includes(event.code)
      ) {
        event.preventDefault();
        control.current.add(event.code);
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      control.current.delete(event.code);
    };
    const resize = new ResizeObserver(() => {
      const w = element.clientWidth,
        h = element.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      // Resizing clears the drawing buffer. Paint immediately so an action
      // receipt or dialog changing the layout does not reveal a blank frame.
      renderer.render(scene, camera);
    });
    resize.observe(element);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("webglcontextlost", contextLost);
    window.addEventListener("pointerup", up);
    document.addEventListener("mousemove", move);
    document.addEventListener("pointerlockchange", lockChange);
    document.addEventListener("pointerlockerror", lockError);
    document.addEventListener("keydown", keyDown);
    document.addEventListener("keyup", keyUp);
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", pause);
    canvas.addEventListener("blur", pause);
    function draw(now: number) {
      if (disposed) return;
      frame = requestAnimationFrame(draw);
      const dt = Math.min((now - previous) / 1000, 0.05);
      previous = now;
      if (document.hidden) return;
      if (!latest.current.blocked) {
        const keys = control.current,
          has = (a: string, b: string) => keys.has(a) || keys.has(b);
        pose.current = moveInField(
          pose.current,
          Number(has("KeyD", "ArrowRight")) - Number(has("KeyA", "ArrowLeft")),
          Number(has("KeyW", "ArrowUp")) - Number(has("KeyS", "ArrowDown")),
          dt,
          layout,
        );
        pose.current.yaw +=
          (Number(keys.has("KeyQ")) - Number(keys.has("KeyE"))) * dt * 1.45;
      }
      const p = pose.current;
      camera.position.set(p.x, 1.68, p.z);
      camera.rotation.set(p.pitch, p.yaw, 0, "YXZ");
      const station = nearbyStation(p, layout);
      if (station !== previousNearby) {
        previousNearby = station;
        setNearby(station);
      }
      // Cosmetic pose is observable for accessibility/debugging, never used as gameplay authority.
      canvas.dataset.position = `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
      canvas.dataset.yaw = p.yaw.toFixed(3);
      for (const label of stationLabels) {
        const distance = Math.hypot(
          label.position.x - p.x,
          label.position.z - p.z,
        );
        // At conversation distance the HTML interaction prompt identifies the
        // role; suppress the perspective-scaled billboard before it fills view.
        label.visible = distance >= 3 && distance < 5;
      }
      renderer.render(scene, camera);
    }
    frame = requestAnimationFrame(draw);
    return () => {
      disposed = true;
      art.dispose();
      cancelAnimationFrame(frame);
      pause();
      resize.disconnect();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("blur", pause);
      window.removeEventListener("pointerup", up);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("pointerlockchange", lockChange);
      document.removeEventListener("pointerlockerror", lockError);
      document.removeEventListener("keydown", keyDown);
      document.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", pause);
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
      sun.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, [chinese, sceneId]);
  return (
    <>
      <div
        className="market-viewport"
        ref={host}
        data-testid="market-viewport"
        data-scene-id={sceneId}
      />
      {!failed && !blocked && (
        <div className="market-reticle" aria-hidden="true">
          +
        </div>
      )}
      {!failed && artState !== "ready" && (
        <div
          className="market-art-status"
          role="status"
          data-testid="market-art-status"
        >
          {artState === "loading" ? copy.artLoading : copy.artFallback}
        </div>
      )}
      {failed ? (
        <div className="market-fallback" role="status">
          {copy.failed}
        </div>
      ) : (
        <div className="market-walk-hint">
          <span>{blocked ? copy.paused : copy.walk}</span>
          {!locked && !blocked && <small>{copy.alternate}</small>}
        </div>
      )}
      {nearby && !blocked && !failed && (
        <button
          className="market-interact"
          data-testid="field-interact"
          onClick={() => onInteract(nearby)}
        >
          <kbd>{locked ? "E" : "↵"}</kbd>
          {copy.engage} / {copy[nearby]}
        </button>
      )}
      {!failed && (
        <details className="market-controls">
          <summary>{copy.controls}</summary>
          <div>
            {(
              [
                ["KeyQ", "↶", copy.turnLeft],
                ["KeyW", "↑", copy.forward],
                ["KeyE", "↷", copy.turnRight],
                ["KeyA", "←", copy.left],
                ["KeyS", "↓", copy.back],
                ["KeyD", "→", copy.right],
              ] as const
            ).map(([code, label, name]) => (
              <button
                key={code}
                aria-label={name}
                disabled={blocked}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  control.current.add(code);
                }}
                onPointerUp={() => control.current.delete(code)}
                onPointerCancel={() => control.current.delete(code)}
                onLostPointerCapture={() => control.current.delete(code)}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    control.current.add(code);
                  }
                }}
                onKeyUp={() => control.current.delete(code)}
                onBlur={() => control.current.delete(code)}
              >
                {label}
              </button>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
