import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface HttpConfig {
  repoRoot: string;
  host: "127.0.0.1";
  port: number;
  dbPath: string;
  clientDir: string;
  allowedOrigins: ReadonlySet<string>;
  allowedHosts: ReadonlySet<string>;
  cookieName: string;
  bodyLimit: number;
  ssePollMs: number;
  logger: boolean;
}

function discoverRoot(): string {
  for (const candidate of [
    process.cwd(),
    dirname(fileURLToPath(import.meta.url)),
  ]) {
    let path = candidate;
    for (let i = 0; i < 6; i += 1) {
      if (existsSync(resolve(path, "docs/engineering_v0.5/api/openapi.json")))
        return path;
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
  }
  throw new Error(
    "LAST_MILE_ROOT must contain docs/engineering_v0.5/api/openapi.json",
  );
}

export function loadHttpConfig(
  env: NodeJS.ProcessEnv = process.env,
): HttpConfig {
  const repoRoot = resolve(env.LAST_MILE_ROOT ?? discoverRoot());
  const port = Number(env.PORT ?? "3111");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("PORT must be an integer from 1024 to 65535");
  const originStrings = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    ...(env.LAST_MILE_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
  ];
  const allowedOrigins = new Set<string>();
  const allowedHosts = new Set<string>();
  for (const value of originStrings) {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Only explicit loopback origins are allowed");
    }
    allowedOrigins.add(url.origin);
    allowedHosts.add(url.host.toLowerCase());
  }
  return {
    repoRoot,
    host: "127.0.0.1",
    port,
    dbPath: resolve(repoRoot, env.LAST_MILE_DB ?? ".last-mile/game.sqlite"),
    clientDir: resolve(repoRoot, "dist/client"),
    allowedOrigins,
    allowedHosts,
    cookieName: "last_mile_launch",
    bodyLimit: 65536,
    ssePollMs: 250,
    logger: env.LAST_MILE_HTTP_LOG === "1",
  };
}
