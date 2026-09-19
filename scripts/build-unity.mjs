#!/usr/bin/env node
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = join(root, "unity", "LastMile");
const publicDirectory = join(root, "client", "public", "unity");
const expectedVersion = "6000.3.22f1";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findEditor() {
  if (process.env.UNITY_EDITOR_PATH) {
    const path = resolve(process.env.UNITY_EDITOR_PATH);
    if (!(await exists(path)))
      throw new Error(`UNITY_EDITOR_PATH does not exist: ${path}`);
    return path;
  }
  const hubRoots =
    process.platform === "darwin"
      ? [
          "/Applications/Unity/Hub/Editor",
          join(homedir(), "Applications", "Unity", "Hub", "Editor"),
        ]
      : process.platform === "win32"
        ? [
            join(
              process.env.ProgramFiles || "C:\\Program Files",
              "Unity",
              "Hub",
              "Editor",
            ),
          ]
        : [join(homedir(), "Unity", "Hub", "Editor"), "/opt/unity/editors"];
  const suffix =
    process.platform === "darwin"
      ? ["Unity.app", "Contents", "MacOS", "Unity"]
      : process.platform === "win32"
        ? ["Editor", "Unity.exe"]
        : ["Editor", "Unity"];
  for (const hubRoot of hubRoots) {
    if (!(await exists(hubRoot))) continue;
    const versions = (await readdir(hubRoot)).filter((name) =>
      /^6000\.3\./.test(name),
    );
    versions.sort((a, b) =>
      a === expectedVersion
        ? -1
        : b === expectedVersion
          ? 1
          : b.localeCompare(a, undefined, { numeric: true }),
    );
    for (const version of versions) {
      const executable = join(hubRoot, version, ...suffix);
      if (await exists(executable)) return executable;
    }
  }
  if (
    process.platform === "darwin" &&
    (await exists("/Applications/Unity/Unity.app/Contents/MacOS/Unity"))
  )
    return "/Applications/Unity/Unity.app/Contents/MacOS/Unity";
  throw new Error(
    `Unity Editor was not found. Install Unity ${expectedVersion} (6.3 LTS) and Web Build Support in Unity Hub, open it once to complete your own license setup, then rerun pnpm build:unity. For a custom installation, set UNITY_EDITOR_PATH to the editor executable. No Unity runtime has been generated.`,
  );
}

async function preparePublicMap() {
  const source = JSON.parse(
    await readFile(join(root, "client", "src", "lib", "map-data.json"), "utf8"),
  );
  const point = (position) => {
    if (
      !Array.isArray(position) ||
      position.length !== 3 ||
      !position.every(Number.isFinite)
    )
      throw new Error("Invalid public-map position.");
    return { x: position[0], y: position[1], z: position[2] };
  };
  const map = {
    mapId: source.mapId,
    nodes: source.nodes.map((node) => ({
      nodeId: node.nodeId,
      label: node.label,
      sceneId: node.sceneId,
      playable: !!node.playable,
      position: point(node.position),
    })),
    routes: source.routes.map((route) => ({
      routeId: route.routeId,
      fromNode: route.fromNode,
      toNode: route.toNode,
      enabled: !!route.enabled,
      bidirectional: !!route.bidirectional,
      waypoints: route.waypoints.map(point),
    })),
  };
  await mkdir(join(project, "Assets", "Resources"), { recursive: true });
  await writeFile(
    join(project, "Assets", "Resources", "PublicMap.json"),
    JSON.stringify(map, null, 2) + "\n",
  );
  console.log(
    `Prepared public map: ${map.nodes.length} nodes, ${map.routes.length} routes. No scenario files are read.`,
  );
}

async function prepareArt() {
  const source = join(
    root,
    "assets",
    "authoring",
    "last-mile-unity",
    "exports",
  );
  const destination = join(project, "Assets", "Resources", "Art");
  if (!(await exists(join(source, "LastMileMap.fbx")))) {
    throw new Error(
      "Blender art export is missing. Run pnpm build:art, then pnpm build:unity.",
    );
  }
  if (!(await exists(join(source, "materials.json")))) {
    throw new Error(
      "Blender material export is missing. Run pnpm build:art to generate the complete FBX and material export.",
    );
  }
  let copied = 0;
  async function copyExports(from, to) {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const sourcePath = join(from, entry.name);
      const targetPath = join(to, entry.name);
      if (entry.isDirectory() && /^(textures|Textures)$/.test(entry.name)) {
        await copyExports(sourcePath, targetPath);
      } else if (
        entry.isFile() &&
        (entry.name === "LastMileMap.fbx" ||
          entry.name === "materials.json" ||
          /\.(png|jpg|jpeg)$/.test(entry.name))
      ) {
        const bytes = await readFile(sourcePath);
        if (await exists(targetPath)) {
          const previous = await readFile(targetPath);
          if (previous.equals(bytes)) continue;
        }
        // Preserve existing Unity .meta IDs; only authored data is synchronized.
        await writeFile(targetPath, bytes);
        copied++;
      }
    }
  }
  await copyExports(source, destination);
  console.log(
    `Prepared Blender FBX and textures: ${copied} changed files. Original Blender source and scenario data are not copied.`,
  );
}

