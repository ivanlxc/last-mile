import { spawn } from "node:child_process";
const tasks = [
  spawn(
    process.execPath,
    ["--import", "tsx", "--env-file-if-exists=.env", "server/index.ts"],
    { stdio: "inherit" },
  ),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  tasks.forEach((t) => t.kill("SIGTERM"));
  setTimeout(() => process.exit(code), 250);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
tasks.forEach((t) =>
  t.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  }),
);
