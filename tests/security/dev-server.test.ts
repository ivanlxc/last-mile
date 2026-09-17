import { it, expect } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "vite";
// Uses the actual development configuration but a private ephemeral local port.
// No real key file is read. Each response assertion prints only status/booleans.
it("Vite denies private fs paths including raw/import requests", async () => {
  const root = process.cwd();
  // A security probe must not invalidate the running developer server's
  // optimized dependencies when browser tests execute concurrently.
  const cacheDir = mkdtempSync(resolve(tmpdir(), "last-mile-vite-security-"));
  const server = await createServer({
    configFile: resolve(root, "vite.config.ts"),
    cacheDir,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string")
      throw Error("Missing ephemeral development port");
    const origin = `http://127.0.0.1:${address.port}`;
    const index = await fetch(origin + "/");
    expect(index.status).toBe(200);
    const indexText = await index.text();
    expect(indexText.includes("/src/main.tsx")).toBe(true);
    const privateFiles = [
      "docs/engineering_v0.5/content/campaign-reference.json",
      "server/ai/providers.ts",
      "server/index.ts",
      ".last-mile/game.sqlite",
      ".env",
    ];
    for (const file of privateFiles)
      for (const prefix of ["/@fs", "/@fs/"])
        for (const query of ["", "?raw", "?import"]) {
          const url = origin + prefix + resolve(root, file) + query;
          const response = await fetch(url);
          const text = await response.text();
          if (response.status === 200)
            expect(
              text === indexText,
              `Private development URL returned non-shell content: ${file}${query}`,
            ).toBe(true);
          else
            expect(
              [403, 404].includes(response.status),
              `Development filesystem access was not denied: ${file}${query} (${response.status})`,
            ).toBe(true);
          for (const marker of [
            "hiddenRootId",
            "privateCaseId",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "world_state_json",
          ])
            expect(
              text.includes(marker),
              `Private response marker from ${file}`,
            ).toBe(false);
        }
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}, 20000);
