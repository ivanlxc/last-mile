/** Local, disposable preview. No .env, cloud database, API keys or production state. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  createGameService,
  type MutationOperation,
} from "../server/core/service.js";
import { createAiService } from "../server/ai/index.js";
import { createHttpApp } from "../server/http/app.js";
import { loadHttpConfig } from "../server/http/config.js";
import type * as P from "../docs/engineering_v0.5/contracts/public.types.js";

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
};
const campaign = process.argv.includes("--campaign");
const previewCase = arg("--case", "A");
const previewLocale = arg("--locale", "en-US");
if (
  !["A", "B"].includes(previewCase) ||
  !["en-US", "zh-CN"].includes(previewLocale)
)
  throw new Error("Use --case A|B and --locale en-US|zh-CN.");
const port = campaign ? 3113 : 3112;
if (!existsSync("dist/client/index.html"))
  throw new Error("Run pnpm build first.");
const config = loadHttpConfig({
  LAST_MILE_ROOT: process.cwd(),
  PORT: String(port),
});
const service = await createGameService({
  dbPath: ":memory:",
  recoverOnStartup: false,
  autoTick: true,
  agents: createAiService({ env: {} }),
  selectCase: () => previewCase as "A" | "B",
});
const app = await createHttpApp({ service, config, closeServiceOnClose: true });
try {
  const boot = (await service.read("getBootstrap")) as P.BootstrapView;
  const create = (await service.execute(
    "createSession",
    {
      profileId: "SINGLE_PLAYER_REFERENCE",
      runPurpose: "design_preview",
      locale: previewLocale,
      contentVersionId: boot.profiles[0]!.contentVersionId,
    },
    { idempotencyKey: randomUUID() },
  )) as P.SessionCreated;
  const command = async (op: MutationOperation, payload: unknown) => {
    const s = (await service.read(
      "getSession",
      create.sessionId,
    )) as P.SessionProjection;
    await service.execute(
      op,
      {
        expectedStateVersion: s.stateVersion,
        expectedSceneId: s.sceneId,
        payload,
      },
      {
        sessionId: s.sessionId,
        runEpoch: s.runEpoch,
        idempotencyKey: randomUUID(),
      },
    );
  };
  await command("startSession", { acknowledgeDesignPreview: true });
  if (!campaign)
    await command("commitAction", {
      actionId: "E1_MAIN",
      waitDurationMs: null,
      reason: "Development preview: enter the market chapter.",
      reasonAnnotation: null,
      basedOnAdviceJobId: null,
      referencedReportIds: [],
      cancelPendingInvestigations: false,
    });
  await app.listen({ host: "127.0.0.1", port });
  console.log(
    `${campaign ? "Campaign" : "Market"} preview (${previewCase}, ${previewLocale}, offline AI): http://127.0.0.1:${port}/?session=${create.sessionId}${campaign ? "&field=1" : ""}`,
  );
  console.log(
    `${campaign ? "The campaign opens at the west gate." : 'Choose "Enter market on foot".'} Ctrl+C stops the preview and clears its temporary data.`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close();
    });
} catch (error) {
  await app.close();
  throw error;
}
