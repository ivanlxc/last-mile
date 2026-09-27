import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "assets/authoring/market-sample-v1");
const destination = resolve(root, "unity/LastMileArt/Assets/Art");
async function writeChanged(path, contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const previous = await readFile(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!previous?.equals(bytes)) await writeFile(path, bytes);
}
const glb = await readFile(
  resolve(root, "client/public/assets/market/market-sample-v1.glb"),
);
if (
  glb.toString("ascii", 0, 4) !== "glTF" ||
  glb.readUInt32LE(16) !== 0x4e4f534a
)
  throw new Error("Expected the authored market GLB with a JSON chunk.");
const gltf = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));
const textureName = (info) =>
  info ? gltf.images[gltf.textures[info.index].source].name : null;
const materials = gltf.materials.map((material) => {
  const pbr = material.pbrMetallicRoughness ?? {};
  return {
    name: material.name,
    color: pbr.baseColorFactor ?? [1, 1, 1, 1],
    metallic: pbr.metallicFactor ?? 1,
    roughness: pbr.roughnessFactor ?? 1,
    normalScale: material.normalTexture?.scale ?? 1,
    baseColor: textureName(pbr.baseColorTexture),
    normal: textureName(material.normalTexture),
    // Original source image is grayscale roughness, before glTF channel packing.
    roughnessMap: textureName(pbr.metallicRoughnessTexture),
    doubleSided: material.doubleSided === true,
  };
});
await mkdir(resolve(destination, "Textures"), { recursive: true });
await writeChanged(
  resolve(destination, "MarketSample.fbx"),
  await readFile(resolve(source, "MarketSample.fbx")),
);
const textureNames = new Set(
  materials
    .flatMap((m) => [m.baseColor, m.normal, m.roughnessMap])
    .filter(Boolean),
);
for (const name of textureNames) {
  if (!/^[a-zA-Z0-9_]+$/.test(name))
    throw new Error("Invalid texture source name.");
  await writeChanged(
    resolve(destination, "Textures", `${name}.jpg`),
    await readFile(resolve(source, "textures", `${name}.jpg`)),
  );
}
await writeChanged(
  resolve(destination, "materials.json"),
  JSON.stringify({ materials }, null, 2) + "\n",
);
console.log(
  `Prepared native art: ${materials.length} materials, ${textureNames.size} textures. No scenario or secret configuration is read.`,
);
