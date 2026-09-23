import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export const MARKET_ART_URL = "/assets/market/market-sample-v1.glb";

/** Own every decoded GLB resource, including a late decode after unmount. */
function release(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const images = new Set<ImageBitmap>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (!(value instanceof THREE.Texture)) continue;
        textures.add(value);
        if (
          typeof ImageBitmap !== "undefined" &&
          value.image instanceof ImageBitmap
        )
          images.add(value.image);
      }
    }
  });
  root.removeFromParent();
  geometries.forEach((value) => value.dispose());
  materials.forEach((value) => value.dispose());
  textures.forEach((value) => value.dispose());
  images.forEach((value) => value.close());
}

/** Asset I/O only. This module cannot access game state, reports, or server truth. */
export function loadMarketArt(
  renderer: THREE.WebGLRenderer,
  onReady: (root: THREE.Group) => void,
  onFailure: () => void,
  url: string = MARKET_ART_URL,
) {
  const controller = new AbortController();
  let disposed = false;
  let root: THREE.Group | undefined;
  // Slow/failed downloads never hold the game's briefing or route controls.
  const timeout = setTimeout(() => controller.abort(), 60_000);
  void (async () => {
    try {
      const response = await fetch(url, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Market art unavailable");
      const data = await response.arrayBuffer();
      if (disposed) return;
      const manager = new THREE.LoadingManager();
      let textureFailed = false;
      manager.onError = () => {
        textureFailed = true;
      };
      const gltf = await new GLTFLoader(manager).parseAsync(
        data,
        url.slice(0, url.lastIndexOf("/") + 1),
      );
      if (disposed) {
        release(gltf.scene);
        return;
      }
      root = gltf.scene;
      // GLTFLoader tolerates failed images. Our visual sample must not silently
      // claim readiness while its walls/road are untextured white surfaces.
      if (textureFailed) throw new Error("Market textures unavailable");
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = !object.name.startsWith("ground");
        object.receiveShadow = true;
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials)
          for (const value of Object.values(material))
            if (value instanceof THREE.Texture)
              value.anisotropy = Math.min(
                4,
                renderer.capabilities.getMaxAnisotropy(),
              );
      });
      onReady(root);
      renderer.shadowMap.needsUpdate = true;
    } catch {
      if (!disposed) {
        if (root) release(root);
        root = undefined;
        onFailure();
      }
    } finally {
      clearTimeout(timeout);
    }
  })();
  return {
    dispose() {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
      if (root) release(root);
      root = undefined;
    },
  };
}
