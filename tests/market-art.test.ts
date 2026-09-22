import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Inspect the shipped binary, not a mocked asset: prevents accidental export of
// external dependencies, missing textures, lights/cameras, or an oversized mesh.
describe("market sample delivery", () => {
  it("ships a self-contained textured GLB within the sample budget", () => {
    const binary = readFileSync(
      "client/public/assets/market/market-sample-v1.glb",
    );
    expect(binary.toString("ascii", 0, 4)).toBe("glTF");
    expect(binary.readUInt32LE(4)).toBe(2);
    expect(binary.readUInt32LE(8)).toBe(binary.length);
    expect(binary.length).toBeLessThan(32 * 1024 * 1024);
    const document = JSON.parse(
      binary.toString("utf8", 20, 20 + binary.readUInt32LE(12)),
    );
    expect(document.cameras ?? []).toHaveLength(0);
    expect(document.extensions?.KHR_lights_punctual).toBeUndefined();
    expect(document.buffers).toHaveLength(1);
    expect(document.buffers[0].uri).toBeUndefined();
    expect(document.images.length).toBeGreaterThanOrEqual(9);
    for (const image of document.images) {
      expect(image.uri).toBeUndefined();
      expect(document.bufferViews[image.bufferView].byteLength).toBeGreaterThan(
        0,
      );
    }
    const primitives = document.meshes.flatMap(
      (mesh: { primitives: unknown[] }) => mesh.primitives,
    );
    expect(primitives.length).toBeLessThanOrEqual(40);
    let triangles = 0;
    for (const primitive of primitives) {
      const material = document.materials[primitive.material];
      if (
        material.pbrMetallicRoughness.baseColorTexture ||
        material.normalTexture
      )
        expect(primitive.attributes.TEXCOORD_0).toBeDefined();
      expect(primitive.attributes.NORMAL).toBeDefined();
      triangles += document.accessors[primitive.indices].count / 3;
    }
    expect(triangles).toBeLessThan(100_000);
    const manifest = JSON.parse(
      readFileSync(
        "assets/authoring/market-sample-v1/build-manifest.json",
        "utf8",
      ),
    );
    expect(manifest.triangles).toBe(triangles);
    expect(manifest.glbBytes).toBe(binary.length);
  });
});
