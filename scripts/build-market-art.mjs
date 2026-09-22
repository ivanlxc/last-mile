/** Art production is an explicit local step, never a dependency of game startup. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
const blender =
  process.env.BLENDER_PATH ||
  "/Applications/Blender.app/Contents/MacOS/Blender";
if (!existsSync(blender))
  throw new Error("Set BLENDER_PATH to Blender 5.2 or later.");
if (!existsSync("assets/authoring/market-sample-v1/texture-sources.json"))
  throw new Error(
    "First run python3 scripts/art/fetch-market-textures.py (Poly Haven CC0 materials).",
  );
const result = spawnSync(
  blender,
  [
    "--background",
    "--python-exit-code",
    "1",
    "--python",
    "scripts/art/create-market-sample.py",
    "--",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
