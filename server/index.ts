import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createGameService } from "./core/service.js";
import { createAiService } from "./ai/index.js";
import { createHttpApp } from "./http/app.js";
import { loadHttpConfig } from "./http/config.js";

const config = loadHttpConfig();
const resumeSessionIds: string[] = [];
for (let i = 2; i < process.argv.length; i += 1) {
  if (
    process.argv[i] !== "--resume-session" ||
    !process.argv[i + 1] ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      process.argv[i + 1]!,
    )
  ) {
    throw new Error(
      "Usage: server/index.ts [--resume-session <terminal-session-uuid>]",
    );
  }
  resumeSessionIds.push(process.argv[++i]!);
}
mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
const launchToken = randomBytes(32).toString("hex");
const service = createGameService({
  dbPath: config.dbPath,
  launchId: randomUUID(),
  tokenHash: createHash("sha256").update(launchToken).digest("hex"),
  agents: createAiService({ repoRoot: config.repoRoot }),
  resumeSessionIds,
  recoverOnStartup: true,
});
const app = await createHttpApp({
  service,
  config,
  launchToken,
  closeServiceOnClose: true,
});
const stopScheduler = service.startScheduler();
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  stopScheduler();
  await app.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try {
  await app.listen({ host: config.host, port: config.port });
  console.info(`LAST MILE: http://${config.host}:${config.port} (local only)`);
} catch (error) {
  await shutdown();
  throw error;
}
