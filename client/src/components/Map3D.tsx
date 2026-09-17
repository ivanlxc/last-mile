import { useI18n } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { KnownLocation } from "../../../docs/engineering_v0.5/contracts/public.types";
import { mapData, locationPoint } from "../lib/map";
export default function Map3D({
  location,
  onFailure,
}: {
  location: KnownLocation;
  onFailure: () => void;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null),
    position = useRef(location),
    failure = useRef(onFailure);
  position.current = location;
  failure.current = onFailure;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let disposed = false,
      raf = 0;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch {
      failure.current();
      return;
    }
    const element = host.current;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.setClearColor(0x121b19, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const convoy: THREE.Object3D[] = [];
    const trail: THREE.Vector3[] = [];
    const vehicleDirections: THREE.Vector3[] = [];
    const camera = new THREE.OrthographicCamera(-27, 27, 22, -22, 0.1, 250);
    camera.position.set(15, 39, 34);
    camera.lookAt(0, 0, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minZoom = 0.65;
    controls.maxZoom = 2.8;
    controls.maxPolarAngle = Math.PI * 0.44;
    controls.minPolarAngle = Math.PI * 0.09;
    controls.target.set(0, 0, 0);
    controls.enablePan = true;
    scene.add(new THREE.HemisphereLight(0xffebcf, 0x3d5b59, 1.5));
    const sun = new THREE.DirectionalLight(0xffd9a3, 2.0);
    sun.position.set(-25, 42, 5);
    scene.add(sun);
    const overlay = new THREE.Group();
    scene.add(overlay);
    for (const route of mapData.routes.filter((r) => r.enabled)) {
      const geometry = new THREE.BufferGeometry().setFromPoints(
        route.waypoints.map((p) => new THREE.Vector3(p[0], p[1] + 0.3, p[2])),
      );
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({
          color: 0x94c8b1,
          transparent: true,
          opacity: 0.52,
          depthTest: false,
        }),
      );
      line.renderOrder = 9;
      overlay.add(line);
    }
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.055, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xf3c783, depthTest: false }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.renderOrder = 20;
    ring.material.transparent = true;
    ring.material.opacity = 0.9;
    const marker = new THREE.Group();
    marker.add(ring);
    const pin = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.7, 4),
      new THREE.MeshBasicMaterial({ color: 0xfbe1a7, depthTest: false }),
    );
    pin.rotation.z = Math.PI;
    pin.position.y = 1;
    pin.renderOrder = 20;
    marker.add(pin);
    scene.add(marker);
    const goal = mapData.nodes.find((n) => n.nodeId === "N07")!;
    const goalRing = ring.clone();
    goalRing.material = new THREE.MeshBasicMaterial({
      color: 0xa5d7ba,
      depthTest: false,
    });
    goalRing.position.set(
      goal.position[0],
      goal.position[1] + 0.2,
      goal.position[2],
    );
    scene.add(goalRing);
    new GLTFLoader().load(
      "/assets/map.glb",
      (gltf) => {
        if (disposed) {
          disposeTree(gltf.scene);
          return;
        }
        gltf.scene.traverse((node) => {
          if (node.userData.actor_type === "convoy") convoy.push(node);
        });
        convoy.sort((a, b) => a.name.localeCompare(b.name));
        for (const bus of convoy) {
          vehicleDirections.push(new THREE.Vector3(1, 0, -1).normalize());
        }
        scene.add(gltf.scene);
        setReady(true);
      },
      undefined,
      () => {
        if (!disposed) failure.current();
      },
    );
    const resize = () => {
      const w = element.clientWidth,
        h = element.clientHeight;
      if (w < 1 || h < 1) return;
      renderer.setSize(w, h);
      const ratio = w / h,
        half = 16;
      camera.left = -half * ratio;
      camera.right = half * ratio;
      camera.top = half;
      camera.bottom = -half;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    let initialized = false;
    const animate = () => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      const p = locationPoint(position.current);
      const target = new THREE.Vector3(p[0], p[1] + 0.65, p[2]);
      if (!initialized) {
        marker.position.copy(target);
        initialized = true;
      } else marker.position.lerp(target, 0.15);
      const ground = marker.position.clone();
      ground.y -= 0.65;
      if (!trail.length || trail[trail.length - 1].distanceTo(ground) > 0.04) {
        trail.push(ground.clone());
        if (trail.length > 350) trail.shift();
      }
      for (let i = 0; i < convoy.length; i++) {
        let distance = i * 1.25;
        let at = ground.clone();
        let facing = vehicleDirections[i];
        for (let j = trail.length - 1; j > 0; j--) {
          const seg = trail[j].distanceTo(trail[j - 1]);
          if (distance <= seg) {
            at = trail[j].clone().lerp(trail[j - 1], seg ? distance / seg : 0);
            facing = trail[j]
              .clone()
              .sub(trail[j - 1])
              .normalize();
            break;
          }
          distance -= seg;
          at = trail[j - 1].clone();
        }
        if (trail.length < 2) at.addScaledVector(facing, -i * 1.25);
        const bus = convoy[i];
        bus.position.copy(at);
        if (facing.lengthSq() > 0.1) {
          vehicleDirections[i] = facing;
          bus.rotation.set(0, Math.atan2(-facing.z, facing.x), 0);
        }
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
    const lost = (event: Event) => {
      event.preventDefault();
      failure.current();
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div
      className="map3d"
      ref={host}
      aria-label={t("ui.interactive3DTerrainModel")}
    >
      {!ready && (
        <div className="map-loading">
          <span className="spinner" /> {t("ui.loadingTheTerrainModel")}{" "}
        </div>
      )}
    </div>
  );
}
function disposeTree(root: THREE.Object3D) {
  root.traverse((node) => {
    if (node instanceof THREE.Mesh || node instanceof THREE.Line) {
      node.geometry?.dispose();
      const materials = Array.isArray(node.material)
        ? node.material
        : [node.material];
      for (const m of materials) {
        for (const value of Object.values(m))
          if (value instanceof THREE.Texture) value.dispose();
        m.dispose();
      }
    }
  });
}
