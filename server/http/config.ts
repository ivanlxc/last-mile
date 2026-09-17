import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface HttpConfig {
  repoRoot: string;
  mode: "local" | "cloud";
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  dbPath: string;
  clientDir: string;
  allowedOrigins: ReadonlySet<string>;
  allowedHosts: ReadonlySet<string>;
  cookieName: string;
  bodyLimit: number;
  ssePollMs: number;
  logger: boolean;
  inviteCode?: string;
  cookieSecret?: string;
  databaseUrl?: string;
  publicOrigin?: string;
  limits: {
    maxActiveSessions: number;
    maxSessionsPerPlayerPerDay: number;
    maxModelAttemptsPerDay: number;
    maxConcurrentModelJobs: number;
  };
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
  if (env.LAST_MILE_MODE && !["local", "cloud"].includes(env.LAST_MILE_MODE))
    throw new Error("LAST_MILE_MODE must be local or cloud");
  const mode = env.LAST_MILE_MODE === "cloud" ? "cloud" : "local";
  const positive = (key: string, fallback: number, max: number) => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > max)
      throw new Error(`${key} must be a positive bounded integer`);
    return n;
  };
  const limits = {
    maxActiveSessions: positive("LAST_MILE_MAX_ACTIVE_SESSIONS", 5, 100),
    maxSessionsPerPlayerPerDay: positive(
      "LAST_MILE_MAX_SESSIONS_PER_PLAYER_PER_DAY",
      3,
      100,
    ),
    maxModelAttemptsPerDay: positive("AI_MAX_DAILY_ATTEMPTS", 100, 100000),
    maxConcurrentModelJobs: positive("AI_MAX_CONCURRENT_JOBS", 2, 100),
  };
  if (mode === "cloud") {
    if (!env.DATABASE_URL)
      throw new Error("DATABASE_URL is required in cloud mode");
    const rawOrigin = env.LAST_MILE_PUBLIC_ORIGIN ?? env.RENDER_EXTERNAL_URL;
    if (!rawOrigin)
      throw new Error("An explicit HTTPS public origin is required");
    let url: URL;
    try {
      url = new URL(rawOrigin);
    } catch {
      throw new Error("Invalid public origin");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Public origin must be one exact HTTPS origin");
    if (
      !env.LAST_MILE_INVITE_CODE ||
      env.LAST_MILE_INVITE_CODE.length < 16 ||
      env.LAST_MILE_INVITE_CODE.length > 256
    )
      throw new Error(
        "LAST_MILE_INVITE_CODE must contain 16 to 256 characters",
      );
    if (
      !env.LAST_MILE_COOKIE_SECRET ||
      env.LAST_MILE_COOKIE_SECRET.length < 32 ||
      env.LAST_MILE_COOKIE_SECRET.length > 4096
    )
      throw new Error(
        "LAST_MILE_COOKIE_SECRET must contain 32 to 4096 characters",
      );
    return {
      repoRoot,
      mode,
      host: "0.0.0.0",
      port,
      limits,
      databaseUrl: env.DATABASE_URL,
      publicOrigin: url.origin,
      dbPath: resolve(repoRoot, env.LAST_MILE_DB ?? ".last-mile/game.sqlite"),
      clientDir: resolve(repoRoot, "dist/client"),
      allowedOrigins: new Set([url.origin]),
      allowedHosts: new Set([url.host.toLowerCase()]),
      cookieName: "__Secure-last_mile_player",
      bodyLimit: 65536,
      ssePollMs: 250,
      logger: env.LAST_MILE_HTTP_LOG === "1",
      inviteCode: env.LAST_MILE_INVITE_CODE,
      cookieSecret: env.LAST_MILE_COOKIE_SECRET,
    };
  }
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
    mode,
    limits,
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
