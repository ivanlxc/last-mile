/** Disposable local native playtest. No production DB and no secret enters Unity. */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createGameService,
  type MutationOperation,
} from "../server/core/service.js";
import { createAiService } from "../server/ai/index.js";
import { createHttpApp } from "../server/http/app.js";
import { loadHttpConfig } from "../server/http/config.js";
import type * as P from "../docs/engineering_v0.5/contracts/public.types.js";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : (process.argv[i + 1] ?? fallback);
};
const locale = arg("--locale", "en-US");
const selectedCase = arg("--case", "A");
if (!["en-US", "zh-CN"].includes(locale) || !["A", "B"].includes(selectedCase))
  throw new Error("Use --locale en-US|zh-CN and --case A|B");
const live = process.argv.includes("--live-ai");
const smoke = process.argv.includes("--smoke");
const fault = process.argv.includes("--smoke-fault");
if ((smoke || fault) && live)
  throw new Error("Smoke tests must use offline AI.");
if (fault && !smoke) throw new Error("--smoke-fault requires --smoke.");
// Only the explicitly requested live mode reads local model configuration, in the Node server.
if (live) process.loadEnvFile(resolve(".env"));
if (live && !["openai", "anthropic"].includes(process.env.MODEL_PROVIDER ?? ""))
  throw new Error(
    "Live mode requires MODEL_PROVIDER=openai or anthropic in the server environment.",
  );
const service = await createGameService({
  dbPath: ":memory:",
  recoverOnStartup: false,
  autoTick: true,
  agents: createAiService({ env: live ? process.env : {} }),
  selectCase: () => selectedCase as "A" | "B",
});
const config = loadHttpConfig({ LAST_MILE_ROOT: process.cwd(), PORT: "3114" });
const app = await createHttpApp({ service, config, closeServiceOnClose: true });
let responsesDropped = 0;
let replayObserved = false;
let faultServer: Server | undefined;
const close = async () => {
  faultServer?.closeAllConnections();
  faultServer?.close();
  await app.close();
};
const origin = fault ? "http://127.0.0.1:3115" : "http://127.0.0.1:3114";
try {
  if (
    live &&
    !((await service.read("getHealth")) as P.HealthView).modelConfigured
  )
    throw new Error(
      "Live mode requires a model ID and provider API key in the server configuration.",
    );
  const boot = (await service.read("getBootstrap")) as P.BootstrapView;
  const created = (await service.execute(
    "createSession",
    {
      profileId: "SINGLE_PLAYER_REFERENCE",
      runPurpose: "design_preview",
      locale,
      contentVersionId: boot.profiles[0]!.contentVersionId,
    },
    { idempotencyKey: randomUUID() },
  )) as P.SessionCreated;
  const command = async (op: MutationOperation, payload: unknown) => {
    const s = (await service.read(
      "getSession",
      created.sessionId,
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
  await command("commitAction", {
    actionId: "E1_MAIN",
    waitDurationMs: null,
    reason: "Native development slice: prelude completed by test harness.",
    reasonAnnotation: null,
    basedOnAdviceJobId: null,
    referencedReportIds: [],
    cancelPendingInvestigations: false,
  });
  await app.listen({ host: "127.0.0.1", port: 3114 });
  if (fault) {
    faultServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await app.inject({
        method: req.method === "POST" ? "POST" : "GET",
        url: req.url!,
        headers: { ...req.headers, host: "127.0.0.1:3114" },
        payload: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      if (req.method === "POST" && req.url?.endsWith("/tasks")) {
        if (responsesDropped < 2 && response.statusCode < 300) {
          responsesDropped++;
          res.writeHead(503, { "Content-Type": "application/problem+json" });
          res.end(
            JSON.stringify({
              code: "SERVICE_UNAVAILABLE",
              detail: "Injected response loss after commit.",
            }),
          );
          console.log(
            "NATIVE_FAULT: withheld a committed task response with 503",
          );
          return;
        }
        if (response.headers["idempotency-replayed"] === "true") {
          replayObserved = true;
          console.log("NATIVE_FAULT: exact request replay observed");
        }
      }
      res.writeHead(response.statusCode, response.headers);
      res.end(response.rawPayload);
    });
    await new Promise<void>((done, reject) => {
      faultServer!.once("error", reject);
      faultServer!.listen(3115, "127.0.0.1", done);
    });
  }
  console.log(`Native market: ${origin}  session ${created.sessionId}`);
  console.log(
    `${live ? "LIVE model enabled (provider charges apply)" : "OFFLINE template; no model charges"}. Ephemeral playtest; Ctrl+C discards it.`,
  );
  if (!process.argv.includes("--no-open")) {
    const binary = resolve(
      "unity/LastMileArt/Builds/LastMileArt.app/Contents/MacOS/LAST MILE — Market Art Study",
    );
    if (!existsSync(binary))
      throw new Error("Build the app first with pnpm build:native-art.");
    const args = [
      "--last-mile-server",
      origin,
      "--last-mile-session",
      created.sessionId,
    ];
    if (process.argv.includes("--smoke")) args.push("--last-mile-smoke");
    const child = spawn(binary, args, { stdio: "ignore" });
    child.once("error", () => {
      console.error("Native app could not start.");
      void close();
      process.exitCode = 1;
    });
    child.once("exit", (code) => {
      void close();
      process.exitCode = fault && !replayObserved ? 2 : (code ?? 1);
    });
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void close();
    });
} catch (error) {
  await close();
  throw error;
}
