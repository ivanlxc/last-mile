import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as waitForLease } from "node:timers/promises";
import { createGameService } from "./core/service.js";
import { configuredAgents } from "./runtime.js";
import { createStore, type Store } from "./core/store.js";
import { createHttpApp } from "./http/app.js";
import { loadHttpConfig } from "./http/config.js";
import { listenForHandoff } from "./http/handoff.js";

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
if (config.mode === "cloud" && resumeSessionIds.length) {
  throw new Error(
    "Cloud history is accessed by its owning player, not --resume-session.",
  );
}
const agents = configuredAgents(config.mode, config.repoRoot);
if (config.mode === "local")
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
async function acquireStorage(): Promise<{
  store: Store;
  handoff?: Awaited<ReturnType<typeof listenForHandoff>>;
}> {
  const options = { dbPath: config.dbPath, databaseUrl: config.databaseUrl };
  try {
    return { store: await createStore(options) };
  } catch (error) {
    // Only a successfully authenticated connection blocked by an existing
    // engine can enter standby. Bad credentials/migrations fail deployment.
    if (
      config.mode !== "cloud" ||
      !process.env.RENDER_EXTERNAL_URL ||
      (error as { code?: string }).code !== "ENGINE_ALREADY_RUNNING"
    )
      throw error;
  }
  const handoff = await listenForHandoff(config);
  console.info("LAST MILE waiting for the previous Render instance to stop.");
  const deadline = performance.now() + 180_000;
  try {
    while (performance.now() < deadline) {
      try {
        return {
          store: await createStore({ ...options, startupLockTimeoutMs: 0 }),
          handoff,
        };
      } catch (error) {
        if ((error as { code?: string }).code !== "ENGINE_ALREADY_RUNNING")
          throw error;
      }
      await waitForLease(1000);
    }
    throw new Error(
      "ENGINE_HANDOFF_TIMEOUT: the previous instance did not release storage.",
    );
  } catch (error) {
    await handoff.close();
    throw error;
  }
}
const { store, handoff } = await acquireStorage();
let stopAfterStorageFailure: (() => Promise<void>) | undefined;
const launchToken = randomBytes(32).toString("hex");
const service = await createGameService({
  store,
  cloud: config.mode === "cloud" ? config.limits : undefined,
  dbPath: config.dbPath,
  launchId: randomUUID(),
  tokenHash: createHash("sha256").update(launchToken).digest("hex"),
  agents,
  resumeSessionIds,
  recoverOnStartup: true,
  onStorageFailure: () => {
    // A lost COMMIT acknowledgement must not leave a running clock based on an
    // assumed rollback. Exit; the next process recovers from durable records.
    console.error(
      "LAST MILE storage connection failed; stopping for recovery.",
    );
    void (stopAfterStorageFailure?.() ?? store.close())
      .catch(() => {})
      .finally(() => process.exit(1));
  },
});
const app = await createHttpApp({
  service,
  store,
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
stopAfterStorageFailure = shutdown;
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try {
  // The temporary listener never handles game operations. Release its port only
  // after this instance owns the lease and the real application is initialized.
  await handoff?.close();
  await app.listen({ host: config.host, port: config.port });
  console.info(
    `LAST MILE: ${config.mode === "cloud" ? config.publicOrigin : `http://${config.host}:${config.port}`} (${config.mode})`,
  );
} catch (error) {
  await shutdown();
  throw error;
}
