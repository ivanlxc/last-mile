import { expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createServer } from "vite";

it("Vite serves Unity compression headers, rejects missing builds and contains assets to the public Unity folder", async () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "last-mile-unity-vite-"));
  const publicDir = resolve(fixture, "public");
  mkdirSync(resolve(publicDir, "unity/Build"), { recursive: true });
  writeFileSync(
    resolve(publicDir, "unity/manifest.json"),
    '{"bridgeVersion":1}',
  );
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  writeFileSync(resolve(publicDir, "unity/Build/test.wasm.gz"), gzipSync(wasm));
  writeFileSync(
    resolve(fixture, "private-fixture.txt"),
    "test-private-sentinel",
  );
  symlinkSync(
    resolve(fixture, "private-fixture.txt"),
    resolve(publicDir, "unity/escape.data"),
  );
  const server = await createServer({
    configFile: resolve(process.cwd(), "vite.config.ts"),
    cacheDir: resolve(fixture, "cache"),
    publicDir,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string")
      throw Error("Missing dev server port");
    const base = `http://127.0.0.1:${address.port}`;
    const asset = await fetch(base + "/unity/Build/test.wasm.gz");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("application/wasm");
    expect(asset.headers.get("content-encoding")).toBe("gzip");
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(wasm);
    const manifest = await fetch(base + "/unity/manifest.json");
    expect(await manifest.json()).toEqual({ bridgeVersion: 1 });
    for (const url of [
      "/unity",
      "/unity/missing.json",
      "/unity/escape.data",
      "/unity/Build/missing.wasm.gz",
    ]) {
      const missing = await fetch(base + url, {
        headers: { accept: "text/html" },
      });
      expect(missing.status, url).toBe(404);
      expect(await missing.text()).not.toContain("test-private-sentinel");
    }
  } finally {
    await server.close();
    rmSync(fixture, { recursive: true, force: true });
  }
}, 20000);