async function build() {
  if (process.argv.includes("--prepare-only")) {
    await preparePublicMap();
    await prepareArt();
    return;
  }
  const editor = await findEditor();
  console.log(`Unity Editor: ${editor}`);
  if (process.argv.includes("--check")) return;
  await preparePublicMap();
  await prepareArt();
  const releaseId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  // Staging and final release share a filesystem so rename publishes a complete release directory.
  const staging = join(root, "unity", ".build-output", releaseId);
  const logPath = join(project, "Logs", `web-build-${releaseId}.log`);
  await mkdir(dirname(staging), { recursive: true });
  await mkdir(dirname(logPath), { recursive: true });
  console.log(
    `Building real Unity Web player. This may take several minutes. Log: ${logPath}`,
  );
  try {
    const code = await new Promise((resolveCode, reject) => {
      const child = spawn(
        editor,
        [
          "-batchmode",
          "-quit",
          "-projectPath",
          project,
          "-buildTarget",
          "WebGL",
          "-executeMethod",
          "LastMile.Editor.WebBuild.Build",
          "-logFile",
          logPath,
        ],
        {
          cwd: root,
          stdio: "inherit",
          env: { ...process.env, LAST_MILE_UNITY_BUILD_PATH: staging },
        },
      );
      child.on("error", reject);
      child.on("close", (exitCode, signal) =>
        signal
          ? reject(new Error(`Unity was stopped by ${signal}`))
          : resolveCode(exitCode),
      );
    });
    if (code !== 0)
      throw new Error(
        `Unity exited with code ${code}. Check ${logPath}. Ensure Web Build Support is installed, a valid license is active, and this project is not already open in another editor process.`,
      );
    const buildDirectory = join(staging, "Build");
    const files = await readdir(buildDirectory);
    const find = async (suffix) => {
      const matches = files.filter((file) => file.endsWith(suffix));
      if (
        matches.length !== 1 ||
        (await stat(join(buildDirectory, matches[0]))).size === 0
      )
        throw new Error(
          `Unity build did not produce exactly one nonempty ${suffix} file. Existing runtime is unchanged.`,
        );
      if (!/^[A-Za-z0-9_.-]+$/.test(matches[0]))
        throw new Error(
          `Unity output filename is incompatible with the browser asset policy: ${matches[0]}. Use an ASCII build name without spaces. Existing runtime is unchanged.`,
        );
      return matches[0];
    };
    const loader = await find(".loader.js");
    const data = await find(".data");
    const framework = await find(".framework.js");
    const codeFile = await find(".wasm");
    const wasm = await readFile(join(buildDirectory, codeFile));
    if (!wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])))
      throw new Error("Build output is not a WebAssembly binary.");
    const url = (file) =>
      `/unity/releases/${releaseId}/Build/${encodeURIComponent(file)}`;
    const manifest = {
      schemaVersion: 1,
      loaderUrl: url(loader),
      dataUrl: url(data),
      frameworkUrl: url(framework),
      codeUrl: url(codeFile),
      companyName: "Last Mile Team",
      productName: "Last Mile",
      productVersion: "0.1.0",
    };
    await mkdir(join(publicDirectory, "releases"), { recursive: true });
    await rename(staging, join(publicDirectory, "releases", releaseId));
    const manifestStaging = join(
      publicDirectory,
      `.manifest-${releaseId}.json`,
    );
    await writeFile(manifestStaging, JSON.stringify(manifest, null, 2) + "\n");
    await rename(manifestStaging, join(publicDirectory, "manifest.json"));
    console.log(
      "Unity Web build installed. Start pnpm dev, reload the map, and select Unity. For production, run pnpm build after this command.",
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

build().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
