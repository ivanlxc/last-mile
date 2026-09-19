import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import type { GameService } from "../../server/core/service.js";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(): Promise<FastifyInstance> {
  const clientDir = mkdtempSync(resolve(tmpdir(), "last-mile-unity-http-"));
  cleanups.push(() => rmSync(clientDir, { recursive: true, force: true }));
  mkdirSync(resolve(clientDir, "unity/Build"), { recursive: true });
  writeFileSync(
    resolve(clientDir, "index.html"),
    "<html>Application shell</html>",
  );
  writeFileSync(
    resolve(clientDir, "unity/manifest.json"),
    '{"bridgeVersion":1}',
  );
  for (const [name, contents] of [
    ["scene.wasm", Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
    ["scene.framework.js", Buffer.from("/* Unity fixture */")],
    ["scene.data", Buffer.from("test-only-scene-data")],
  ] as const) {
    writeFileSync(resolve(clientDir, "unity/Build", name), contents);
    writeFileSync(
      resolve(clientDir, "unity/Build", name + ".gz"),
      gzipSync(contents),
    );
    writeFileSync(
      resolve(clientDir, "unity/Build", name + ".br"),
      brotliCompressSync(contents),
    );
  }
  writeFileSync(
    resolve(clientDir, "unity/Build/scene.data.unityweb"),
    gzipSync("fallback"),
  );
  const app = await createHttpApp({
    service: { launchId: "test-only-launch" } as GameService,
    config: { ...loadHttpConfig({ LAST_MILE_ROOT: process.cwd() }), clientDir },
  });
  cleanups.push(() => app.close());
  return app;
}
const headers = { host: "127.0.0.1:3111" };

describe("Unity Web production hosting", () => {
  it("serves the actual asset type and encoding for uncompressed, gzip and Brotli files", async () => {
    const app = await fixture();
    for (const [name, mime] of [
      ["scene.wasm", "application/wasm"],
      ["scene.framework.js", "application/javascript"],
      ["scene.data", "application/octet-stream"],
    ]) {
      for (const [suffix, encoding] of [
        ["", undefined],
        [".gz", "gzip"],
        [".br", "br"],
      ]) {
        const response = await app.inject({
          url: "/unity/Build/" + name + suffix,
          headers,
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain(mime);
        expect(response.headers["content-encoding"]).toBe(encoding);
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
      }
    }
    const fallback = await app.inject({
      url: "/unity/Build/scene.data.unityweb",
      headers,
    });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.headers["content-encoding"]).toBeUndefined();
    const manifest = await app.inject({ url: "/unity/manifest.json", headers });
    expect(manifest.json()).toEqual({ bridgeVersion: 1 });
    expect(manifest.headers["cache-control"]).toBe("no-cache");
  });

  it("never returns an SPA shell for a missing Unity build, even for an HTML navigation", async () => {
    const app = await fixture();
    for (const url of [
      "/unity",
      "/unity/missing-manifest.json",
      "/unity/Build/missing.wasm?version=2",
      "/unity%2Fmissing.json",
    ]) {
      for (const accept of ["*/*", "text/html"]) {
        const response = await app.inject({
          url,
          headers: { ...headers, accept },
        });
        expect(response.statusCode, url).toBe(404);
        expect(response.headers["content-type"]).toContain(
          "application/problem+json",
        );
        expect(response.json().code).toBe("RESOURCE_NOT_FOUND");
      }
    }
    const historyRoute = await app.inject({
      url: "/game/session",
      headers: { ...headers, accept: "text/html" },
    });
    expect(historyRoute.statusCode).toBe(200);
    expect(historyRoute.body).toContain("Application shell");
  });

  it("permits WASM compilation without eval or cross-origin access changes", async () => {
    const app = await fixture();
    const page = await app.inject({ url: "/", headers });
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(page.headers["cross-origin-opener-policy"]).toBeUndefined();
    expect(page.headers["cross-origin-embedder-policy"]).toBeUndefined();
    for (const hostile of [
      { origin: "https://untrusted.example" },
      { "sec-fetch-site": "cross-site" },
      { host: "untrusted.example" },
    ]) {
      const asset = await app.inject({
        url: "/unity/manifest.json",
        headers: { ...headers, ...hostile },
      });
      expect(asset.statusCode).toBe(403);
    }
    const api = await app.inject({ url: "/api/v1/profiles", headers });
    expect(api.statusCode).toBe(401);
  });
});
