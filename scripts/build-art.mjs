#!/usr/bin/env node
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const blender =
  process.env.BLENDER_PATH ||
  (process.platform === "darwin"
    ? "/Applications/Blender.app/Contents/MacOS/Blender"
    : "blender");

try {
  await access(resolve(root, "scripts/refine-unity-scene.py"));
  console.log(
    "Rebuilding public scene art from the original Blender master. This may take several minutes.",
  );
  const result = await new Promise((resolveCode, reject) => {
    const processHandle = spawn(
      blender,
      [
        "--background",
        "--python-exit-code",
        "1",
        "--python",
        resolve(root, "scripts/refine-unity-scene.py"),
        "--",
        ...process.argv.slice(2),
      ],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
    processHandle.on("error", reject);
    processHandle.on("close", (code, signal) =>
      signal
        ? reject(new Error(`Blender stopped by ${signal}`))
        : resolveCode(code),
    );
  });
  if (result !== 0) throw new Error(`Blender exited with ${result}.`);
  console.log(
    "Art export complete. Run pnpm build:unity to build the browser scene.",
  );
} catch (error) {
  console.error(
    `Art build failed: ${error.message}\nInstall Blender or set BLENDER_PATH to its executable.`,
  );
  process.exitCode = 1;
}
