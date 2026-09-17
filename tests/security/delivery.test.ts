import { afterEach, describe, it, expect } from "vitest";
import { readFileSync, readdirSync, lstatSync, existsSync } from "node:fs";
import { resolve, relative, extname } from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { GameService } from "../../server/core/service.js";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";
import { createAiService } from "../../server/ai/index.js";
const root = process.cwd(),
  client = resolve(root, "dist/client");
const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name),
      stat = lstatSync(path);
    if (stat.isSymbolicLink())
      throw new Error(
        `Unexpected symlink in production client: ${relative(client, path)}`,
      );
    return stat.isDirectory() ? files(path) : [path];
  });
}
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const forbiddenKeys = [
  "hiddenRootId",
  "privateCaseId",
  "privateWorld",
  "world_state_json",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "campaign-reference.json",
];
const service: GameService = {
  launchId: "11111111-1111-4111-8111-111111111111",
  lastExecutionReplayed: false,
  async executeWithMeta() {
    throw Error("not used");
  },
  async hasPlayerSessionAccess() {
    return false;
  },
  async listPlayerSessions() {
    return [];
  },
  async execute() {
    throw Error("not used");
  },
  async read() {
    throw Error("not used");
  },
  async getEventsSince() {
    return [];
  },
  async subscribe() {
    return () => {};
  },
  async tick() {},
  async hasSessionAccess() {
    return false;
  },
  startScheduler() {
    return () => {};
  },
  async close() {},
};
describe("production client delivery isolation (run pnpm build first)", () => {
  it("contains no server files, source maps, private campaign records or provider configuration", () => {
    expect(
      existsSync(resolve(client, "index.html")),
      "Build production assets with pnpm build before this suite",
    ).toBe(true);
    const paths = files(client),
      bodies = paths.map((path) => ({
        name: relative(client, path),
        bytes: readFileSync(path),
      }));
    const campaign = JSON.parse(
      readFileSync(
        resolve(root, "docs/engineering_v0.5/content/campaign-reference.json"),
        "utf8",
      ),
    );
    const roots: string[] = [
      ...new Set<string>(
        campaign.cases.flatMap((c: any) =>
          c.evidenceDefinitions.map((e: any) => e.hiddenRootId),
        ),
      ),
    ];
    const authoredHiddenCards: string[] = [
      ...new Set<string>(
        campaign.cases.flatMap((c: any) =>
          c.evidenceDefinitions
            .filter((e: any) => e.acquisition === "investigation")
            .map((e: any) => e.body),
        ),
      ),
    ];
    const englishAuthoredText = JSON.parse(
      readFileSync(resolve(root, "server/core/locales/en-US.json"), "utf8"),
    ) as Record<string, string>;
    const hiddenCards = [
      ...authoredHiddenCards,
      ...authoredHiddenCards
        .map((text) => englishAuthoredText[text])
        .filter(
          (text): text is string => typeof text === "string" && text.length > 0,
        ),
    ];
    for (const b of bodies) {
      expect(
        /(^|\/)(server|docs|\.last-mile|node_modules|\.git)(\/|$)/.test(b.name),
        `Forbidden artifact path: ${b.name}`,
      ).toBe(false);
      expect(
        [".map", ".sqlite", ".db", ".ts", ".tsx"].includes(extname(b.name)),
        `Forbidden extension: ${b.name}`,
      ).toBe(false);
      for (const marker of forbiddenKeys)
        expect(
          b.bytes.includes(Buffer.from(marker)),
          `Private marker ${marker} found in ${b.name}`,
        ).toBe(false);
      expect(
        roots.some((marker) => b.bytes.includes(Buffer.from(marker))),
        `Hidden source ID found in ${b.name}`,
      ).toBe(false);
      expect(
        hiddenCards.some((marker) => b.bytes.includes(Buffer.from(marker))),
        `Unrequested authored investigation text found in ${b.name}`,
      ).toBe(false);
      // Values are never printed, including if this assertion fails.
      expect(
        /sk-(?:proj-|ant-)[A-Za-z0-9_-]{20,}/.test(b.bytes.toString("utf8")),
        `Potential provider credential found in ${b.name}`,
      ).toBe(false);
    }
  });
  it("serves only actual dist/client bytes and never resolves private URLs outside that root", async () => {
    const config = loadHttpConfig({ LAST_MILE_ROOT: root });
    const app = await createHttpApp({
      service,
      config,
      launchToken: "security-test-only-token",
    });
    apps.push(app);
    const headers = { host: "127.0.0.1:3111" };
    const indexHash = hash(readFileSync(resolve(client, "index.html")));
    for (const path of files(client)) {
      const url =
        "/" +
        relative(client, path).split("/").map(encodeURIComponent).join("/");
      const response = await app.inject({ url, headers });
      expect(response.statusCode, `Public artifact unavailable: ${url}`).toBe(
        200,
      );
      expect(hash(response.rawPayload)).toBe(hash(readFileSync(path)));
    }
    const privatePaths = [
      "/.env",
      "/.env.local",
      "/.git/config",
      "/.last-mile/game.sqlite",
      "/package.json",
      "/pnpm-lock.yaml",
      "/server/index.ts",
      "/server/ai/assets/advisor.system.md",
      "/docs/engineering_v0.5/content/campaign-reference.json",
      "/docs/engineering_v0.5/content/scenario.schema.json",
      "/assets/../../server/index.ts",
      "/%2e%2e/server/index.ts",
      "/%2e%2e%2fserver%2findex.ts",
      "/assets/%2e%2e/%2e%2e/server/index.ts",
      `/@fs/${root}/docs/engineering_v0.5/content/campaign-reference.json`,
    ];
    for (const url of privatePaths)
      for (const accept of ["application/json", "text/html"]) {
        const response = await app.inject({
          url,
          headers: { ...headers, accept },
        });
        // SPA history fallback may return index.html. Status 200 alone is not a leak.
        if (response.statusCode === 200)
          expect(
            hash(response.rawPayload),
            `Private URL returned non-shell content: ${url}`,
          ).toBe(indexHash);
        else
          expect(
            [400, 403, 404].includes(response.statusCode),
            `Unexpected private URL status: ${url}`,
          ).toBe(true);
        for (const marker of forbiddenKeys)
          expect(
            response.body.includes(marker),
            `Private marker exposed through ${url}`,
          ).toBe(false);
      }
  });
  it("keeps model configuration server-side and requires both explicit key and model without probing", () => {
    const fetchImpl = (async () => {
      throw Error("Configuration must not contact provider");
    }) as typeof fetch;
    for (const provider of ["openai", "anthropic"] as const) {
      const key =
          provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
        model = provider === "openai" ? "OPENAI_MODEL" : "ANTHROPIC_MODEL";
      const env = {
        MODEL_PROVIDER: provider,
        [key]: "sentinel-server-only-secret",
        [model]: "explicit-test-model",
      };
      const ai = createAiService({ env, fetchImpl });
      expect(ai.configured).toBe(true);
      expect(ai.health().status).toBe("configured");
      expect(
        JSON.stringify(ai.health()).includes("sentinel-server-only-secret"),
      ).toBe(false);
      expect(
        createAiService({
          env: {
            MODEL_PROVIDER: provider,
            [key]: "sentinel-server-only-secret",
          },
          fetchImpl,
        }).configured,
      ).toBe(false);
      expect(
        createAiService({
          env: { MODEL_PROVIDER: provider, [model]: "explicit-test-model" },
          fetchImpl,
        }).configured,
      ).toBe(false);
    }
    expect(
      createAiService({ env: { MODEL_PROVIDER: "offline" }, fetchImpl })
        .configured,
    ).toBe(false);
    const example = readFileSync(resolve(root, ".env.example"), "utf8");
    for (const variable of [
      "MODEL_PROVIDER",
      "OPENAI_API_KEY",
      "OPENAI_MODEL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_MODEL",
    ])
      expect(example.includes(variable + "=")).toBe(true);
  });
});
