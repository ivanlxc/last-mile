import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Build-time copies only. The browser never loads a CDN or sends camera frames.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve("@mediapipe/tasks-vision"));
const pkg = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
if (pkg.version !== "1.0.1")
  throw new Error(
    "Gesture runtime expects MediaPipe 1.0.1; update paths and verify the Worker when upgrading.",
  );
const output = path.join(root, "client/public/gestures");
const wasm = path.join(output, "mediapipe", pkg.version, "wasm");
await mkdir(wasm, { recursive: true });
await mkdir(path.join(output, "models"), { recursive: true });
for (const name of await readdir(path.join(packageRoot, "wasm"))) {
  if (/\.(js|wasm)$/.test(name))
    await copyFile(path.join(packageRoot, "wasm", name), path.join(wasm, name));
}
const name = "hand_landmarker-float16-v1.task";
const source = path.join(root, "assets/models/mediapipe", name);
const expected = JSON.parse(
  await readFile(
    path.join(root, "assets/models/mediapipe/source.json"),
    "utf8",
  ),
);
if (
  createHash("sha256")
    .update(await readFile(source))
    .digest("hex") !== expected.sha256
) {
  throw new Error("Hand landmark model checksum mismatch.");
}
await copyFile(source, path.join(output, "models", name));
for (const notice of ["LICENSE", "README.md", "source.json"]) {
  await copyFile(
    path.join(root, "assets/models/mediapipe", notice),
    path.join(output, notice),
  );
}
console.log(
  "Gesture assets ready: local MediaPipe 1.0.1 + verified Hand Landmarker model.",
);
