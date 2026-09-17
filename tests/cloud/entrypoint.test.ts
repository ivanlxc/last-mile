import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import type * as P from "../../docs/engineering_v0.5/contracts/public.types.js";

const pgUrl = process.env.PG_TEST_URL;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const origin = "https://entrypoint-smoke.invalid";
const host = new URL(origin).host;
const invitation = "synthetic-entrypoint-invitation-only";
const cookieSecret = "synthetic-entrypoint-cookie-secret-not-for-deployment";
const forbiddenNetworkMarker = "ENTRYPOINT_TEST_PROVIDER_NETWORK_FORBIDDEN";

// The real entrypoint, migrations, HTTP server and shutdown hooks run here.
// No dotenv loader or inherited credential environment is used. Even if a
// regression queues an Agent unexpectedly, the child cannot send provider fetches.
const fetchGuard = `globalThis.fetch = async () => {
  process.stderr.write("${forbiddenNetworkMarker}\\n");
  throw new Error("${forbiddenNetworkMarker}");
};`;

async function bounded<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Test loopback port allocation failed");
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

interface ProcessProbe {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  outputBytes: number;
  startupSeen: boolean;
  forbiddenFetchSeen: boolean;
}
function launch(
  databaseUrl: string,
  port: number,
  renderHandoff = false,
): ProcessProbe {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,${encodeURIComponent(fetchGuard)}`,
      "server/index.ts",
    ],
    {
      cwd: repoRoot,
      // Deliberately NOT {...process.env}: no real keys, NODE_OPTIONS, dotenv
      // flags or provider endpoints can enter this process from the developer.
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        LAST_MILE_ROOT: repoRoot,
        LAST_MILE_MODE: "cloud",
        LAST_MILE_PUBLIC_ORIGIN: origin,
        LAST_MILE_INVITE_CODE: invitation,
        LAST_MILE_COOKIE_SECRET: cookieSecret,
        LAST_MILE_HTTP_LOG: "0",
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        ...(renderHandoff ? { RENDER_EXTERNAL_URL: origin } : {}),
        MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "synthetic-test-key-never-send",
        OPENAI_MODEL: "synthetic-test-model-never-call",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const probe: ProcessProbe = {
    child,
    exited: Promise.resolve({ code: null, signal: null }),
    outputBytes: 0,
    startupSeen: false,
    forbiddenFetchSeen: false,
  };
  // Only aggregate counts/known synthetic markers are retained. Raw child logs,
  // connection URLs, HTTP bodies and cookie values are never printed on failure.
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.on("data", (chunk: Buffer) => {
      probe.outputBytes += chunk.length;
      probe.startupSeen ||= chunk.toString().includes(`LAST MILE: ${origin}`);
      probe.forbiddenFetchSeen ||= chunk
        .toString()
        .includes(forbiddenNetworkMarker);
    });
  }
  probe.exited = new Promise((resolve) => {
    child.once("error", () => {
      probe.exit = { code: -1, signal: null };
      resolve(probe.exit);
    });
    child.once("exit", (code, signal) => {
      probe.exit = { code, signal };
      resolve(probe.exit);
    });
  });
  return probe;
}

async function stop(probe: ProcessProbe) {
  if (!probe.exit) probe.child.kill("SIGTERM");
  try {
    return await bounded(probe.exited, 8000, "Entrypoint SIGTERM timed out");
  } catch {
    probe.child.kill("SIGKILL");
    return await bounded(probe.exited, 3000, "Entrypoint cleanup timed out");
  }
}

async function http<T = Record<string, unknown>>(
  port: number,
  path: string,
  options: {
    method?: string;
    cookie?: string;
    body?: unknown;
    key?: string;
    platform?: boolean;
  } = {},
): Promise<{ status: number; data: T; cookies: string[] }> {
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: `${options.platform ? "/_platform" : "/api/v1"}${path}`,
        method: options.method ?? "GET",
        headers: {
          Host: host,
          Origin: origin,
          Connection: "close",
          ...(options.cookie ? { Cookie: options.cookie } : {}),
          ...(options.key ? { "Idempotency-Key": options.key } : {}),
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_048_576)
            req.destroy(new Error("Test response exceeded bound"));
          else chunks.push(chunk);
        });
        response.on("error", () =>
          reject(new Error("Loopback response failed")),
        );
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              data: JSON.parse(Buffer.concat(chunks).toString()) as T,
              cookies: response.headers["set-cookie"] ?? [],
            });
          } catch {
            reject(new Error("Loopback response was not JSON"));
          }
        });
      },
    );
    req.setTimeout(1500, () =>
      req.destroy(new Error("Loopback request timed out")),
    );
    req.on("error", () => reject(new Error("Loopback request failed")));
    req.end(body);
  });
}

async function ready(probe: ProcessProbe, port: number) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (probe.exit)
      throw new Error(
        `Entrypoint exited before readiness (code ${probe.exit.code}; captured ${probe.outputBytes} bytes, contents redacted)`,
      );
    try {
      const health = await http(port, "/health");
      if (health.status === 200) {
        expect(health.data.storageReady).toBe(true);
        expect(health.data.modelConfigured).toBe(true);
        return;
      }
    } catch {
      // The socket is expected to be unavailable during migrations/startup.
    }
    await delay(75);
  }
  throw new Error("Entrypoint did not become ready within 20 seconds");
}

describe.skipIf(!pgUrl)("real cloud entrypoint with PostgreSQL", () => {
  it("persists invitation identity and sealed briefing history across SIGTERM and process restart without model calls", async () => {
    const target = new URL(pgUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
      throw new Error(
        "Entrypoint smoke requires a disposable loopback PG_TEST_URL",
      );
    const admin = new Client({
      connectionString: pgUrl,
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
    });
    const database = `last_mile_entrypoint_${randomUUID().replaceAll("-", "")}`;
    let createdDatabase = false;
    let inspection: Client | undefined;
    let probe: ProcessProbe | undefined;
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${database}`);
      createdDatabase = true;
      target.pathname = `/${database}`;
      let port = await freePort();
      probe = launch(target.href, port);
      await ready(probe, port);
      expect((await http(port, "/access")).data.authenticated).toBe(false);
      const access = await http(port, "/access", {
        method: "POST",
        body: { inviteCode: invitation },
      });
      expect(access.status).toBe(200);
      expect(access.data).toEqual({ authenticated: true, mode: "cloud" });
      expect(access.cookies.length).toBe(1);
      const setCookie = access.cookies[0]!;
      expect(setCookie.startsWith("__Secure-last_mile_player=")).toBe(true);
      for (const flag of [
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
        "Path=/api/v1",
      ])
        expect(setCookie.includes(flag)).toBe(true);
      const cookie = setCookie.split(";")[0]!;
      const bootstrap = await http<P.BootstrapView>(port, "/bootstrap", {
        cookie,
      });
      expect(bootstrap.status).toBe(200);
      const made = await http<P.SessionCreated>(port, "/sessions", {
        method: "POST",
        cookie,
        key: randomUUID(),
        body: {
          profileId: "SINGLE_PLAYER_REFERENCE",
          runPurpose: "design_preview",
          locale: "en-US",
          contentVersionId: bootstrap.data.profiles[0]!.contentVersionId,
        },
      });
      expect(made.status).toBe(201);
      expect(made.data.projection.lifecycle).toBe("created");
      expect(made.data.projection.phase).toBe("briefing");
      expect(made.data.projection.missionTimeMs).toBe(0);
      const sessionId = made.data.sessionId;
      inspection = new Client({
        connectionString: target.href,
        connectionTimeoutMillis: 3000,
        query_timeout: 5000,
      });
      await inspection.connect();
      expect(
        (
          await inspection.query(
            "SELECT COUNT(*)::int AS n FROM agent_attempts",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(await stop(probe)).toEqual({ code: 0, signal: null });
      expect(probe.forbiddenFetchSeen).toBe(false);
      expect(probe.startupSeen).toBe(true);
      probe = undefined;

      port = await freePort();
      probe = launch(target.href, port);
      await ready(probe, port);
      const restoredAccess = await http(port, "/access", { cookie });
      expect(restoredAccess.data).toEqual({
        authenticated: true,
        mode: "cloud",
      });
      expect(restoredAccess.cookies.length).toBe(0);
      const history = await http<{
        sessions: Array<{ sessionId: string; status: string }>;
      }>(port, "/my-sessions", { cookie });
      expect(history.status).toBe(200);
      expect(history.data.sessions).toHaveLength(1);
      expect(history.data.sessions[0]).toMatchObject({
        sessionId,
        status: "sealed",
      });
      const restored = await http<P.SessionProjection>(
        port,
        `/sessions/${sessionId}`,
        { cookie },
      );
      expect(restored.status).toBe(200);
      expect(restored.data.lifecycle).toBe("sealed");
      expect(restored.data.locale).toBe("en-US");
      expect(restored.data.missionTimeMs).toBe(0);
      const outcome = await http<P.OutcomeView>(
        port,
        `/sessions/${sessionId}/outcome`,
        { cookie },
      );
      expect(outcome.status).toBe(200);
      expect(outcome.data.terminationReason).toBe("technical_interruption");
      expect(
        (await inspection.query("SELECT COUNT(*)::int AS n FROM cloud_players"))
          .rows[0].n,
      ).toBe(1);
      expect(
        (
          await inspection.query(
            "SELECT COUNT(*)::int AS n FROM cloud_credentials",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (await inspection.query("SELECT COUNT(*)::int AS n FROM agent_jobs"))
          .rows[0].n,
      ).toBe(0);
      expect(
        (
          await inspection.query(
            "SELECT COUNT(*)::int AS n FROM agent_attempts",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(await stop(probe)).toEqual({ code: 0, signal: null });
      expect(probe.forbiddenFetchSeen).toBe(false);
      expect(probe.startupSeen).toBe(true);
      probe = undefined;
    } finally {
      try {
        if (probe) await stop(probe);
      } finally {
        await inspection?.end();
        try {
          if (createdDatabase)
            await admin.query(
              `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
            );
        } finally {
          await admin.end();
        }
      }
    }
  }, 75000);

  it("holds a Render handoff listener without game access until the old engine releases its lease", async () => {
    const target = new URL(pgUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
      throw new Error(
        "Entrypoint smoke requires a disposable loopback PG_TEST_URL",
      );
    const admin = new Client({
      connectionString: pgUrl,
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
    });
    const database = `last_mile_handoff_${randomUUID().replaceAll("-", "")}`;
    let createdDatabase = false;
    let inspection: Client | undefined;
    let old: ProcessProbe | undefined;
    let replacement: ProcessProbe | undefined;
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE ${database}`);
      createdDatabase = true;
      target.pathname = `/${database}`;
      const oldPort = await freePort();
      old = launch(target.href, oldPort, true);
      await ready(old, oldPort);
      const access = await http(oldPort, "/access", {
        method: "POST",
        body: { inviteCode: invitation },
      });
      expect(access.status).toBe(200);
      expect(access.cookies.length).toBe(1);
      const cookie = access.cookies[0]!.split(";")[0]!;
      const bootstrap = await http<P.BootstrapView>(oldPort, "/bootstrap", {
        cookie,
      });
      expect(bootstrap.status).toBe(200);
      const made = await http<P.SessionCreated>(oldPort, "/sessions", {
        method: "POST",
        cookie,
        key: randomUUID(),
        body: {
          profileId: "SINGLE_PLAYER_REFERENCE",
          runPurpose: "design_preview",
          locale: "en-US",
          contentVersionId: bootstrap.data.profiles[0]!.contentVersionId,
        },
      });
      expect(made.status).toBe(201);
      expect(made.data.projection.phase).toBe("briefing");
      const sessionId = made.data.sessionId;
      const newPort = await freePort();
      replacement = launch(target.href, newPort, true);
      // The first lease attempt is bounded; only then may the platform-only
      // listener report handoff. It must never become a second game engine.
      const handoffDeadline = Date.now() + 20000;
      let handoffSeen = false;
      while (Date.now() < handoffDeadline) {
        if (replacement.exit)
          throw new Error("Replacement exited before handoff readiness");
        try {
          const probe = await http(newPort, "/health", { platform: true });
          handoffSeen = probe.status === 200 && probe.data.status === "handoff";
          if (handoffSeen) break;
        } catch {
          // No listener is expected while the first lease attempt is pending.
        }
        await delay(75);
      }
      expect(handoffSeen).toBe(true);
      for (const path of [
        "/access",
        "/health",
        "/bootstrap",
        "/my-sessions",
        `/sessions/${sessionId}`,
      ])
        expect((await http(newPort, path, { cookie })).status).toBe(503);
      expect(
        (
          await http(newPort, "/access", {
            method: "POST",
            body: { inviteCode: invitation },
          })
        ).status,
      ).toBe(503);
      expect(
        (
          await http(newPort, "/sessions", {
            method: "POST",
            cookie,
            key: randomUUID(),
            body: {},
          })
        ).status,
      ).toBe(503);
      expect((await http(oldPort, "/health")).status).toBe(200);
      const stillOld = await http<P.SessionProjection>(
        oldPort,
        `/sessions/${sessionId}`,
        { cookie },
      );
      expect(stillOld.status).toBe(200);
      expect(stillOld.data.lifecycle).toBe("created");
      expect(stillOld.data.phase).toBe("briefing");
      expect(await stop(old)).toEqual({ code: 0, signal: null });
      expect(old.forbiddenFetchSeen).toBe(false);
      old = undefined;

      await ready(replacement, newPort);
      expect(
        (await http(newPort, "/health", { platform: true })).data.status,
      ).toBe("ready");
      expect(
        (await http(newPort, "/access", { cookie })).data.authenticated,
      ).toBe(true);
      const history = await http<{
        sessions: Array<{ sessionId: string; status: string }>;
      }>(newPort, "/my-sessions", { cookie });
      expect(history.status).toBe(200);
      expect(history.data.sessions).toHaveLength(1);
      expect(history.data.sessions[0]).toMatchObject({
        sessionId,
        status: "sealed",
      });
      const restored = await http<P.SessionProjection>(
        newPort,
        `/sessions/${sessionId}`,
        { cookie },
      );
      expect(restored.status).toBe(200);
      expect(restored.data.lifecycle).toBe("sealed");
      const outcome = await http<P.OutcomeView>(
        newPort,
        `/sessions/${sessionId}/outcome`,
        { cookie },
      );
      expect(outcome.status).toBe(200);
      expect(outcome.data.terminationReason).toBe("technical_interruption");
      inspection = new Client({
        connectionString: target.href,
        connectionTimeoutMillis: 3000,
        query_timeout: 5000,
      });
      await inspection.connect();
      for (const table of ["cloud_players", "cloud_credentials", "sessions"])
        expect(
          (await inspection.query(`SELECT COUNT(*)::int AS n FROM ${table}`))
            .rows[0].n,
        ).toBe(1);
      for (const table of ["agent_jobs", "agent_attempts"])
        expect(
          (await inspection.query(`SELECT COUNT(*)::int AS n FROM ${table}`))
            .rows[0].n,
        ).toBe(0);
      expect(await stop(replacement)).toEqual({ code: 0, signal: null });
      expect(replacement.forbiddenFetchSeen).toBe(false);
      replacement = undefined;
    } finally {
      try {
        if (replacement) await stop(replacement);
      } finally {
        try {
          if (old) await stop(old);
        } finally {
          await inspection?.end();
          try {
            if (createdDatabase)
              await admin.query(
                `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
              );
          } finally {
            await admin.end();
          }
        }
      }
    }
  }, 60000);
});
