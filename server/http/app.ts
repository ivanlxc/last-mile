import { asLocale, translateFixed, type Locale } from "../localization.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import fastifyStatic from "@fastify/static";
import type {
  GameService,
  MutationOperation,
  ReadOperation,
  CommandMeta,
} from "../core/service.js";
import type * as Public from "../../docs/engineering_v0.5/contracts/public.types.js";
import { ContractRegistry, type ContractOperation } from "./contracts.js";
import { loadHttpConfig, type HttpConfig } from "./config.js";
import type { Store } from "../core/store.js";
import { AccessLimiter, CloudAuth, type PlayerIdentity } from "./cloud-auth.js";
import { validAccessRequest, validSessionList } from "./cloud-contracts.js";
import {
  isPublicDocumentNavigation,
  requestContextVary,
} from "./request-context.js";
import { isUnityAssetRequest, unityAssetHeaders } from "./unity-assets.js";

export interface HttpAppOptions {
  service: GameService;
  config?: HttpConfig;
  launchToken?: string;
  closeServiceOnClose?: boolean;
  store?: Store;
}
class HttpFailure extends Error {
  constructor(
    readonly code: Public.ErrorCode,
    readonly status: number,
    readonly version: number | null = null,
    readonly retryable = false,
    readonly violations: Public.Problem["violations"] = [],
  ) {
    super(code);
  }
}
const messages: Partial<Record<Public.ErrorCode, string>> = {
  INVALID_REQUEST: "请求格式或字段不符合契约。",
  UNAUTHORIZED: "请先通过本机游戏入口初始化身份。",
  CAPABILITY_DENIED: "当前来源或身份无权执行此操作。",
  RESOURCE_NOT_FOUND: "该公开资源不存在或不属于当前会话。",
  STATE_VERSION_CONFLICT: "状态已更新，请同步后重新确认操作。",
  SCENE_CONFLICT: "当前场景已改变。",
  RUN_EPOCH_CONFLICT: "本局标识已改变。",
  IDEMPOTENCY_KEY_REUSED: "同一请求标识不能用于不同操作。",
  PHASE_NOT_ALLOWED: "当前阶段不允许此操作。",
  POLICY_NOT_APPROVED: "此参考方案尚未批准，请使用明确标识的设计演示。",
  BUDGET_EXHAUSTED: "所需资源不足。",
  REPORT_LIMIT: "本幕上报额度不足。",
  UPLOAD_LIMIT: "本幕上传额度不足。",
  ROLE_BUSY: "该岗位已有进行中的任务。",
  TARGET_NOT_AVAILABLE: "当前没有可用于此请求的目标或资料。",
  REVISION_CONFLICT: "报告版本已改变。",
  NOT_REPORTED: "该资料尚未正式上报。",
  ACTION_NOT_AVAILABLE: "该行动当前不可用。",
  SEALED_HASH_MISMATCH: "终局封存标识不匹配。",
  NOT_TERMINAL: "本局尚未结束。",
  ALREADY_TERMINAL: "本局已经封存。",
  CURSOR_EXPIRED: "事件位置不可恢复，请重新同步。",
  CURSOR_SCOPE_MISMATCH: "事件游标不属于当前会话。",
  MODEL_BUDGET_EXHAUSTED: "本局模型调用额度已用完，仍可查看资料和行动。",
  RATE_LIMITED: "请求过快，请稍后重试。",
  BODY_TOO_LARGE: "请求不能超过64KiB。",
  STORAGE_UNAVAILABLE: "保存暂不可用，请重试原请求。",
  SERVICE_UNAVAILABLE: "服务暂不可用。",
};
function equalSecret(value: string | undefined, expected: string): boolean {
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function cookieValue(
  raw: string | undefined,
  name: string,
): string | undefined {
  if (!raw || raw.length > 8192) return undefined;
  const values = raw
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : undefined;
}
function requestHeader(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

export async function createHttpApp(
  options: HttpAppOptions,
): Promise<FastifyInstance> {
  const config = options.config ?? loadHttpConfig();
  const service = options.service;
  const token = options.launchToken ?? randomBytes(32).toString("hex");
  const contracts = new ContractRegistry(config.repoRoot);
  const streams = new Set<() => void>();
  if (config.mode === "cloud" && !options.store)
    throw new Error("Cloud HTTP requires the shared Store");
  const auth =
    config.mode === "cloud" ? new CloudAuth(options.store!, config) : null;
  const identities = new WeakMap<FastifyRequest, PlayerIdentity>();
  const loginLimiter = new AccessLimiter();
  const playerStreams = new Map<string, number>();
  const app = Fastify({
    bodyLimit: config.bodyLimit,
    trustProxy: false,
    logger: config.logger
      ? {
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "res.headers.set-cookie",
          ],
        }
      : false,
    genReqId: () => randomUUID(),
  });

  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Request-Id", request.id)
      .header("X-Content-Type-Options", "nosniff")
      .header("Vary", requestContextVary)
      .header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const remote = request.ip;
    if (
      config.mode === "local" &&
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)
    )
      throw new HttpFailure("CAPABILITY_DENIED", 403);
    const host = requestHeader(request, "host")?.toLowerCase();
    if (!host || !config.allowedHosts.has(host))
      throw new HttpFailure("CAPABILITY_DENIED", 403);
    const origin = requestHeader(request, "origin");
    if (
      (origin !== undefined && !config.allowedOrigins.has(origin)) ||
      (requestHeader(request, "sec-fetch-site") === "cross-site" &&
        !isPublicDocumentNavigation(
          config.mode,
          request.method,
          request.url,
          request.headers,
        ))
    ) {
      throw new HttpFailure("CAPABILITY_DENIED", 403);
    }
    const path = request.url.split("?")[0];
    if (!path?.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    if (path === "/api/v1/health") return;
    if (auth) {
      // Origin is mandatory for cloud state changes. Never trust forwarded host/IP.
      if (
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        (!origin || !config.allowedOrigins.has(origin))
      )
        throw new HttpFailure("CAPABILITY_DENIED", 403);
      if (
        path === "/api/v1/access" &&
        request.method === "POST" &&
        !loginLimiter.take(request.ip)
      )
        throw new HttpFailure("RATE_LIMITED", 429, null, true);
      if (requestHeader(request, "authorization"))
        throw new HttpFailure("UNAUTHORIZED", 401);
      const identity = await auth.identify(
        cookieValue(requestHeader(request, "cookie"), config.cookieName),
      );
      if (identity) identities.set(request, identity);
      if (path === "/api/v1/access" && ["GET", "POST"].includes(request.method))
        return;
      if (!identity) throw new HttpFailure("UNAUTHORIZED", 401);
      return;
    }
    if (path === "/api/v1/access" && request.method === "GET") return;
    const authorization = requestHeader(request, "authorization");
    const validBearer =
      authorization?.startsWith("Bearer ") &&
      equalSecret(authorization.slice(7), token);
    if (authorization && !validBearer)
      throw new HttpFailure("UNAUTHORIZED", 401);
    const validCookie = equalSecret(
      cookieValue(requestHeader(request, "cookie"), config.cookieName),
      token,
    );
    if (path === "/api/v1/bootstrap" && request.method === "GET") {
      if (!validCookie)
        reply.header(
          "Set-Cookie",
          `${config.cookieName}=${token}; Path=/api/v1; HttpOnly; SameSite=Strict`,
        );
      return;
    }
    if (!validBearer && !validCookie)
      throw new HttpFailure("UNAUTHORIZED", 401);
  });

  async function requestLocale(request: FastifyRequest): Promise<Locale> {
    const sid = record(request.params).sessionId;
    const identity = identities.get(request);
    if (
      typeof sid === "string" &&
      (auth
        ? identity &&
          (await service.hasPlayerSessionAccess(sid, identity.playerId, "read"))
        : await service.hasSessionAccess(sid))
    ) {
      const locale = await service.getSessionLocale?.(sid);
      if (locale) return locale;
    }
    const requested = record(request.body).locale;
    return requested === "en-US" || requested === "zh-CN"
      ? requested
      : /^zh(?:-|,|;|$)/i.test(requestHeader(request, "accept-language") ?? "")
        ? "zh-CN"
        : "en-US";
  }
  function problem(
    error: unknown,
    requestId: string,
    locale: Locale = "en-US",
  ): Public.Problem {
    const e = record(error);
    let code: Public.ErrorCode = "SERVICE_UNAVAILABLE";
    let status = 503;
    let version: number | null = null;
    let retryable = true;
    let violations: Public.Problem["violations"] = [];
    if (error instanceof HttpFailure)
      ({ code, status, version, retryable, violations } = error);
    else if (
      e.name === "DomainError" &&
      typeof e.code === "string" &&
      messages[e.code as Public.ErrorCode]
    ) {
      code = e.code as Public.ErrorCode;
      status = typeof e.status === "number" ? e.status : 422;
      version =
        typeof e.currentStateVersion === "number"
          ? e.currentStateVersion
          : null;
      retryable = e.retryable === true;
    } else if (e.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      code = "BODY_TOO_LARGE";
      status = 413;
      retryable = false;
    } else if (
      e.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      e.code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
      e.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
    ) {
      code = "INVALID_REQUEST";
      status = 400;
      retryable = false;
    } else if (
      e.statusCode === 400 ||
      e.statusCode === 403 ||
      e.statusCode === 404
    ) {
      status = e.statusCode;
      code =
        status === 400
          ? "INVALID_REQUEST"
          : status === 403
            ? "CAPABILITY_DENIED"
            : "RESOURCE_NOT_FOUND";
      retryable = false;
    }
    const detail =
      code === "UNAUTHORIZED" && auth
        ? locale === "zh-CN"
          ? "请先使用邀请口令进入游戏。"
          : "Enter your invitation code to access the game."
        : translateFixed(messages[code] ?? "请求无法完成。", locale);
    return {
      type: `urn:last-mile:problem:${code.toLowerCase().replaceAll("_", "-")}`,
      title: detail,
      status,
      code,
      requestId,
      retryable,
      currentStateVersion: version,
      detail,
      violations,
    };
  }
  app.setErrorHandler(async (error, request, reply) => {
    const locale = await requestLocale(request).catch(() =>
      asLocale(requestHeader(request, "accept-language")),
    );
    const body = problem(error, request.id, locale);
    if (
      body.status === 503 &&
      !(error instanceof HttpFailure) &&
      record(error).name !== "DomainError"
    ) {
      app.log.error(
        { requestId: request.id, errorType: record(error).name },
        "Unhandled request failure",
      );
    }
    if (body.status === 429 || body.status === 503)
      reply.header("Retry-After", "1");
    reply.code(body.status).type("application/problem+json").send(body);
  });

  async function checkAccess(
    op: ContractOperation,
    params: Record<string, string>,
    request: FastifyRequest,
  ): Promise<void> {
    const sessionId = params.sessionId;
    if (!sessionId) return;
    const capability =
      op.operationId === "requestEvaluation"
        ? "evaluation"
        : op.operationId === "createExport"
          ? "export"
          : op.method === "POST"
            ? "command"
            : "read";
    const identity = identities.get(request);
    if (
      !(auth
        ? identity &&
          (await service.hasPlayerSessionAccess(
            sessionId,
            identity.playerId,
            capability,
          ))
        : await service.hasSessionAccess(sessionId, capability))
    )
      throw new HttpFailure("RESOURCE_NOT_FOUND", 404);
  }

  function checkResponse(name: string, value: unknown): void {
    if (contracts.errors(name, value).length)
      throw new HttpFailure("SERVICE_UNAVAILABLE", 503);
  }

  // Platform liveness is distinct from the truthful game/storage readiness endpoint.
  app.get("/_platform/health", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { status: "ready" };
  });

  app.get("/api/v1/access", async (request) => {
    if (Object.keys(record(request.query)).length)
      throw new HttpFailure("INVALID_REQUEST", 400);
    return {
      authenticated: auth ? identities.has(request) : true,
      mode: config.mode,
    };
  });
  app.post("/api/v1/access", async (request, reply) => {
    if (!auth) throw new HttpFailure("RESOURCE_NOT_FOUND", 404);
    if (
      Object.keys(record(request.query)).length ||
      !validAccessRequest(request.body)
    )
      throw new HttpFailure("INVALID_REQUEST", 400);
    if (!auth.validInvite((request.body as { inviteCode: string }).inviteCode))
      throw new HttpFailure("UNAUTHORIZED", 401);
    if (!identities.has(request)) {
      const issued = await auth.issue();
      reply.header("Set-Cookie", issued.cookie);
    }
    return { authenticated: true, mode: config.mode };
  });
  app.get("/api/v1/my-sessions", async (request) => {
    if (!auth) throw new HttpFailure("RESOURCE_NOT_FOUND", 404);
    if (Object.keys(record(request.query)).length)
      throw new HttpFailure("INVALID_REQUEST", 400);
    const sessions = await service.listPlayerSessions(
      identities.get(request)!.playerId,
    );
    if (!validSessionList(sessions))
      throw new HttpFailure("SERVICE_UNAVAILABLE", 503);
    return { sessions };
  });

  async function stream(
    request: FastifyRequest,
    reply: FastifyReply,
    sessionId: string,
    cursor: string | undefined,
  ): Promise<void> {
    const identity = identities.get(request);
    const playerId = identity?.playerId;
    if (
      auth &&
      (streams.size >= 10 || (playerStreams.get(playerId!) ?? 0) >= 2)
    )
      throw new HttpFailure("RATE_LIMITED", 429, null, true);
    let closed = false;
    let started = false;
    let caughtUp = false;
    let bufferBytes = 0;
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let currentCursor = cursor;
    let lastSequence = cursor ? Number(cursor.split(":")[1]) : 0;
    let lastWrite = Date.now();
    const buffered: Public.PublicSseEvent[] = [];
    function close(): void {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      clearInterval(heartbeat);
      clearTimeout(expiry);
      streams.delete(close);
      if (playerId) {
        const left = (playerStreams.get(playerId) ?? 1) - 1;
        if (left) playerStreams.set(playerId, left);
        else playerStreams.delete(playerId);
      }
      if (started) reply.raw.end();
    }
    streams.add(close);
    request.raw.once("aborted", close);
    reply.raw.once("close", close);
    if (playerId)
      playerStreams.set(playerId, (playerStreams.get(playerId) ?? 0) + 1);
    const write = (item: Public.PublicSseEvent) => {
      if (closed || item.viewSequence <= lastSequence) return;
      checkResponse("PublicSseEvent", item);
      const next = `${item.runEpoch}:${item.viewSequence}`;
      if (currentCursor === next) return;
      currentCursor = next;
      lastSequence = item.viewSequence;
      if (reply.raw.writableLength > 1024 * 1024) {
        close();
        return;
      }
      reply.raw.write(
        `id: ${next}\nevent: ${item.eventType}\ndata: ${JSON.stringify(item)}\n\n`,
      );
      lastWrite = Date.now();
    };
    try {
      // Subscribe before reading the durable backlog; buffer events until its cursor is known.
      unsubscribe = await service.subscribe(sessionId, (item) => {
        if (closed) return;
        if (!caughtUp) {
          bufferBytes += Buffer.byteLength(JSON.stringify(item));
          if (buffered.length >= 1000 || bufferBytes > 1024 * 1024) {
            close();
            return;
          }
          buffered.push(item);
          return;
        }
        try {
          write(item);
        } catch {
          close();
        }
      });
      if (closed) {
        unsubscribe();
        throw new HttpFailure("SERVICE_UNAVAILABLE", 503, null, true);
      }
      let initial = await service.getEventsSince(sessionId, cursor);
      if (closed) throw new HttpFailure("SERVICE_UNAVAILABLE", 503, null, true);
      for (const item of initial) checkResponse("PublicSseEvent", item);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Request-Id": request.id,
        "X-Content-Type-Options": "nosniff",
      });
      started = true;
      reply.raw.write("retry: 2000\n\n");
      // Durable reads are paginated at 250. Drain every page before publishing live events.
      let pages = 0;
      while (!closed) {
        for (const item of initial) write(item);
        if (initial.length < 250) break;
        if (++pages >= 100) {
          close();
          return;
        }
        initial = await service.getEventsSince(sessionId, currentCursor);
        for (const item of initial) checkResponse("PublicSseEvent", item);
      }
      if (closed) return;
      for (const item of buffered.sort(
        (a, b) => a.viewSequence - b.viewSequence,
      ))
        write(item);
      buffered.length = 0;
      bufferBytes = 0;
      caughtUp = true;
      // No per-connection DB polling: only the domain publisher and an in-memory heartbeat.
      heartbeat = setInterval(() => {
        if (!closed && Date.now() - lastWrite >= 15000) {
          reply.raw.write(":keepalive\n\n");
          lastWrite = Date.now();
        }
      }, 15000);
      heartbeat.unref();
      if (identity) {
        expiry = setTimeout(
          close,
          Math.max(1, identity.expiresAtMs - Date.now()),
        );
        expiry.unref();
      }
    } catch (error) {
      close();
      if (!started) throw error;
    }
  }

  for (const op of contracts.operations) {
    app.route({
      method: op.method,
      url: op.path.replaceAll(/\{([^}]+)\}/g, ":$1"),
      handler: async (request, reply) => {
        const errors = contracts.requestErrors(
          op,
          request.body,
          request.params,
          request.query,
          request.headers,
        );
        if (errors.length)
          throw new HttpFailure(
            "INVALID_REQUEST",
            400,
            null,
            false,
            errors.slice(0, 20).map((e) => ({
              path: (e.instancePath || "/").slice(0, 160),
              reason:
                e.keyword === "required"
                  ? "required"
                  : e.keyword === "additionalProperties"
                    ? "unknown_property"
                    : e.keyword === "format" || e.keyword === "pattern"
                      ? "format"
                      : e.keyword === "oneOf"
                        ? "invalid_combination"
                        : "range",
            })),
          );
        const params = request.params as Record<string, string>;
        const query = request.query as Record<string, string>;
        await checkAccess(op, params, request);
        if (op.operationId === "streamEvents")
          return stream(
            request,
            reply,
            params.sessionId!,
            requestHeader(request, "last-event-id") ?? query.after,
          );
        let result: unknown;
        if (op.method === "POST") {
          const meta: CommandMeta = {
            idempotencyKey: requestHeader(request, "idempotency-key")!,
            requestId: request.id,
            launchId: service.launchId,
            ...(identities.get(request)
              ? { playerId: identities.get(request)!.playerId }
              : {}),
          };
          if (params.sessionId) meta.sessionId = params.sessionId;
          const epoch = requestHeader(request, "x-run-epoch");
          if (epoch) meta.runEpoch = epoch;
          const execution = await service.executeWithMeta(
            op.operationId as MutationOperation,
            request.body,
            meta,
          );
          result = execution.result;
          reply.header("Idempotency-Replayed", String(execution.replayed));
        } else {
          const id =
            params.taskId ??
            params.reportId ??
            params.jobId ??
            params.operationId ??
            params.exportId;
          result = await service.read(
            op.operationId as ReadOperation,
            params.sessionId,
            id,
            query,
          );
        }
        checkResponse(contracts.responseName(op), result);
        if (
          op.operationId === "getHealth" &&
          record(result).storageReady === false
        )
          throw new HttpFailure("STORAGE_UNAVAILABLE", 503, null, true);
        const location =
          record(result).operationLocation ?? record(result).location;
        if (
          (op.status === 201 || op.status === 202) &&
          typeof location === "string"
        )
          reply.header("Location", location);
        return reply.code(op.status).type("application/json").send(result);
      },
    });
  }

  if (existsSync(resolve(config.clientDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: config.clientDir,
      prefix: "/",
      index: ["index.html"],
      dotfiles: "deny",
      setHeaders(reply, filePath) {
        const assetPath = relative(config.clientDir, filePath)
          .split(sep)
          .join("/");
        if (assetPath.startsWith("unity/"))
          reply.headers(unityAssetHeaders(assetPath));
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        !request.url.startsWith("/api/") &&
        !isUnityAssetRequest(request.url) &&
        request.method === "GET" &&
        (request.headers.accept ?? "").includes("text/html")
      ) {
        return reply.sendFile("index.html");
      }
      throw new HttpFailure("RESOURCE_NOT_FOUND", 404);
    });
  } else
    app.setNotFoundHandler(() => {
      throw new HttpFailure("RESOURCE_NOT_FOUND", 404);
    });
  app.addHook("preClose", async () => {
    for (const close of [...streams]) close();
  });
  app.addHook("onClose", async () => {
    if (options.closeServiceOnClose) await service.close();
  });
  await app.ready();
  return app;
}
