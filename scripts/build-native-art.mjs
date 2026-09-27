import { access, mkdir, statfs } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = resolve(root, "unity/LastMileArt");
const flags = new Set(process.argv.slice(2));
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const run = (program, args) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${program} exited ${code ?? signal}`)),
    );
  });

try {
  if (flags.has("--prepare-only")) {
    await run(process.execPath, [
      resolve(root, "scripts/prepare-native-art.mjs"),
    ]);
    process.exit(0);
  }
  const candidates = [
    process.env.UNITY_EDITOR_PATH,
    "/Applications/Unity/Hub/Editor/6000.3.22f1/Unity.app/Contents/MacOS/Unity",
    "/Applications/Unity/Unity.app/Contents/MacOS/Unity",
  ].filter(Boolean);
  let editor;
  for (const candidate of candidates)
    if (await exists(candidate)) {
      editor = candidate;
      break;
    }
  if (!editor)
    throw new Error(
      "Unity 6000.3.22f1 is not installed. Install the Apple Silicon Editor without optional modules, or set UNITY_EDITOR_PATH to its executable.",
    );
  console.log(`Editor: ${editor}`);
  if (flags.has("--check")) process.exit(0);
  const disk = await statfs(project);
  if (disk.bavail * disk.bsize < 3 * 1024 ** 3)
    throw new Error(
      "Less than 3 GiB free. Make room for the asset cache before opening or building this sample.",
    );
  await run(process.execPath, [
    resolve(root, "scripts/prepare-native-art.mjs"),
  ]);
  if (flags.has("--open")) {
    const child = spawn(editor, ["-projectPath", project], {
      cwd: root,
      detached: true,
      stdio: "ignore",
    });
    await new Promise((resolveStart, reject) => {
      child.once("spawn", resolveStart);
      child.once("error", reject);
    });
    child.unref();
    console.log(
      "Editor launched. Use Last Mile Art > Prepare Sample once, then press Play.",
    );
  } else {
    await mkdir(resolve(project, "Logs"), { recursive: true });
    const build = flags.has("--build");
    const log = resolve(
      project,
      "Logs",
      build ? "native-build.log" : "native-prepare.log",
    );
    console.log(`Unity log: ${log}`);
    await run(editor, [
      "-batchmode",
      "-quit",
      "-projectPath",
      project,
      "-executeMethod",
      `LastMile.Art.Editor.NativeArtBuilder.${build ? "BuildMac" : "Prepare"}`,
      "-logFile",
      log,
    ]);
    const output = resolve(
      project,
      build
        ? "Builds/LastMileArt.app/Contents/Info.plist"
        : "Assets/Scenes/MarketArt.unity",
    );
    if (!(await exists(output)))
      throw new Error(`Unity exited without the expected output. Check ${log}`);
    console.log(`Ready: ${output}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
