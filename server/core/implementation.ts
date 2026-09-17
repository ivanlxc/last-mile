import { asLocale, translateFixed, type Locale } from "../localization.js";
import { localizePublic, translatePublicText } from "./locales/index.js";
import { createHash, randomUUID } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import type * as P from "../../docs/engineering_v0.5/contracts/public.types.js";
import type * as A from "../../docs/engineering_v0.5/contracts/agent-derived.types.js";
import {
  DomainError,
  type GameService,
  type GameServiceOptions,
  type Clock,
  type CommandMeta,
  type MutationOperation,
  type ReadOperation,
  type AgentCompletion,
  type AttemptControl,
} from "./service.js";
import {
  World,
  canonical,
  hash,
  type EvidenceDefinition,
  type Plan,
} from "./world.js";
import { createStore, type Store } from "./store.js";
import { buildAdvisorInput } from "../ai/context.js";
import { createAiService } from "../ai/index.js";
import {
  buildEvaluatorInput,
  type FilteredDecisionSlice,
} from "../ai/facts.js";
import {
  questionKeysForTarget,
  publicChannelScopeText,
  cannotConfirmQuestionKeys,
} from "../ai/public-checks.js";
import type {
  State,
  Task,
  Operation,
  InventoryItem,
  Role,
  Channel,
} from "./state.js";
const uid = (): string => randomUUID();
const iso = (n: number) => new Date(n).toISOString();
const active = (v: { status: string }) =>
  ["accepted", "queued", "running"].includes(v.status);
const LIVE = new Set(["briefing", "running"]);
const CHANNELS: Channel[] = ["satellite", "drone", "localAgency", "witness"];
function ERR(
  code: P.ErrorCode,
  status: number,
  message: string,
  s?: State,
): never {
  throw new DomainError(code, status, message, s?.version ?? null);
}
const asyncArray = {
  async map<T, U>(
    values: readonly T[],
    fn: (value: T, index: number) => Promise<U> | U,
  ): Promise<U[]> {
    const out: U[] = [];
    for (let i = 0; i < values.length; i++) out.push(await fn(values[i]!, i));
    return out;
  },
  async filter<T>(
    values: readonly T[],
    fn: (value: T, index: number) => Promise<unknown> | unknown,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < values.length; i++)
      if (await fn(values[i]!, i)) out.push(values[i]!);
    return out;
  },
  async find<T>(
    values: readonly T[],
    fn: (value: T, index: number) => Promise<unknown> | unknown,
  ): Promise<T | undefined> {
    for (let i = 0; i < values.length; i++)
      if (await fn(values[i]!, i)) return values[i];
  },
  async some<T>(
    values: readonly T[],
    fn: (value: T, index: number) => Promise<unknown> | unknown,
  ): Promise<boolean> {
    for (let i = 0; i < values.length; i++)
      if (await fn(values[i]!, i)) return true;
    return false;
  },
  async every<T>(
    values: readonly T[],
    fn: (value: T, index: number) => Promise<unknown> | unknown,
  ): Promise<boolean> {
    for (let i = 0; i < values.length; i++)
      if (!(await fn(values[i]!, i))) return false;
    return true;
  },
  async flatMap<T, U>(
    values: readonly T[],
    fn: (value: T, index: number) => Promise<U[]> | U[],
  ): Promise<U[]> {
    return (await this.map(values, fn)).flat();
  },
  async forEach<T>(
    values: readonly T[],
    fn: (value: T, index: number) => Promise<void> | void,
  ): Promise<void> {
    for (let i = 0; i < values.length; i++) await fn(values[i]!, i);
  },
};
const defaultClock: Clock = {
  nowMs: () => Date.now(),
  monotonicMs: () => performance.now(),
};
export async function createGameService(
  options: GameServiceOptions = {},
): Promise<GameService> {
  const store =
    options.store ??
    (await createStore({
      dbPath: options.dbPath,
      databaseUrl: options.databaseUrl,
    }));
  const service = new CoreGameService(options, store);
  try {
    await service.initialize();
    return service;
  } catch (error) {
    if (!options.store) await store.close();
    throw error;
  }
}
export class CoreGameService implements GameService {
  readonly launchId: string;
  lastExecutionReplayed = false;
  private readonly store: Store;
  private readonly world: World;
  private readonly clock: Clock;
  private readonly options: GameServiceOptions;
  private readonly anchors = new Map<
    string,
    { mono: number; mission: number }
  >();
  private readonly listeners = new Map<
    string,
    Map<(e: P.PublicSseEvent) => void, number>
  >();
  private readonly lastClockSamples = new Map<string, number>();
  private readonly dispatched = new Set<string>();
  private readonly granted = new Set<string>();
  private readonly liveSessions = new Set<string>();
  private serialTail: Promise<void> = Promise.resolve();
  private readonly detached = new AsyncResource("last-mile-background");
  private jobsPending = false;
  private dispatchScheduled = false;
  private schedulerBusy = false;
  private storageFailed = false;
  private closed = false;
  private closing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private contentVersionId!: string;
  constructor(options: GameServiceOptions, store: Store) {
    this.options = {
      ...options,
      agents: options.agents ?? createAiService({ env: {} }),
    };
    this.clock = options.clock ?? defaultClock;
    this.world = new World(
      options.contentDir ??
        fileURLToPath(
          new URL("../../docs/engineering_v0.5/content", import.meta.url),
        ),
    );
    this.store = store;
    this.launchId = options.launchId ?? uid();
  }
  private storageFailure(error: unknown) {
    const code = (error as { code?: string })?.code;
    if (
      this.storageFailed ||
      this.closed ||
      this.closing ||
      !(code === "STORAGE_CONNECTION_LOST" || code === "STORAGE_UNAVAILABLE")
    )
      return;
    // A COMMIT may have reached storage even when its acknowledgement was lost.
    // Freeze this process rather than guessing whether to replay game writes.
    this.storageFailed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.detached.runInAsyncScope(() =>
      queueMicrotask(() => {
        try {
          this.options.onStorageFailure?.();
        } catch {
          /* Host handles restart. */
        }
      }),
    );
  }
  private serialized<T>(fn: () => Promise<T>, allowFailed = false): Promise<T> {
    const result = this.serialTail.then(async () => {
      if (this.storageFailed && !allowFailed)
        throw new DomainError(
          "STORAGE_UNAVAILABLE",
          503,
          "Storage is unavailable. Please retry after the service restarts.",
          null,
          true,
        );
      try {
        return await fn();
      } catch (error) {
        this.storageFailure(error);
        throw error;
      }
    });
    this.serialTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  execute(operationId: MutationOperation, body: unknown, meta: CommandMeta) {
    return this.executeWithMeta(operationId, body, meta).then((x) => x.result);
  }
  executeWithMeta(
    operationId: MutationOperation,
    body: unknown,
    meta: CommandMeta,
  ) {
    return this.serialized(async () => {
      const result = await this.executeInternal(operationId, body, meta);
      return { result, replayed: this.lastExecutionReplayed };
    });
  }
  read(
    operationId: ReadOperation,
    sessionId?: string,
    id?: string,
    query: Record<string, string | number | undefined> = {},
  ) {
    return this.serialized(
      () => this.readInternal(operationId, sessionId, id, query),
      operationId === "getHealth",
    );
  }
  tick(sessionId?: string) {
    return this.serialized(() => this.tickInternal(sessionId));
  }
  getSessionLocale(id: string) {
    return this.serialized(() => this.getSessionLocaleInternal(id));
  }
  hasSessionAccess(
    id: string,
    capability: "read" | "command" | "evaluation" | "export" = "read",
  ) {
    return this.serialized(() => this.hasSessionAccessInternal(id, capability));
  }
  getEventsSince(id: string, cursor?: string) {
    return this.serialized(() => this.getEventsSinceInternal(id, cursor));
  }
  subscribe(id: string, listener: (event: P.PublicSseEvent) => void) {
    return this.serialized(() => this.subscribeInternal(id, listener));
  }
  close() {
    return this.serialized(() => this.closeInternal(), true);
  }
  hasPlayerSessionAccess(
    id: string,
    playerId: string,
    capability: "read" | "command" | "evaluation" | "export" = "read",
  ) {
    return this.serialized(() => this.playerAccess(id, playerId, capability));
  }
  private async playerAccess(
    id: string,
    playerId: string,
    capability: "read" | "command" | "evaluation" | "export",
  ) {
    if (!playerId || this.closed) return false;
    const owner = await this.store.one(
      "SELECT player_id FROM cloud_sessions WHERE session_id=? AND player_id=?",
      id,
      playerId,
    );
    if (!owner) return false;
    const s = await this.load(id);
    if (!this.granted.has(id)) {
      if (LIVE.has(s.lifecycle)) return false;
      await this.grant(s, false);
    }
    return this.hasSessionAccessInternal(id, capability);
  }
  listPlayerSessions(playerId: string) {
    return this.serialized(async () => {
      if (!playerId || this.closed) return [];
      const rows = await this.store.all(
        "SELECT s.session_id,s.lifecycle,s.created_at_ms,s.updated_at_ms,m.locale FROM cloud_sessions c JOIN sessions s ON s.session_id=c.session_id JOIN runtime_session_meta m ON m.session_id=s.session_id WHERE c.player_id=? ORDER BY s.updated_at_ms DESC LIMIT 100",
        playerId,
      );
      return rows.map((row) => ({
        sessionId: row.session_id,
        locale: asLocale(row.locale),
        status:
          row.lifecycle === "briefing"
            ? ("created" as const)
            : row.lifecycle === "running"
              ? ("active" as const)
              : ("sealed" as const),
        createdAt: iso(row.created_at_ms),
        updatedAt: iso(row.updated_at_ms),
      }));
    });
  }
  private scheduleDispatch() {
    if (
      this.closed ||
      this.closing ||
      this.storageFailed ||
      !this.jobsPending ||
      this.dispatchScheduled
    )
      return;
    if (
      this.dispatched.size >=
      (this.options.cloud?.maxConcurrentModelJobs ?? Number.POSITIVE_INFINITY)
    )
      return;
    this.dispatchScheduled = true;
    this.detached.runInAsyncScope(() =>
      queueMicrotask(() => {
        void this.serialized(() => this.dispatch())
          .catch(() => {
            // Do not log database statements, connection strings, or provider inputs.
            console.error("Agent scheduling unavailable");
          })
          .finally(() => {
            this.dispatchScheduled = false;
          });
      }),
    );
  }
  async initialize() {
    const options = this.options;
    await this.store.transaction(async () => {
      let content = await this.store.one(
        "SELECT * FROM content_versions WHERE content_hash=?",
        this.world.contentHash,
      );
      if (!content) {
        await this.store.insert("content_versions", {
          content_version_id: uid(),
          content_hash: this.world.contentHash,
          schema_version: "0.5",
          registry_json: canonical(this.world.campaign),
          created_at_ms: this.clock.nowMs(),
        });
        content = await this.store.one(
          "SELECT * FROM content_versions WHERE content_hash=?",
          this.world.contentHash,
        );
      }
      this.contentVersionId = content.content_version_id;
      if (
        !(await this.store.one(
          "SELECT 1 FROM policy_profiles WHERE policy_hash=?",
          this.world.policyHash,
        ))
      ) {
        const v =
          ((
            await this.store.one(
              "SELECT MAX(profile_version) AS v FROM policy_profiles",
            )
          )?.v ?? 0) + 1;
        await this.store.insert("policy_profiles", {
          policy_hash: this.world.policyHash,
          profile_id: "SINGLE_PLAYER_REFERENCE",
          profile_version: v,
          approval_status: "review",
          policy_json: canonical(this.world.policy),
          created_at_ms: this.clock.nowMs(),
        });
      }
      await this.store.insert("launches", {
        launch_id: this.launchId,
        token_hash: options.tokenHash ?? hash(uid()),
        started_at_ms: this.clock.nowMs(),
      });
    });
    this.contentVersionId = (
      await this.store.one(
        "SELECT content_version_id FROM content_versions WHERE content_hash=?",
        this.world.contentHash,
      )
    ).content_version_id;
    if (options.recoverOnStartup !== false) await this.recover();
    for (const id of options.resumeSessionIds ?? []) {
      const s = await this.load(id);
      if (LIVE.has(s.lifecycle))
        ERR("NOT_TERMINAL", 422, "只能只读打开已封存历史", s);
      await this.grant(s, false);
    }
    if (options.autoTick) this.startScheduler();
  }
  private async load(id: string): Promise<State> {
    const row = await this.store.one(
      "SELECT world_state_json FROM sessions WHERE session_id=?",
      id,
    );
    if (!row) ERR("RESOURCE_NOT_FOUND", 404, "找不到此会话");
    return JSON.parse(row.world_state_json);
  }
  private async row(id: string) {
    return await this.store.one(
      "SELECT * FROM sessions WHERE session_id=?",
      id,
    );
  }
  private missionNow(s: State) {
    if (s.lifecycle !== "running") return s.mission;
    const a = this.anchors.get(s.sessionId);
    return a
      ? Math.max(
          s.mission,
          Math.min(
            600000,
            Math.floor(
              a.mission + Math.max(0, this.clock.monotonicMs() - a.mono),
            ),
          ),
        )
      : s.mission;
  }
  private async save(s: State) {
    await this.store.run(
      "UPDATE sessions SET lifecycle=?,phase=?,scene_id=?,state_version=?,inbox_version=?,assistant_context_version=?,mission_ms=?,world_state_json=?,terminal_seal_id=?,updated_at_ms=? WHERE session_id=?",
      s.lifecycle,
      s.phase,
      s.sceneId,
      s.version,
      s.inboxVersion,
      s.contextVersion,
      s.mission,
      canonical(s),
      s.outcome
        ? (
            await this.store.one(
              "SELECT seal_id FROM terminal_seals WHERE session_id=?",
              s.sessionId,
            )
          )?.seal_id
        : null,
      this.clock.nowMs(),
      s.sessionId,
    );
    if (LIVE.has(s.lifecycle)) this.liveSessions.add(s.sessionId);
    else this.liveSessions.delete(s.sessionId);
  }
  private async tx<T>(fn: () => Promise<T> | T): Promise<T> {
    const anchors = new Map(
      [...this.anchors].map(([id, value]) => [id, { ...value }]),
    );
    const granted = new Set(this.granted),
      live = new Set(this.liveSessions),
      samples = new Map(this.lastClockSamples);
    const jobsPending = this.jobsPending;
    try {
      return await this.store.transaction(fn);
    } catch (e) {
      this.anchors.clear();
      for (const [k, v] of anchors) this.anchors.set(k, v);
      this.granted.clear();
      for (const id of granted) this.granted.add(id);
      this.liveSessions.clear();
      for (const id of live) this.liveSessions.add(id);
      this.lastClockSamples.clear();
      for (const [k, v] of samples) this.lastClockSamples.set(k, v);
      this.jobsPending = jobsPending;
      if (e instanceof DomainError) throw e;
      if ((e as Error).message?.includes("database is locked"))
        throw new DomainError(
          "STORAGE_UNAVAILABLE",
          503,
          "本机数据库正在处理另一项提交，请用同一请求键重试",
          null,
          true,
        );
      throw e;
    }
  }
  private async hasSessionAccessInternal(
    id: string,
    capability: "read" | "command" | "evaluation" | "export" = "read",
  ) {
    if (!this.granted.has(id)) return false;
    if (capability === "command") {
      const row = await this.row(id);
      return row?.launch_id === this.launchId;
    }
    return true;
  }
  private async authorize(id: string) {
    if (!(await this.hasSessionAccessInternal(id)))
      ERR("CAPABILITY_DENIED", 403, "此启动实例未获该会话访问权限");
  }
  private async grant(s: State, command: boolean) {
    await this.tx(async () => {
      for (const cap of [
        "commander.read",
        "evaluation.request",
        "export.request",
        ...(command ? ["commander.command"] : []),
      ])
        await this.store.run(
          "INSERT OR IGNORE INTO launch_session_access(launch_id,session_id,binding_id,capability,granted_at_ms) VALUES(?,?,?,?,?)",
          this.launchId,
          s.sessionId,
          s.actors.commander,
          cap,
          this.clock.nowMs(),
        );
    });
    this.granted.add(s.sessionId);
  }
  private async event(
    s: State,
    kind: string,
    data: unknown,
    actor: "human" | "npc" | "rules" | "system" = "rules",
    binding?: string,
    requestId?: string,
  ) {
    const seq = (await this.row(s.sessionId)).last_event_seq + 1;
    const eventId = uid();
    await this.store.insert("events", {
      session_id: s.sessionId,
      seq,
      event_id: eventId,
      kind,
      mission_ms: s.mission,
      state_version: s.version,
      actor_kind: actor,
      binding_id: binding ?? null,
      request_id: requestId ?? null,
      payload_json: canonical(data),
      recorded_at_ms: this.clock.nowMs(),
    });
    return { seq, eventId };
  }
  private log(
    s: State,
    kind: P.PublicLogEntry["kind"],
    summary: string,
    actor: P.PublicLogEntry["actor"] = "rules",
    reportIds: string[] = [],
    jobId: string | null = null,
  ) {
    s.publicLog.push({
      logId: uid(),
      sequence: s.publicLog.length + 1,
      missionTimeMs: s.mission,
      kind,
      actor,
      summary,
      reportIds,
      jobId,
    });
  }
  private async cursor(s: State) {
    return (
      await this.store.one(
        "SELECT COALESCE(MAX(cursor),0) AS n FROM view_events WHERE session_id=? AND view_role='commander'",
        s.sessionId,
      )
    ).n as number;
  }
  private async publicEvent(
    s: State,
    eventType: P.PublicSseEvent["eventType"],
    data: any,
  ) {
    const n = (await this.cursor(s)) + 1;
    if (eventType === "projection.changed")
      data.lastViewCursor = await this.cursorString(s, n);
    const e = {
      eventType,
      sessionId: s.sessionId,
      runEpoch: s.runEpoch,
      viewSequence: n,
      stateVersion: s.version,
      data: localizePublic(data, asLocale(s.locale)),
    } as P.PublicSseEvent;
    await this.store.insert("view_events", {
      session_id: s.sessionId,
      view_role: "commander",
      cursor: n,
      source_seq: (await this.row(s.sessionId)).last_event_seq,
      event_type: eventType,
      public_payload_json: canonical(e),
    });
    return e;
  }
  private async cursorString(s: State, n?: number) {
    n ??= await this.cursor(s);
    return `${s.runEpoch}:${n}`;
  }
  private async flush(sid: string) {
    const listeners = this.listeners.get(sid);
    if (listeners)
      for (const [listener] of listeners) {
        while (listeners.has(listener)) {
          const after = listeners.get(listener)!;
          const events = (
            await this.store.all(
              "SELECT public_payload_json FROM view_events WHERE session_id=? AND view_role='commander' AND cursor>? ORDER BY cursor LIMIT 250",
              sid,
              after,
            )
          ).map(
            (row) => JSON.parse(row.public_payload_json) as P.PublicSseEvent,
          );
          for (const event of events) {
            if (!listeners.has(listener)) break;
            if (event.viewSequence <= listeners.get(listener)!) continue;
            // Advance before callbacks: a callback may synchronously execute a command.
            listeners.set(listener, event.viewSequence);
            try {
              listener(event);
            } catch {
              /* subscribers cannot roll back committed state */
            }
          }
          if (events.length < 250) break;
        }
      }
    this.scheduleDispatch();
  }
  private async account(s: State, key: string) {
    return await this.store.one(
      "SELECT * FROM quota_accounts WHERE session_id=? AND account_id=?",
      s.sessionId,
      s.accounts[key],
    );
  }
  private async ledger(
    s: State,
    key: string,
    kind: "reserve" | "spend" | "release" | "refund",
    amount = 1,
    parent: string | null = null,
    operation = uid(),
    reason = "DOMAIN_COMMAND",
  ) {
    const q = await this.account(s, key);
    if (!q) throw Error("Missing quota account");
    const entry = uid();
    let delta: number[], bucket: string;
    if (kind === "reserve") {
      delta = [-amount, amount, 0];
      bucket = "available";
    } else if (kind === "release") {
      delta = [amount, -amount, 0];
      bucket = "reserved";
    } else if (kind === "refund") {
      delta = [amount, 0, -amount];
      bucket = "spent";
    } else if (parent) {
      delta = [0, -amount, amount];
      bucket = "reserved";
    } else {
      delta = [-amount, 0, amount];
      bucket = "available";
    }
    if (
      (bucket === "available" && q.available < amount) ||
      (bucket === "reserved" && q.reserved < amount)
    )
      ERR(
        key.endsWith("upload")
          ? "UPLOAD_LIMIT"
          : key.endsWith("report")
            ? "REPORT_LIMIT"
            : "BUDGET_EXHAUSTED",
        422,
        "可用额度不足",
        s,
      );
    await this.store.insert("quota_ledger", {
      session_id: s.sessionId,
      entry_id: entry,
      account_id: q.account_id,
      operation_id: operation,
      entry_kind: kind,
      source_bucket: bucket,
      amount,
      delta_available: delta[0],
      delta_reserved: delta[1],
      delta_spent: delta[2],
      account_version_before: q.account_version,
      parent_entry_id: parent,
      reason_code: reason,
      mission_ms: s.mission,
      created_at_ms: this.clock.nowMs(),
    });
    return entry;
  }
  private async reportQuota(
    s: State,
    scene: P.SceneId,
    role: Role,
  ): Promise<P.ReportQuota> {
    const q = await this.account(s, `${scene}:${role}:report`);
    return {
      role,
      sceneId: scene,
      limit: 3,
      used: q.spent,
      reserved: q.reserved,
      remaining: q.available,
    };
  }
  private async uploadQuota(s: State): Promise<P.UploadQuota | null> {
    if (!s.sceneId) return null;
    const q = await this.account(s, `${s.sceneId}:commander:upload`);
    return {
      sceneId: s.sceneId,
      mode: "cumulative",
      limit: 5,
      used: q.spent,
      remaining: q.available,
    };
  }
  private op(s: State) {
    return s.operations.find((o) => active(o.view));
  }
  private location(s: State, at = s.mission): P.KnownLocation {
    const op = this.op(s);
    if (!op) return s.location;
    const step = op.steps[op.index];
    return step ? this.world.location(step, at) : s.location;
  }
  private operationView(
    s: State,
    op: Operation,
    at = this.missionNow(s),
  ): P.OperationView {
    return {
      ...op.view,
      currentLocation: active(op.view)
        ? this.location(s, at)
        : op.view.currentLocation,
    };
  }
  private pending(s: State): P.PendingTasks {
    return {
      manifest: s.flags.manifestPending ? "pending" : "completed",
      inspection: s.flags.inspectionPending ? "pending" : "notRequired",
    };
  }
  private async publicRecord(
    s: State,
    key: string,
    kind: "report" | "advice" | "briefing" | "sceneFeedback",
    payload: any,
  ) {
    const old = await this.store.one(
      "SELECT public_record_id FROM runtime_display_bindings WHERE session_id=? AND record_key=?",
      s.sessionId,
      key,
    );
    if (old) return old.public_record_id;
    const recordId = uid();
    await this.store.insert("public_records", {
      session_id: s.sessionId,
      public_record_id: recordId,
      revision: 1,
      view_role: "commander",
      record_kind: kind,
      source_seq: (await this.row(s.sessionId)).last_event_seq,
      public_payload_json: canonical(
        localizePublic(payload, asLocale(s.locale)),
      ),
    });
    await this.store.run(
      "INSERT OR REPLACE INTO runtime_display_bindings VALUES(?,?,?,1)",
      s.sessionId,
      key,
      recordId,
    );
    return recordId;
  }
  private async projection(s: State): Promise<P.SessionProjection> {
    const now = this.missionNow(s),
      op = this.op(s);
    const rows = await this.store.all(
      "SELECT * FROM quota_accounts WHERE session_id=? AND quota_scope=?",
      s.sessionId,
      "session",
    );
    const uploads = s.uploads.filter((u) => u.sceneId === s.sceneId);
    const reports = s.reports.filter((r) => r.sceneId === s.sceneId);
    return {
      sessionId: s.sessionId,
      locale: asLocale(s.locale),
      runEpoch: s.runEpoch,
      profileId: "SINGLE_PLAYER_REFERENCE",
      runPurpose: s.runPurpose,
      policyHash: this.world.policyHash,
      contentVersionId: this.contentVersionId,
      stateVersion: s.version,
      lifecycle:
        s.lifecycle === "briefing"
          ? "created"
          : s.lifecycle === "running"
            ? "active"
            : "sealed",
      phase:
        s.phase === "briefing"
          ? "briefing"
          : s.phase === "decision"
            ? "scene"
            : s.phase === "terminal"
              ? "terminal"
              : "resolving",
      sceneId: s.sceneId,
      missionTimeMs: now,
      missionDeadlineMs: 600000,
      serverNow: iso(this.clock.nowMs()),
      location: this.location(s, now),
      civilianCount: 20,
      medical: s.medical,
      pendingTasks: this.pending(s),
      resources: rows.map((q) => ({
        role: q.role,
        channel: q.resource,
        initial: q.capacity,
        remaining: q.available,
        spent: q.spent,
        scope: "session",
      })),
      reportQuotas: await asyncArray.map(
        ["analyst", "liaison"] as const,
        async (r) => await this.reportQuota(s, s.sceneId ?? "E1", r),
      ),
      uploadQuota: await this.uploadQuota(s),
      reports,
      sceneUploads: uploads,
      inboxVersion: s.inboxVersion,
      assistantContextVersion: s.contextVersion,
      activeTasks: s.tasks.filter((t) => active(t.view)).map((t) => t.view),
      activeOperation: op ? this.operationView(s, op, now) : null,
      taskOptions: await this.taskOptions(s),
      actionOptions: this.actionOptions(s),
      latestAdviceJob: await this.currentJob(s),
      unuploadedReportIds: reports
        .filter((r) => !uploads.some((u) => u.reportId === r.reportId))
        .map((r) => r.reportId),
      lastViewCursor: await this.cursorString(s),
      sealedHash: s.outcome?.sealedHash ?? null,
    };
  }
  private async taskOptions(s: State): Promise<P.TaskOption[]> {
    if (!s.sceneId) return [];
    const defs = this.world
      .case(s.caseId)
      .evidenceDefinitions.filter(
        (d) => d.sceneId === s.sceneId && d.acquisition === "investigation",
      );
    const make = async (
      d: EvidenceDefinition,
      trace = false,
    ): Promise<P.TaskOption> => {
      const role = trace ? "liaison" : d.sourceRole,
        channel = (trace ? d.traceCostChannel : d.channel) as Channel;
      const locked = s.lifecycle !== "running" || s.phase !== "decision",
        busy = s.tasks.some(
          (t) => t.view.targetRole === role && active(t.view),
        );
      const q = await this.reportQuota(s, s.sceneId!, role);
      const reason = locked
        ? "phase_locked"
        : busy
          ? "role_busy"
          : q.remaining === 0
            ? "no_report_slot"
            : (await this.account(s, channel)).available === 0
              ? "no_resource"
              : null;
      return {
        targetId: trace ? `${d.definitionId}.trace` : d.definitionId,
        topicId: d.topicId,
        targetRole: role,
        label: trace ? `核验来源：${d.title}` : d.title,
        investigationKind: trace
          ? "provenance_trace"
          : this.world.kind(channel),
        resourceChannel: channel,
        cost: {
          knownDurationMs: trace
            ? 15000
            : this.world.policy.investigationDurationMs[channel],
          uncertainty: "none",
          description: trace
            ? "调查传播链，不自动证明说法内容"
            : publicChannelScopeText(channel) +
              " 观察到期后交付，并占用一格上报额度",
        },
        available: reason === null,
        disabledReason: reason,
      };
    };
    const traces = s.reports
      .filter((r) => r.sceneId === s.sceneId)
      .map((r) =>
        this.world
          .case(s.caseId)
          .evidenceDefinitions.find(
            (d) => d.definitionId === r.card.definitionId,
          ),
      )
      .filter((d): d is EvidenceDefinition => !!d?.traceCostChannel);
    return [
      ...(await asyncArray.map(defs, (d) => make(d))),
      ...(await asyncArray.map(
        Array.from(new Map(traces.map((d) => [d.definitionId, d])).values()),
        (d) => make(d, true),
      )),
    ];
  }
  private actionOptions(s: State): P.ActionOption[] {
    if (!s.sceneId) return [];
    const locked =
      s.lifecycle !== "running" || s.phase !== "decision" || !!this.op(s);
    const list = this.world.publicActions
      .filter((a) => a.sceneId === s.sceneId)
      .map((a) => {
        const refused = a.actionId === "E3_BRIDGE" && s.flags.bridgeRefused;
        return {
          actionId: a.actionId,
          label: a.label,
          kind: "route",
          knownRouteIds: a.knownRouteIds,
          cost: {
            knownDurationMs: a.knownDurationMs,
            uncertainty: a.uncertainty,
            description: "公开基础时间；未知现场条件可能带来额外等待",
          },
          knownRisk: a.knownRisk,
          irreversibleNotice:
            "确认后车队执行整段路线；未完成的调查将取消，已用渠道不返还。",
          available: !locked && !refused,
          disabledReason: locked
            ? "phase_locked"
            : refused
              ? "recovery_used"
              : null,
        };
      }) as P.ActionOption[];
    list.push({
      actionId: "WAIT",
      label: "原地等待",
      kind: "wait",
      knownRouteIds: [],
      cost: {
        knownDurationMs: null,
        uncertainty: "none",
        description: "选择 15、30 或 60 秒；调查继续运行",
      },
      knownRisk: "等待会使用任务剩余时间。",
      irreversibleNotice: null,
      available: !locked,
      disabledReason: locked ? "phase_locked" : null,
    });
    return list;
  }
  private async getSessionLocaleInternal(id: string): Promise<Locale | null> {
    return (await this.hasSessionAccessInternal(id))
      ? asLocale((await this.load(id)).locale)
      : null;
  }
  private async executeInternal(
    operationId: MutationOperation,
    body: unknown,
    meta: CommandMeta,
  ): Promise<unknown> {
    if (this.options.cloud) {
      if (!meta.playerId)
        ERR("UNAUTHORIZED", 401, "A persistent visitor identity is required.");
      if (meta.sessionId) {
        const capability =
          operationId === "requestEvaluation"
            ? "evaluation"
            : operationId === "createExport"
              ? "export"
              : "command";
        if (
          !(await this.playerAccess(meta.sessionId, meta.playerId, capability))
        )
          ERR("RESOURCE_NOT_FOUND", 404, "Session not found.");
      }
    }
    const locale = meta.sessionId
      ? ((await this.getSessionLocaleInternal(meta.sessionId)) ?? "en-US")
      : asLocale((body as any)?.locale);
    try {
      return localizePublic(
        await this.executeCanonical(operationId, body, meta),
        locale,
      );
    } catch (error) {
      if (error instanceof DomainError)
        error.message = translateFixed(error.message, locale);
      throw error;
    }
  }
  private async executeCanonical(
    operationId: MutationOperation,
    body: unknown,
    meta: CommandMeta,
  ): Promise<unknown> {
    this.lastExecutionReplayed = false;
    if (this.closed || this.closing)
      ERR("SERVICE_UNAVAILABLE", 503, "服务已停止");
    if (!meta.idempotencyKey) ERR("INVALID_REQUEST", 400, "缺少幂等请求键");
    if (meta.launchId && meta.launchId !== this.launchId)
      ERR("UNAUTHORIZED", 401, "启动凭证已失效");
    const commandHash = hash({
      operationId,
      sessionId: meta.sessionId ?? null,
      runEpoch: meta.runEpoch ?? null,
      body,
    });
    if (operationId === "createSession")
      return await this.create(
        body as P.CreateSessionRequest,
        meta,
        commandHash,
      );
    const sid = meta.sessionId;
    if (!sid) ERR("INVALID_REQUEST", 400, "缺少 sessionId");
    await this.authorize(sid);
    const cached = await this.store.one(
      "SELECT * FROM commands WHERE session_id=? AND request_id=?",
      sid,
      meta.idempotencyKey,
    );
    if (cached) {
      if (cached.payload_hash !== commandHash)
        ERR("IDEMPOTENCY_KEY_REUSED", 409, "该请求键已用于不同内容");
      this.lastExecutionReplayed = true;
      return JSON.parse(cached.response_json);
    }
    const receivedMission = this.missionNow(await this.load(sid));
    await this.tickInternal(sid, receivedMission);
    let response: unknown;
    await this.tx(async () => {
      const s = await this.load(sid);
      if (meta.runEpoch !== s.runEpoch)
        ERR("RUN_EPOCH_CONFLICT", 409, "运行世代已变化", s);
      const b = body as any;
      const management =
        operationId === "requestEvaluation" || operationId === "createExport";
      if (management) {
        if (!s.outcome) ERR("NOT_TERMINAL", 422, "请先结束当前任务", s);
        if (b.sealedHash !== s.outcome.sealedHash)
          ERR("SEALED_HASH_MISMATCH", 422, "封存版本不匹配", s);
      } else {
        if (!LIVE.has(s.lifecycle))
          ERR("ALREADY_TERMINAL", 422, "此局已经结束", s);
        if (operationId === "recordDisplay") {
          if (b.observedStateVersion > s.version)
            ERR("STATE_VERSION_CONFLICT", 409, "观察版本晚于服务器", s);
        } else {
          if (b.expectedStateVersion !== s.version)
            ERR("STATE_VERSION_CONFLICT", 409, "状态已更新，请先同步后确认", s);
          if (b.expectedSceneId !== s.sceneId)
            ERR("SCENE_CONFLICT", 409, "场景已变化", s);
        }
        s.mission = Math.max(s.mission, receivedMission);
        if (operationId !== "recordDisplay") s.version++;
      }
      switch (operationId) {
        case "startSession":
          response = await this.start(s, b);
          break;
        case "createTask":
          response = await this.createTask(s, b, meta);
          break;
        case "uploadReports":
          response = await this.upload(s, b.payload.items, meta);
          break;
        case "askAdvisor":
          response = await this.question(s, b, meta);
          break;
        case "commitAction":
          response = await this.action(s, b, meta);
          break;
        case "recordDisplay":
          response = await this.receipt(s, b);
          break;
        case "abandonSession":
          await this.seal(s, "abandoned");
          response = s.outcome;
          break;
        case "requestEvaluation":
          response = await this.evaluate(s, b, meta);
          break;
        case "createExport":
          response = await this.export(s, b, meta);
          break;
      }
      if (!management) {
        if (
          s.lifecycle !== "completed" &&
          s.lifecycle !== "abandoned" &&
          s.lifecycle !== "interrupted"
        ) {
          await this.contextRecord(s);
          await this.save(s);
          await this.publicEvent(
            s,
            "projection.changed",
            await this.projection(s),
          );
        } else await this.save(s);
      }
      const statuses: Partial<Record<MutationOperation, number>> = {
        createTask: 202,
        askAdvisor: 202,
        commitAction: 202,
        requestEvaluation: 202,
        createExport: 202,
      };
      if (operationId === "startSession") response = await this.projection(s);
      await this.store.insert("commands", {
        session_id: sid,
        request_id: meta.idempotencyKey,
        run_epoch: s.runEpoch,
        binding_id: s.actors.commander,
        command_kind: operationId,
        payload_hash: commandHash,
        accepted_state_version: s.version,
        response_status: statuses[operationId] ?? 200,
        response_json: canonical(response),
        accepted_at_ms: this.clock.nowMs(),
      });
    });
    await this.flush(sid);
    return response;
  }
  private async create(
    b: P.CreateSessionRequest,
    meta: CommandMeta,
    commandHash: string,
  ): Promise<P.SessionCreated> {
    const old = this.options.cloud
      ? await this.store.one(
          "SELECT * FROM cloud_creation_keys WHERE player_id=? AND request_id=?",
          meta.playerId,
          meta.idempotencyKey,
        )
      : await this.store.one(
          "SELECT * FROM session_creations WHERE launch_id=? AND request_id=?",
          this.launchId,
          meta.idempotencyKey,
        );
    if (old) {
      if (old.payload_hash !== commandHash)
        ERR("IDEMPOTENCY_KEY_REUSED", 409, "请求键已用于不同创建参数");
      this.lastExecutionReplayed = true;
      if (this.options.cloud) {
        if (!(await this.playerAccess(old.session_id, meta.playerId!, "read")))
          ERR("RESOURCE_NOT_FOUND", 404, "Session not found.");
      } else this.granted.add(old.session_id);
      return JSON.parse(old.response_json);
    }
    if (b.contentVersionId !== this.contentVersionId)
      ERR("INVALID_REQUEST", 400, "未知内容版本");
    if (b.runPurpose !== "design_preview")
      ERR("POLICY_NOT_APPROVED", 422, "参考规则仍在评审，请选择设计预览");
    const sid = uid(),
      now = this.clock.nowMs();
    if (this.options.cloud) {
      if (
        !(await this.store.one(
          "SELECT player_id FROM cloud_players WHERE player_id=?",
          meta.playerId,
        ))
      )
        ERR("UNAUTHORIZED", 401, "Visitor identity not found.");
      await this.reapExpiredBriefings(now);
    }
    let result!: P.SessionCreated;
    await this.tx(async () => {
      if (this.options.cloud) {
        const live = await this.store.one(
          "SELECT COUNT(*) AS n FROM sessions WHERE lifecycle IN ('briefing','running')",
        );
        if (Number(live.n) >= this.options.cloud.maxActiveSessions)
          ERR(
            "RATE_LIMITED",
            429,
            "The game is at capacity. Please try again later.",
          );
        const dayStart = Math.floor(now / 86400000) * 86400000;
        const daily = await this.store.one(
          "SELECT COUNT(*) AS n FROM cloud_sessions c JOIN sessions s ON s.session_id=c.session_id WHERE c.player_id=? AND s.created_at_ms>=? AND s.created_at_ms<?",
          meta.playerId,
          dayStart,
          dayStart + 86400000,
        );
        if (Number(daily.n) >= this.options.cloud.maxSessionsPerPlayerPerDay)
          ERR("RATE_LIMITED", 429, "Your daily game limit has been reached.");
      }
      const s: State = {
        sessionId: sid,
        runEpoch: uid(),
        caseId:
          this.options.selectCase?.() ?? (Math.random() < 0.5 ? "A" : "B"),
        runPurpose: b.runPurpose,
        locale: asLocale(b.locale),
        version: 0,
        lifecycle: "briefing",
        phase: "briefing",
        sceneId: null,
        mission: 0,
        createdAt: now,
        startWall: null,
        flags: {
          manifestPending: false,
          inspectionPending: false,
          bridgeRefused: false,
        },
        location: { nodeId: "N00", routeId: null, progressPermille: 0 },
        actors: { commander: uid(), analyst: uid(), liaison: uid() },
        accounts: {},
        inventory: [],
        tasks: [],
        operations: [],
        reports: [],
        uploads: [],
        statements: [],
        decisions: [],
        decisionMeta: {},
        publicLog: [],
        viewedReportIds: [],
        displayedAdviceIds: [],
        contextDisplayed: false,
        inboxVersion: 0,
        contextVersion: 0,
        contextEpoch: uid(),
        routeIdsTaken: [],
        medical: {
          status: "stable",
          targetAtMissionMs: 480000,
          note: "乘员状态稳定，等待转送；请留意转送目标时刻。",
        },
        outcome: null,
        arrivalMs: null,
      };
      await this.store.insert("sessions", {
        session_id: sid,
        run_epoch: s.runEpoch,
        launch_id: this.launchId,
        mode: "demo",
        content_hash: this.world.contentHash,
        policy_hash: this.world.policyHash,
        private_case_id: s.caseId,
        world_state_json: canonical(s),
        created_at_ms: now,
        updated_at_ms: now,
      });
      await this.store.insert("runtime_session_meta", {
        session_id: sid,
        locale: asLocale(b.locale),
        run_purpose: b.runPurpose,
      });
      if (this.options.cloud)
        await this.store.insert("cloud_sessions", {
          session_id: sid,
          player_id: meta.playerId,
        });
      for (const [i, scene] of (["E1", "E2", "E3"] as const).entries())
        await this.store.insert("session_scenes", {
          session_id: sid,
          scene_id: scene,
          ordinal: i + 1,
        });
      for (const [role, binding] of Object.entries(s.actors))
        await this.store.insert("actor_bindings", {
          session_id: sid,
          binding_id: binding,
          role,
          controller_kind: role === "commander" ? "human" : "npc",
          created_at_ms: now,
        });
      for (const channel of CHANNELS) {
        const accountId = uid();
        s.accounts[channel] = accountId;
        await this.store.insert("quota_accounts", {
          session_id: sid,
          account_id: accountId,
          quota_scope: "session",
          role: ["drone", "satellite"].includes(channel)
            ? "analyst"
            : "liaison",
          resource: channel,
          capacity: this.world.policy.channelLimits[channel],
          available: this.world.policy.channelLimits[channel],
        });
      }
      for (const scene of ["E1", "E2", "E3"])
        for (const [role, resource, capacity] of [
          ["analyst", "report", 3],
          ["liaison", "report", 3],
          ["commander", "upload", 5],
        ] as const) {
          const key = `${scene}:${role}:${resource}`,
            id = uid();
          s.accounts[key] = id;
          await this.store.insert("quota_accounts", {
            session_id: sid,
            account_id: id,
            quota_scope: "scene",
            scene_id: scene,
            role,
            resource,
            capacity,
            available: capacity,
          });
        }
      for (const capability of [
        "commander.read",
        "commander.command",
        "evaluation.request",
        "export.request",
      ])
        await this.store.insert("launch_session_access", {
          launch_id: this.launchId,
          session_id: sid,
          binding_id: s.actors.commander,
          capability,
          granted_at_ms: now,
        });
      await this.event(s, "session.created", {
        profileId: "SINGLE_PLAYER_REFERENCE",
        runPurpose: b.runPurpose,
      });
      this.log(
        s,
        "brief",
        "LAST MILE：护送20名平民抵达曙光接收站。当前为规则设计预览。",
        "system",
      );
      await this.contextRecord(s);
      await this.save(s);
      await this.publicEvent(s, "projection.changed", await this.projection(s));
      result = {
        sessionId: sid,
        runEpoch: s.runEpoch,
        location: `/api/v1/sessions/${sid}`,
        projection: await this.projection(s),
      };
      await this.store.insert("session_creations", {
        launch_id: this.launchId,
        // Cloud replay is keyed by (player_id, request_id). The legacy launch
        // audit key must not collide when two visitors reuse the same UUID.
        request_id: this.options.cloud ? uid() : meta.idempotencyKey,
        payload_hash: commandHash,
        session_id: sid,
        response_json: canonical(result),
        created_at_ms: now,
      });
      if (this.options.cloud)
        await this.store.insert("cloud_creation_keys", {
          player_id: meta.playerId,
          request_id: meta.idempotencyKey,
          session_id: sid,
          payload_hash: commandHash,
          response_json: canonical(result),
          created_at_ms: now,
        });
    });
    this.granted.add(sid);
    return result;
  }
  private async reapExpiredBriefings(now: number) {
    // Reap on admission, with no idle database polling. A briefing has no
    // mission clock, so a closed browser must not retain a public slot forever.
    const expired = await this.store.all(
      "SELECT session_id FROM sessions WHERE lifecycle='briefing' AND created_at_ms<=?",
      now - 15 * 60 * 1000,
    );
    for (const row of expired) {
      await this.tx(async () => {
        const s = await this.load(row.session_id);
        if (s.lifecycle !== "briefing") return;
        s.version++;
        await this.seal(
          s,
          "technical_interruption",
          asLocale(s.locale) === "en-US"
            ? "The briefing was not started within 15 minutes. This session was sealed to release its place."
            : "简报等待超过15分钟，尚未开始任务。本局已由系统封存并释放名额。",
        );
        await this.save(s);
      });
      await this.flush(row.session_id);
    }
  }
  private async contextRecord(s: State) {
    if (s.lifecycle === "briefing" || s.phase === "decision")
      await this.publicRecord(
        s,
        `context:${s.sceneId ?? "briefing"}:${s.version}`,
        "briefing",
        {
          sceneId: s.sceneId,
          stateVersion: s.version,
          actions: this.actionOptions(s),
          taskOptions: await this.taskOptions(s),
        },
      );
  }
  private async start(s: State, b: P.StartRequest) {
    if (s.lifecycle !== "briefing")
      ERR("PHASE_NOT_ALLOWED", 422, "此局已经启动", s);
    if (!b.payload.acknowledgeDesignPreview)
      ERR("POLICY_NOT_APPROVED", 422, "请先确认这是待评审规则预览", s);
    s.lifecycle = "running";
    s.startWall = this.clock.nowMs();
    this.anchors.set(s.sessionId, {
      mono: this.clock.monotonicMs(),
      mission: 0,
    });
    await this.store.run(
      "UPDATE runtime_session_meta SET start_wall_ms=? WHERE session_id=?",
      s.startWall,
      s.sessionId,
    );
    await this.event(
      s,
      "session.started",
      { missionDurationMs: 600000 },
      "human",
      s.actors.commander,
    );
    this.log(s, "brief", "车队离开集结院，正在前往西门检查站。", "player");
    const plan: Plan = {
      actionId: "ENTRY",
      label: "前往西门",
      steps: this.world.campaign.entrySteps,
      nextSceneId: "E1",
      endNodeId: "N01",
      effects: [],
    };
    await this.beginOperation(s, plan, "action", true, null);
    return await this.projection(s);
  }
  private ensureDecision(s: State) {
    if (s.lifecycle !== "running" || s.phase !== "decision" || !s.sceneId)
      ERR("PHASE_NOT_ALLOWED", 422, "车队尚未到达可决策现场", s);
  }
  private async createTask(
    s: State,
    b: P.TaskRequest,
    meta: CommandMeta,
  ): Promise<P.TaskAccepted> {
    this.ensureDecision(s);
    const p = b.payload;
    const choiceMeta = await this.choiceMeta(s, b.expectedStateVersion);
    if (
      s.tasks.some((t) => t.view.targetRole === p.targetRole && active(t.view))
    )
      ERR("ROLE_BUSY", 422, "该岗位正在执行另一项任务", s);
    if ((await this.reportQuota(s, s.sceneId!, p.targetRole)).remaining === 0)
      ERR("REPORT_LIMIT", 422, "该岗位本场景上报额度已用完", s);
    let def!: EvidenceDefinition,
      inventory: InventoryItem | undefined,
      trace = false,
      sourceReportId: string | null = null,
      channel: Channel | null = null,
      duration = 1000;
    if (p.taskKind === "request_report") {
      inventory = s.inventory
        .filter(
          (i) =>
            i.owner === p.targetRole &&
            i.card.sceneId === s.sceneId &&
            i.topic === p.topicId &&
            !s.reports.some(
              (r) => r.evidenceInstanceId === i.card.evidenceInstanceId,
            ),
        )
        .sort(
          (a, b) =>
            b.priority - a.priority ||
            a.acquired - b.acquired ||
            a.definitionId.localeCompare(b.definitionId),
        )[0];
      if (!inventory)
        ERR(
          "TARGET_NOT_AVAILABLE",
          422,
          "该岗位没有匹配且尚未上报的已获资料",
          s,
        );
      def = this.world
        .case(s.caseId)
        .evidenceDefinitions.find(
          (d) => d.definitionId === inventory!.definitionId,
        )!;
    } else {
      const option = (await this.taskOptions(s)).find(
        (o) =>
          o.targetId === p.targetId &&
          o.targetRole === p.targetRole &&
          o.topicId === p.topicId &&
          o.investigationKind === p.investigationKind,
      );
      if (!option)
        ERR("TARGET_NOT_AVAILABLE", 422, "该调查目标未向当前岗位开放", s);
      if (!option.available)
        ERR(
          option.disabledReason === "no_resource"
            ? "BUDGET_EXHAUSTED"
            : option.disabledReason === "no_report_slot"
              ? "REPORT_LIMIT"
              : "ROLE_BUSY",
          422,
          "该调查当前不可执行",
          s,
        );
      trace = p.investigationKind === "provenance_trace";
      if (trace) {
        const source = s.reports.find(
          (r) => r.reportId === p.sourceReportId && r.sceneId === s.sceneId,
        );
        if (!source)
          ERR("NOT_REPORTED", 422, "溯源必须引用本场景已经收到的报告", s);
        def = this.world
          .case(s.caseId)
          .evidenceDefinitions.find(
            (d) => d.definitionId === source!.card.definitionId,
          )!;
        if (!def?.traceResult || `${def.definitionId}.trace` !== p.targetId)
          ERR("TARGET_NOT_AVAILABLE", 422, "该报告没有可用的来源核验", s);
        sourceReportId = source.reportId;
      } else
        def = this.world
          .case(s.caseId)
          .evidenceDefinitions.find((d) => d.definitionId === p.targetId)!;
      channel = option.resourceChannel;
      duration = option.cost.knownDurationMs!;
    }
    const tid = uid(),
      reservation = await this.ledger(
        s,
        `${s.sceneId}:${p.targetRole}:report`,
        "reserve",
        1,
        null,
        tid,
      );
    const charge = channel
      ? await this.ledger(s, channel, "spend", 1, null, tid)
      : null;
    const iid = channel ? uid() : null;
    const view: P.TaskView = {
      taskId: tid,
      sessionId: s.sessionId,
      sceneId: s.sceneId!,
      targetRole: p.targetRole,
      taskKind: p.taskKind,
      topicId: p.topicId,
      resourceChannel: channel,
      status: "running",
      investigationId: iid,
      reportId: null,
      createdAt: iso(this.clock.nowMs()),
      completedAt: null,
      failureCode: null,
    };
    const task: Task = {
      view,
      due: s.mission + duration,
      accepted: s.mission,
      definitionId: def.definitionId,
      reservationId: reservation,
      resourceChargeId: charge,
      inventoryId: inventory?.card.evidenceInstanceId ?? null,
      sourceReportId,
      trace,
    };
    s.tasks.push(task);
    await this.store.insert("task_requests", {
      session_id: s.sessionId,
      task_id: tid,
      scene_id: s.sceneId,
      commander_binding_id: s.actors.commander,
      target_role: p.targetRole,
      task_kind: p.taskKind,
      topic_id: p.topicId,
      target_id:
        p.taskKind === "request_report"
          ? this.world.scene(s.sceneId!).nodeId
          : p.targetId,
      option_id: channel
        ? trace
          ? `${def.definitionId}.trace`
          : def.definitionId
        : null,
      status: "running",
      report_reservation_id: reservation,
      accepted_mission_ms: s.mission,
      due_mission_ms: task.due,
      created_at_ms: this.clock.nowMs(),
    });
    if (iid)
      await this.store.insert("investigations", {
        session_id: s.sessionId,
        investigation_id: iid,
        task_id: tid,
        scene_id: s.sceneId,
        role: p.targetRole,
        option_id: trace ? `${def.definitionId}.trace` : def.definitionId,
        resource_key: channel,
        resource_charge_id: charge,
        status: "running",
        accepted_mission_ms: s.mission,
        due_mission_ms: task.due,
      });
    const acceptedEvent = await this.event(
      s,
      "task.accepted",
      {
        taskId: tid,
        targetRole: p.targetRole,
        taskKind: p.taskKind,
        topicId: p.topicId,
        reservationLedgerId: reservation,
        investigationId: iid,
        reasonAnnotation: "reasonAnnotation" in p ? p.reasonAnnotation : null,
      },
      "human",
      s.actors.commander,
      meta.idempotencyKey,
    );
    const decisionId = uid();
    const annotation = "reasonAnnotation" in p ? p.reasonAnnotation : null;
    const decision: P.DecisionReplay = {
      decisionId,
      sceneId: s.sceneId!,
      committedAtMissionMs: s.mission,
      actionId: `CHECK.${def.definitionId}${trace ? ".trace" : ""}`,
      reason: "",
      reasonAnnotation: annotation,
      knownReportIds: s.reports
        .filter((r) => r.sceneId === s.sceneId)
        .map((r) => r.reportId),
      viewedReportIds: s.reports
        .filter(
          (r) =>
            r.sceneId === s.sceneId && s.viewedReportIds.includes(r.reportId),
        )
        .map((r) => r.reportId),
      uploadedIds: s.uploads
        .filter((u) => u.sceneId === s.sceneId)
        .map((u) => u.uploadId),
      displayedAdviceJobIds: choiceMeta.eligibleAdviceJobId
        ? [choiceMeta.eligibleAdviceJobId]
        : [],
      legalActionIds: [`CHECK.${def.definitionId}${trace ? ".trace" : ""}`],
      knownCosts: [
        {
          actionId: `CHECK.${def.definitionId}${trace ? ".trace" : ""}`,
          cost: {
            knownDurationMs: duration,
            uncertainty: "none",
            description: channel
              ? "一次渠道调查，并预留一格上报额度"
              : "一格上报额度，等待资料交付",
          },
        },
      ],
      resultSummary: "岗位任务已接受。",
      unobservedCommunication: "not_observable",
    };
    s.decisions.push(decision);
    const checkQuestionKey =
      annotation?.declaredQuestionKey ??
      (trace
        ? "source_chain"
        : (questionKeysForTarget(def.definitionId)[0] ?? null));
    s.decisionMeta ??= {};
    s.decisionMeta[decisionId] = {
      ...choiceMeta,
      kind: "investigation_request",
      check: channel
        ? {
            channel,
            capabilityDisplayed: choiceMeta.contextDisplayedAtMs !== null,
            questionKey: checkQuestionKey,
            knownAffordable: true,
            refresh: false,
            newTimeWindow:
              channel === "drone" &&
              (!checkQuestionKey ||
                !cannotConfirmQuestionKeys(channel).includes(checkQuestionKey)),
          }
        : null,
    };
    await this.store.insert("decision_snapshots", {
      session_id: s.sessionId,
      snapshot_id: decisionId,
      scene_id: s.sceneId,
      binding_id: s.actors.commander,
      snapshot_kind: "task",
      source_seq: acceptedEvent.seq,
      mission_ms: s.mission,
      state_version: s.version,
      snapshot_hash: hash(decision),
      snapshot_json: canonical(decision),
    });
    this.log(
      s,
      "task_requested",
      `${p.targetRole === "analyst" ? "分析员" : "联络员"}开始${channel ? "调查" : "整理已获资料"}：${def.title}`,
      "player",
    );
    await this.publicEvent(s, "task.updated", view);
    return {
      requestId: meta.requestId ?? meta.idempotencyKey,
      stateVersion: s.version,
      task: view,
      operationLocation: `/api/v1/sessions/${s.sessionId}/tasks/${tid}`,
      reservedReportSlots: 1,
    };
  }
  private async acquire(
    s: State,
    def: EvidenceDefinition,
    task?: Task,
  ): Promise<InventoryItem> {
    const source = task?.sourceReportId
      ? s.reports.find((r) => r.reportId === task.sourceReportId)
      : undefined;
    const trace = task?.trace ?? false;
    const id = uid(),
      rev = trace ? source!.revision + 1 : 1;
    const card: P.EvidenceCard = localizePublic(
      {
        evidenceInstanceId: id,
        definitionId: trace ? `${def.definitionId}.trace` : def.definitionId,
        revision: rev,
        sceneId: def.sceneId,
        title: trace ? def.traceResult!.title : def.title,
        body: trace ? def.traceResult!.body : def.body,
        statementKind: trace ? "provenance" : def.statementKind,
        sourceLabel: trace ? `来源核验：${def.sourceLabel}` : def.sourceLabel,
        channel: trace ? task!.view.resourceChannel! : def.channel,
        observedAt:
          def.observationAgeMs === null
            ? null
            : iso(s.startWall! + s.mission - def.observationAgeMs),
        receivedAtMissionMs: s.mission,
        validUntilMissionMs: null,
        freshness:
          def.observationAgeMs !== null && def.observationAgeMs > 0
            ? "historical"
            : def.channel === "initial"
              ? "unknown"
              : "current",
        observationScope: def.observationScope,
        provenanceStatus: trace
          ? def.traceResult!.status
          : def.provenanceStatus,
        supersedesEvidenceInstanceId: source?.evidenceInstanceId ?? null,
      },
      asLocale(s.locale),
    );
    const item: InventoryItem = {
      card,
      owner: task?.view.targetRole ?? def.sourceRole,
      topic: def.topicId,
      priority: def.priority,
      definitionId: def.definitionId,
      acquired: s.mission,
      traceRelated: trace ? def.traceResult!.relatedDefinitionIds : [],
      ...(trace ? { traceRootLabel: def.traceResult!.rootLabel } : {}),
    };
    s.inventory.push(item);
    await this.store.insert("evidence_instances", {
      session_id: s.sessionId,
      instance_id: id,
      revision: rev,
      scene_id: def.sceneId,
      owner_role: item.owner,
      private_definition_id: def.definitionId,
      observation_type: trace
        ? "provenanceFinding"
        : def.statementKind === "testimony"
          ? "reportedStatement"
          : def.observationAgeMs
            ? "historicalRecord"
            : "directObservation",
      acquired_mission_ms: s.mission,
      observed_mission_ms:
        def.observationAgeMs === null
          ? null
          : Math.max(0, s.mission - def.observationAgeMs),
      acquisition_investigation_id: task?.view.investigationId ?? null,
      supersedes_instance_id: source?.evidenceInstanceId ?? null,
      supersedes_revision: source?.revision ?? null,
      public_payload_json: canonical(card),
      payload_hash: hash(card),
    });
    if (trace)
      await this.store.insert("provenance_disclosures", {
        session_id: s.sessionId,
        finding_id: uid(),
        evidence_instance_id: id,
        evidence_revision: rev,
        subject_instance_id: source!.evidenceInstanceId,
        subject_revision: source!.revision,
        relation_type:
          def.traceResult!.relatedDefinitionIds.length > 1
            ? "sharedRootConfirmed"
            : "sourceIdentityChecked",
        verification_state: "verified",
        public_relation_json: canonical({
          label: def.traceResult!.rootLabel,
          relatedDefinitionIds: def.traceResult!.relatedDefinitionIds,
        }),
      });
    return item;
  }
  private async finishTask(s: State, t: Task) {
    if (!active(t.view)) return;
    const def = this.world
      .case(s.caseId)
      .evidenceDefinitions.find((d) => d.definitionId === t.definitionId)!;
    if (t.view.investigationId)
      await this.store.run(
        "UPDATE investigations SET status='completed',finished_mission_ms=? WHERE session_id=? AND investigation_id=?",
        s.mission,
        s.sessionId,
        t.view.investigationId,
      );
    const item = t.inventoryId
      ? s.inventory.find((i) => i.card.evidenceInstanceId === t.inventoryId)!
      : await this.acquire(s, def, t);
    const charge = await this.ledger(
      s,
      `${t.view.sceneId}:${t.view.targetRole}:report`,
      "spend",
      1,
      t.reservationId,
      t.view.taskId,
    );
    const report: P.ReportView = {
      reportId: uid(),
      evidenceInstanceId: item.card.evidenceInstanceId,
      revision: item.card.revision,
      sourceRole: t.view.targetRole,
      sceneId: t.view.sceneId,
      reportedAtMissionMs: s.mission,
      card: item.card,
    };
    await this.store.insert("reports", {
      session_id: s.sessionId,
      report_id: report.reportId,
      scene_id: report.sceneId,
      sender_role: report.sourceRole,
      source_instance_id: report.evidenceInstanceId,
      source_revision: report.revision,
      actor_binding_id: s.actors[report.sourceRole],
      task_id: t.view.taskId,
      charge_entry_id: charge,
      reported_mission_ms: s.mission,
      immutable_payload_json: canonical(report.card),
      immutable_payload_hash: hash(report.card),
    });
    s.reports.push(report);
    t.view = {
      ...t.view,
      status: "completed",
      reportId: report.reportId,
      completedAt: iso(this.clock.nowMs()),
    };
    await this.store.run(
      "UPDATE task_requests SET status='completed',completed_at_ms=? WHERE session_id=? AND task_id=?",
      this.clock.nowMs(),
      s.sessionId,
      t.view.taskId,
    );
    await this.event(
      s,
      "report.created",
      {
        reportId: report.reportId,
        evidenceInstanceId: report.evidenceInstanceId,
        revision: report.revision,
        sourceRole: report.sourceRole,
        spendLedgerId: charge,
        selectionRule: "public_topic_priority_then_acquisition",
      },
      "npc",
      s.actors[report.sourceRole],
    );
    await this.publicRecord(s, `report:${report.reportId}`, "report", report);
    this.log(
      s,
      "report_received",
      `${report.sourceRole === "analyst" ? "分析员" : "联络员"}上报：${report.card.title}`,
      "npc",
      [report.reportId],
    );
    await this.publicEvent(s, "task.updated", t.view);
    await this.publicEvent(s, "report.received", report);
  }
  private async cancelTasks(
    s: State,
    reason: "scene_left" | "session_terminated",
  ) {
    for (const t of s.tasks.filter((t) => active(t.view))) {
      t.view = {
        ...t.view,
        status: "cancelled",
        completedAt: iso(this.clock.nowMs()),
        failureCode: reason,
      };
      if (t.view.investigationId)
        await this.store.run(
          "UPDATE investigations SET status='cancelled',finished_mission_ms=?,failure_code=? WHERE session_id=? AND investigation_id=?",
          s.mission,
          reason,
          s.sessionId,
          t.view.investigationId,
        );
      await this.store.run(
        "UPDATE task_requests SET status='cancelled',completed_at_ms=?,failure_code=? WHERE session_id=? AND task_id=?",
        this.clock.nowMs(),
        reason,
        s.sessionId,
        t.view.taskId,
      );
      await this.ledger(
        s,
        `${t.view.sceneId}:${t.view.targetRole}:report`,
        "release",
        1,
        t.reservationId,
        uid(),
        reason,
      );
      await this.publicEvent(s, "task.updated", t.view);
    }
  }
  private async cancelAdvisor(
    s: State,
    status: "superseded" | "cancelled" = "superseded",
  ) {
    await this.store.run(
      "UPDATE agent_jobs SET status=?,updated_at_ms=? WHERE session_id=? AND agent_role='advisor' AND status IN ('queued','running')",
      status,
      this.clock.nowMs(),
      s.sessionId,
    );
  }
  private async enter(s: State, scene: P.SceneId) {
    s.sceneId = scene;
    s.phase = "decision";
    s.location = {
      nodeId: this.world.scene(scene).nodeId,
      routeId: null,
      progressPermille: 0,
    };
    s.contextEpoch = uid();
    s.contextDisplayed = false;
    await this.store.run(
      "UPDATE session_scenes SET entered_mission_ms=? WHERE session_id=? AND scene_id=? AND entered_mission_ms IS NULL",
      s.mission,
      s.sessionId,
      scene,
    );
    for (const def of this.world
      .case(s.caseId)
      .evidenceDefinitions.filter(
        (d) => d.sceneId === scene && d.acquisition === "preloaded",
      ))
      if (!s.inventory.some((i) => i.definitionId === def.definitionId))
        await this.acquire(s, def);
    await this.event(s, "scene.entered", {
      sceneId: scene,
      nodeId: s.location.nodeId,
    });
    this.log(s, "brief", this.world.scene(scene).intro);
    await this.enqueueAdvisor(s);
  }
  private async beginOperation(
    s: State,
    plan: Plan,
    kind: "action" | "wait",
    entry: boolean,
    decisionId: string | null,
  ) {
    const steps = this.world.resolve(plan, s.flags, s.mission);
    const view: P.OperationView = {
      operationId: uid(),
      sessionId: s.sessionId,
      sceneId: s.sceneId ?? "E1",
      operationKind: kind,
      actionId: plan.actionId,
      status: "running",
      createdAt: iso(this.clock.nowMs()),
      completedAt: null,
      currentLocation: s.location,
      publicProgressLabel:
        kind === "wait"
          ? "原地等待，岗位调查继续"
          : steps[0].kind === "route"
            ? "车队正在行进"
            : "车队正在办理现场手续",
      failureCode: null,
    };
    const op: Operation = { view, plan, steps, index: 0, entry, decisionId };
    s.operations.push(op);
    if (kind !== "wait")
      s.phase = steps[0].kind === "route" ? "travelling" : "coordinating";
    if (steps[0].routeId) s.routeIdsTaken.push(steps[0].routeId);
    await this.store.insert("operations", {
      session_id: s.sessionId,
      operation_id: view.operationId,
      scene_id: view.sceneId,
      operation_kind: kind,
      action_id: plan.actionId,
      status: "running",
      private_plan_json: canonical({ plan, steps }),
      public_progress_json: canonical(view),
      accepted_mission_ms: s.mission,
      due_mission_ms: steps.at(-1)!.endMs,
      created_at_ms: this.clock.nowMs(),
    });
    await this.publicEvent(s, "operation.updated", view);
    return op;
  }
  private async action(
    s: State,
    b: P.ActionRequest,
    meta: CommandMeta,
  ): Promise<P.ActionAccepted> {
    this.ensureDecision(s);
    const p = b.payload;
    const choiceMeta = await this.choiceMeta(s, b.expectedStateVersion);
    const selected = this.actionOptions(s).find(
      (a) => a.actionId === p.actionId,
    );
    if (!selected?.available)
      ERR("ACTION_NOT_AVAILABLE", 422, "该动作在当前状态不可执行", s);
    if (
      p.referencedReportIds.some(
        (id) =>
          !s.viewedReportIds.includes(id) ||
          !s.reports.some((r) => r.reportId === id && r.sceneId === s.sceneId),
      )
    )
      ERR("NOT_REPORTED", 422, "行动理由只能引用已展开的本场景报告", s);
    if (
      p.basedOnAdviceJobId &&
      !s.displayedAdviceIds.includes(p.basedOnAdviceJobId)
    )
      ERR("INVALID_REQUEST", 400, "引用的 AI 建议尚未展示", s);
    if (
      p.actionId !== "WAIT" &&
      s.tasks.some((t) => active(t.view)) &&
      !p.cancelPendingInvestigations
    )
      ERR("PHASE_NOT_ALLOWED", 422, "请确认离场会取消未完成调查", s);
    const decisionId = uid(),
      known = s.reports.filter((r) => r.sceneId === s.sceneId),
      legal = this.actionOptions(s).filter((a) => a.available);
    const decision: P.DecisionReplay = {
      decisionId,
      sceneId: s.sceneId!,
      committedAtMissionMs: s.mission,
      actionId: p.actionId,
      reason: p.reason,
      reasonAnnotation: p.reasonAnnotation,
      knownReportIds: known.map((r) => r.reportId),
      viewedReportIds: known
        .filter((r) => s.viewedReportIds.includes(r.reportId))
        .map((r) => r.reportId),
      uploadedIds: s.uploads
        .filter((u) => u.sceneId === s.sceneId)
        .map((u) => u.uploadId),
      displayedAdviceJobIds: choiceMeta.eligibleAdviceJobId
        ? [choiceMeta.eligibleAdviceJobId]
        : [],
      legalActionIds: legal.map((a) => a.actionId),
      knownCosts: legal.map((a) => ({ actionId: a.actionId, cost: a.cost })),
      resultSummary: "行动已确认，等待实际结算。",
      unobservedCommunication: "not_observable",
    };
    s.decisions.push(decision);
    s.decisionMeta ??= {};
    s.decisionMeta[decisionId] = {
      ...choiceMeta,
      kind: p.actionId === "WAIT" ? "wait" : "route_decision",
      referencedEvidenceRefs: p.referencedReportIds.map((id) => {
        const r = s.reports.find((r) => r.reportId === id)!;
        return { instanceId: r.evidenceInstanceId, revision: r.revision };
      }),
    };
    const cancelled = s.tasks
      .filter((t) => active(t.view))
      .map((t) => t.view.investigationId)
      .filter(Boolean);
    if (p.actionId !== "WAIT") {
      await this.cancelTasks(s, "scene_left");
      await this.cancelAdvisor(s, "cancelled");
      await this.store.run(
        "UPDATE session_scenes SET closed_mission_ms=? WHERE session_id=? AND scene_id=?",
        s.mission,
        s.sessionId,
        s.sceneId,
      );
    }
    let plan: Plan;
    if (p.actionId === "WAIT") {
      if (![15000, 30000, 60000].includes(p.waitDurationMs ?? 0))
        ERR("INVALID_REQUEST", 400, "请选择合法等待时长", s);
      plan = {
        actionId: "WAIT",
        label: "原地等待",
        steps: [
          {
            kind: "hold",
            nodeId: s.location.nodeId!,
            durationMs: p.waitDurationMs!,
          },
        ],
        nextSceneId: s.sceneId,
        endNodeId: s.location.nodeId!,
        effects: [],
      };
    } else
      plan = this.world
        .case(s.caseId)
        .actionPlans.find((x) => x.actionId === p.actionId)!;
    const op = await this.beginOperation(
      s,
      plan,
      p.actionId === "WAIT" ? "wait" : "action",
      false,
      decisionId,
    );
    const event = await this.event(
      s,
      "action.committed",
      {
        decisionId,
        operationId: op.view.operationId,
        sceneId: s.sceneId,
        actionId: p.actionId,
        reason: p.reason,
        reasonAnnotation: p.reasonAnnotation,
        referencedReportIds: p.referencedReportIds,
        basedOnAdviceJobId: p.basedOnAdviceJobId,
        cancelledInvestigationIds: cancelled,
      },
      "human",
      s.actors.commander,
      meta.idempotencyKey,
    );
    await this.store.insert("decision_snapshots", {
      session_id: s.sessionId,
      snapshot_id: decisionId,
      scene_id: s.sceneId,
      binding_id: s.actors.commander,
      snapshot_kind: "action",
      source_seq: event.seq,
      mission_ms: s.mission,
      state_version: s.version,
      snapshot_hash: hash(decision),
      snapshot_json: canonical(decision),
    });
    this.log(
      s,
      "action_committed",
      selected.label,
      "player",
      p.referencedReportIds as string[],
      p.basedOnAdviceJobId,
    );
    return {
      requestId: meta.requestId ?? meta.idempotencyKey,
      stateVersion: s.version,
      operation: this.operationView(s, op, s.mission),
      operationLocation: `/api/v1/sessions/${s.sessionId}/operations/${op.view.operationId}`,
    };
  }
  private async advanceOperation(s: State, op: Operation) {
    const step = op.steps[op.index];
    s.location = this.world.location(step, step.endMs);
    if (step.clearFlag) s.flags[step.clearFlag] = false;
    await this.event(s, "operation.segment_completed", {
      operationId: op.view.operationId,
      segmentIndex: op.index,
      location: s.location,
    });
    op.index++;
    if (op.index < op.steps.length) {
      const next = op.steps[op.index];
      if (op.view.operationKind !== "wait")
        s.phase = next.kind === "route" ? "travelling" : "coordinating";
      if (next.routeId) s.routeIdsTaken.push(next.routeId);
      op.view = {
        ...op.view,
        currentLocation: s.location,
        publicProgressLabel:
          next.kind === "route" ? "车队正在行进" : "车队正在办理现场手续",
      };
      await this.store.run(
        "UPDATE operations SET public_progress_json=? WHERE session_id=? AND operation_id=?",
        canonical(op.view),
        s.sessionId,
        op.view.operationId,
      );
      await this.publicEvent(s, "operation.updated", op.view);
      return;
    }
    for (const effect of op.plan.effects) s.flags[effect.flag] = effect.value;
    op.view = {
      ...op.view,
      status: "completed",
      completedAt: iso(this.clock.nowMs()),
      currentLocation: s.location,
      publicProgressLabel:
        op.view.operationKind === "wait"
          ? "等待结束"
          : op.plan.endNodeId === "N07"
            ? "抵达接收站"
            : s.flags.bridgeRefused && op.plan.actionId === "E3_BRIDGE"
              ? "主桥车辆通行申请被拒绝"
              : "到达下一决策现场",
    };
    await this.store.run(
      "UPDATE operations SET status='completed',completed_at_ms=?,public_progress_json=? WHERE session_id=? AND operation_id=?",
      this.clock.nowMs(),
      canonical(op.view),
      s.sessionId,
      op.view.operationId,
    );
    if (op.decisionId) {
      const d = s.decisions.find((d) => d.decisionId === op.decisionId)!;
      d.resultSummary = op.view.publicProgressLabel;
    }
    this.log(s, "consequence", op.view.publicProgressLabel);
    await this.publicRecord(
      s,
      `operation:${op.view.operationId}`,
      "sceneFeedback",
      op.view,
    );
    await this.publicEvent(s, "operation.updated", op.view);
    if (op.plan.endNodeId === "N07") {
      s.arrivalMs = s.mission;
      await this.seal(
        s,
        s.flags.manifestPending || s.flags.inspectionPending
          ? "awaiting_transfer"
          : "arrived",
      );
      return;
    }
    if (op.view.operationKind === "wait") {
      s.phase = "decision";
      return;
    }
    if (op.plan.nextSceneId === s.sceneId) {
      s.phase = "decision";
      await this.enqueueAdvisor(s);
      return;
    }
    if (op.plan.nextSceneId) await this.enter(s, op.plan.nextSceneId);
  }
  private async tickInternal(sessionId?: string, missionLimit?: number) {
    if (this.closed) return;
    const ids = sessionId ? [sessionId] : [...this.liveSessions];
    for (const sid of ids) {
      let s = await this.load(sid);
      if (s.lifecycle !== "running") continue;
      const now = missionLimit ?? this.missionNow(s);
      let steps = 0;
      while (s.lifecycle === "running") {
        const op = this.op(s);
        const candidates: {
          due: number;
          priority: number;
          id: string;
          kind: "operation" | "task" | "medical" | "deadline";
        }[] = [];
        if (op)
          candidates.push({
            due: op.steps[op.index].endMs,
            priority: op.view.operationKind === "wait" ? 30 : 10,
            id: op.view.operationId,
            kind: "operation",
          });
        for (const t of s.tasks.filter((t) => active(t.view)))
          candidates.push({
            due: t.due,
            priority: 20,
            id: t.view.taskId,
            kind: "task",
          });
        if (s.medical.status !== "target_missed")
          candidates.push({
            due: 480000,
            priority: 40,
            id: "medical",
            kind: "medical",
          });
        candidates.push({
          due: 600000,
          priority: 90,
          id: "deadline",
          kind: "deadline",
        });
        const next = candidates.sort(
          (a, b) =>
            a.due - b.due ||
            a.priority - b.priority ||
            a.id.localeCompare(b.id),
        )[0];
        if (next.due > now) break;
        if (++steps > 256) {
          await this.tx(async () => {
            s.version++;
            await this.seal(s, "technical_interruption");
            await this.save(s);
          });
          break;
        }
        await this.tx(async () => {
          s = await this.load(sid);
          s.mission = next.due;
          s.version++;
          if (next.kind === "task")
            await this.finishTask(
              s,
              s.tasks.find((t) => t.view.taskId === next.id)!,
            );
          else if (next.kind === "operation")
            await this.advanceOperation(s, this.op(s)!);
          else if (next.kind === "medical") {
            s.medical = {
              status: "target_missed",
              targetAtMissionMs: 480000,
              note: "已到转送目标时刻，需要优先转送；请尽快抵达接收站。",
            };
            await this.event(s, "medical.target_missed", {});
            this.log(
              s,
              "consequence",
              "已到转送目标时刻，需要优先转送；请继续完成护送。",
            );
          } else await this.seal(s, "mission_deadline");
          if (s.lifecycle === "running") {
            await this.contextRecord(s);
            await this.save(s);
            await this.publicEvent(
              s,
              "projection.changed",
              await this.projection(s),
            );
          } else await this.save(s);
        });
      }
      if (s.lifecycle === "running") {
        const second = Math.floor(now / 1000);
        if (second > (this.lastClockSamples.get(sid) ?? 0)) {
          await this.tx(
            async () =>
              await this.publicEvent(s, "clock.sample", {
                missionTimeMs: now,
                serverNow: iso(this.clock.nowMs()),
                missionDeadlineMs: 600000,
              }),
          );
          this.lastClockSamples.set(sid, second);
        }
      }
      await this.flush(sid);
    }
    this.scheduleDispatch();
  }
  private async seal(
    s: State,
    reason: P.OutcomeView["terminationReason"],
    technicalSummary?: string,
  ) {
    const op = this.op(s);
    s.location = this.location(s, s.mission);
    await this.cancelTasks(s, "session_terminated");
    await this.cancelAdvisor(s, "cancelled");
    if (op) {
      op.view = {
        ...op.view,
        status: "cancelled",
        completedAt: iso(this.clock.nowMs()),
        currentLocation: s.location,
        publicProgressLabel: "任务结束，车队停止行动",
        failureCode:
          reason === "mission_deadline"
            ? "mission_deadline"
            : reason === "abandoned"
              ? "abandoned"
              : "technical_failure",
      };
      await this.store.run(
        "UPDATE operations SET status='cancelled',completed_at_ms=?,public_progress_json=? WHERE session_id=? AND operation_id=?",
        this.clock.nowMs(),
        canonical(op.view),
        s.sessionId,
        op.view.operationId,
      );
    }
    const arrived = s.arrivalMs !== null && s.arrivalMs <= 600000;
    const pending = this.pending(s);
    const outcome: P.OutcomeView = {
      sessionId: s.sessionId,
      runEpoch: s.runEpoch,
      sealedHash: "0".repeat(64),
      sealedAt: iso(this.clock.nowMs()),
      sealedAtMissionMs: s.mission,
      taskSuccess: arrived,
      terminationReason: reason,
      arrivedAtMissionMs: s.arrivalMs,
      handoffCompletedAtMissionMs: null,
      pendingTasks: pending,
      finalLocation: s.location,
      civilianCount: 20,
      medical: s.medical,
      routeIdsTaken: [...s.routeIdsTaken],
      summary:
        reason === "technical_interruption"
          ? (technicalSummary ?? "本机服务中断，本局已按最后保存状态封存。")
          : reason === "abandoned"
            ? "你结束了本次护送演练。"
            : reason === "mission_deadline"
              ? "任务时限已到。车队的位置和未完成事项已保留，供复盘。"
              : arrived
                ? "20名乘员已抵达曙光接收站。" +
                  (asLocale(s.locale) === "en-US" ? " " : "") +
                  (s.flags.manifestPending || s.flags.inspectionPending
                    ? "交接仍有待办手续。"
                    : "沿途所需手续已完成。")
                : "任务已封存。",
    };
    outcome.sealedHash = hash({
      ...outcome,
      sealedHash: undefined,
      decisions: s.decisions,
      reports: s.reports.map((r) => r.reportId),
    });
    this.log(s, "sealed", outcome.summary);
    const e = await this.event(s, "session.sealed", {
      sealedHash: outcome.sealedHash,
      outcome,
    });
    s.outcome = outcome;
    s.lifecycle =
      reason === "abandoned"
        ? "abandoned"
        : reason === "technical_interruption"
          ? "interrupted"
          : "completed";
    s.phase = "terminal";
    await this.store.insert("terminal_seals", {
      session_id: s.sessionId,
      seal_id: uid(),
      sealed_hash: outcome.sealedHash,
      terminal_lifecycle: s.lifecycle,
      terminal_seq: e.seq,
      terminal_state_version: s.version,
      terminal_mission_ms: s.mission,
      outcome_json: canonical(outcome),
      immutable_behavior_json: canonical({ decisions: s.decisions }),
      content_hash: this.world.contentHash,
      policy_hash: this.world.policyHash,
      sealed_at_ms: this.clock.nowMs(),
    });
    await this.publicEvent(s, "outcome.sealed", outcome);
    this.anchors.delete(s.sessionId);
  }
  private advisorInput(s: State, question?: A.Question): A.AdvisorInput {
    const cards = s.uploads
      .filter((u) => u.sceneId === s.sceneId)
      .map((u) => s.reports.find((r) => r.reportId === u.reportId)!.card);
    const ref = (c: P.EvidenceCard): A.EvidenceRef => ({
      instanceId: c.evidenceInstanceId,
      revision: c.revision,
    });
    const evidence: A.Evidence[] = cards.map((c) => {
      const item = s.inventory.find(
        (i) => i.card.evidenceInstanceId === c.evidenceInstanceId,
      )!;
      const d = this.world
        .case(s.caseId)
        .evidenceDefinitions.find((d) => d.definitionId === item.definitionId)!;
      const related = cards.filter(
        (other) =>
          other.evidenceInstanceId !== c.evidenceInstanceId &&
          item.traceRelated.includes(other.definitionId),
      );
      return {
        ...ref(c),
        sceneId: c.sceneId,
        observationType:
          c.statementKind === "provenance"
            ? "provenance_finding"
            : c.statementKind === "correction"
              ? "correction"
              : c.channel === "satellite"
                ? "historical_image"
                : c.statementKind === "testimony"
                  ? c.channel === "witness"
                    ? "witness_statement"
                    : "official_statement"
                  : "direct_observation",
        text: c.body,
        sourceLabel: c.sourceLabel,
        observationAgeMs: d.observationAgeMs,
        freshness: c.freshness,
        scope: c.observationScope,
        limitations: ["仅能支持文字所述观察范围，不能证明整条路线永久安全。"],
        knownSourceEdges:
          related.length > 1
            ? related.slice(1).map((other) => ({
                fromRef: ref(related[0]),
                toRef: ref(other),
                relation: "same_source_confirmed" as const,
                findingRef: ref(c),
              }))
            : [],
      };
    });
    const actions = this.world.publicActions
      .filter(
        (a) =>
          a.sceneId === s.sceneId &&
          !(s.flags.bridgeRefused && a.actionId === "E3_BRIDGE"),
      )
      .map((a) => ({
        actionId: a.actionId,
        label: a.label,
        description: a.knownRisk,
        knownDurationMs: a.knownDurationMs,
        durationQualifier: "base_only" as const,
        limitations: ["公开基础时长，现场未知条件可能增加等待。"],
      }));
    actions.push({
      actionId: "WAIT",
      label: "原地等待",
      description: "可等待15、30或60秒，岗位调查可继续。",
      knownDurationMs: null as any,
      durationQualifier: "base_only",
      limitations: ["选择与任务时间由指挥官决定，当前私有倒计时未上传。"],
    });
    const authorizedArgs: Parameters<typeof buildAdvisorInput>[0] =
      localizePublic(
        {
          sessionId: s.sessionId,
          sceneId: s.sceneId!,
          contextVersion: s.contextVersion,
          publicTask: {
            objective: "以尽可能审慎且及时的决策护送20名平民抵达曙光接收站。",
            currentNodeId: this.world.scene(s.sceneId!).nodeId,
            actions,
            channelCapabilities: CHANNELS.map((channel) => ({
              channel,
              publicTargetIds: this.world
                .case(s.caseId)
                .evidenceDefinitions.filter(
                  (d) =>
                    d.sceneId === s.sceneId &&
                    d.channel === channel &&
                    d.acquisition === "investigation",
                )
                .map((d) => d.definitionId),
              canObserve:
                channel === "satellite"
                  ? ["历史地形与道路图像"]
                  : channel === "drone"
                    ? ["特定地点可见表面与当前车道"]
                    : ["来源说明、当地接报与许可状态"],
              cannotConfirm: [
                "未观察区域与未来通行状态",
                "传闻内容不能仅凭多个转述者确定",
              ],
            })),
          },
          backgrounds: this.world.campaign.approvedBackgrounds.map(
            (b: any) => ({
              backgroundId: b.backgroundId,
              revision: 1,
              fictional: true,
              text: b.text,
              sourceLabel: "虚构场景通用任务手册",
              period: "非当前现场事实",
              scope: "一般信息判断原则",
              limitations: ["不能替代本局已获现场报告。"],
            }),
          ),
          evidence,
          statements: s.statements
            .filter((x) => x.sceneId === s.sceneId)
            .map((p) => ({
              statementId: p.statementId,
              revision: 1,
              text: p.text,
              verification: "unverified",
            })),
          question: question ?? {
            questionId: uid(),
            kind: "automatic",
            text: "请基于明确提供的资料分析当前可选路线，指出不确定性与可核验的问题。",
            selectedEvidenceRefs: [],
          },
        },
        asLocale(s.locale),
      );
    if (question) authorizedArgs.question = { ...question };
    return buildAdvisorInput(authorizedArgs);
  }
  private agentDeadline(role: "advisor" | "evaluator") {
    return (
      this.clock.nowMs() +
      (this.options.agents?.jobTimeoutMs?.[role] ??
        (role === "advisor" ? 20000 : 25000))
    );
  }
  private async enqueueAdvisor(s: State, question?: A.Question) {
    s.contextVersion++;
    await this.cancelAdvisor(s);
    const input = this.advisorInput(s, question),
      manifestId = uid(),
      jobId = uid();
    for (const u of s.uploads.filter((u) => u.sceneId === s.sceneId))
      await this.store.insert("input_manifest_members", {
        session_id: s.sessionId,
        manifest_id: manifestId,
        upload_id: u.uploadId,
      });
    for (const st of input.statements)
      await this.store.insert("manifest_statements", {
        session_id: s.sessionId,
        manifest_id: manifestId,
        statement_id: st.statementId,
      });
    await this.store.insert("input_manifests", {
      session_id: s.sessionId,
      manifest_id: manifestId,
      scene_id: s.sceneId,
      inbox_version: s.inboxVersion,
      context_version: s.contextVersion,
      context_epoch: s.contextEpoch,
      background_hash: hash(input.backgrounds),
      input_hash: input.inputHash,
      permitted_input_json: canonical(input),
      created_at_ms: this.clock.nowMs(),
    });
    await this.store.insert("agent_jobs", {
      session_id: s.sessionId,
      job_id: jobId,
      agent_role: "advisor",
      scene_id: s.sceneId,
      manifest_id: manifestId,
      status: "queued",
      mode: this.options.agents?.configured ? "live_model" : "offline_template",
      input_hash: input.inputHash,
      config_hash: this.options.agents?.configHash ?? hash("offline-core-v1"),
      input_version: s.contextVersion,
      inbox_version: s.inboxVersion,
      context_version: s.contextVersion,
      deadline_at_ms: this.agentDeadline("advisor"),
      created_at_ms: this.clock.nowMs(),
      updated_at_ms: this.clock.nowMs(),
    });
    this.jobsPending = true;
    return (await this.jobView(
      await this.store.one(
        "SELECT * FROM agent_jobs WHERE session_id=? AND job_id=?",
        s.sessionId,
        jobId,
      ),
    )) as P.AdvisorJobView;
  }
  private async upload(
    s: State,
    items: ReadonlyArray<P.UploadItem>,
    meta: CommandMeta,
    enqueue = true,
  ): Promise<P.UploadView> {
    this.ensureDecision(s);
    if (
      items.length < 1 ||
      items.length > 5 ||
      new Set(items.map((i) => i.reportId)).size !== items.length
    )
      ERR("INVALID_REQUEST", 400, "每批请选择1至5张不同报告", s);
    const selected = items.map((item) => {
      const r = s.reports.find(
        (r) => r.reportId === item.reportId && r.sceneId === s.sceneId,
      );
      if (!r) ERR("NOT_REPORTED", 422, "只能上传当前场景已收到的报告", s);
      if (r.revision !== item.expectedRevision)
        ERR("REVISION_CONFLICT", 409, "报告版本不匹配", s);
      if (
        s.uploads.some(
          (u) => u.reportId === r.reportId && u.revision === r.revision,
        )
      )
        ERR("REVISION_CONFLICT", 409, "该报告版本已上传", s);
      return r;
    });
    const charge = await this.ledger(
      s,
      `${s.sceneId}:commander:upload`,
      "spend",
      items.length,
      null,
      meta.idempotencyKey,
    );
    s.inboxVersion++;
    const added = await asyncArray.map(selected, async (r) => {
      const u: P.UploadSnapshot = {
        uploadId: uid(),
        reportId: r.reportId,
        evidenceInstanceId: r.evidenceInstanceId,
        revision: r.revision,
        sceneId: r.sceneId,
        uploadedAtMissionMs: s.mission,
        payloadHash: hash(localizePublic(r.card, asLocale(s.locale))),
      };
      await this.store.insert("uploads", {
        session_id: s.sessionId,
        upload_id: u.uploadId,
        scene_id: u.sceneId,
        report_id: r.reportId,
        report_revision: r.revision,
        charge_entry_id: charge,
        authorization_binding_id: s.actors.commander,
        uploaded_mission_ms: s.mission,
      });
      s.uploads.push(u);
      return u;
    });
    const job = enqueue ? await this.enqueueAdvisor(s) : null;
    for (const u of added)
      await this.event(
        s,
        "upload.created",
        {
          uploadId: u.uploadId,
          reportId: u.reportId,
          evidenceInstanceId: u.evidenceInstanceId,
          revision: u.revision,
          inboxVersion: s.inboxVersion,
          assistantContextVersion: s.contextVersion + (enqueue ? 0 : 1),
          spendLedgerId: charge,
        },
        "human",
        s.actors.commander,
        meta.idempotencyKey,
      );
    this.log(
      s,
      "uploaded",
      `向 AI 上传 ${added.length} 张报告`,
      "player",
      selected.map((r) => r.reportId),
    );
    const view: P.UploadView = {
      sessionId: s.sessionId,
      stateVersion: s.version,
      inboxVersion: s.inboxVersion,
      assistantContextVersion: s.contextVersion,
      added,
      currentSceneUploads: s.uploads.filter((u) => u.sceneId === s.sceneId),
      quota: (await this.uploadQuota(s))!,
      analysisJobId: job?.jobId ?? null,
    };
    await this.publicEvent(s, "uploads.changed", view);
    return view;
  }
  private async question(
    s: State,
    b: P.QuestionRequest,
    meta: CommandMeta,
  ): Promise<P.QuestionAccepted> {
    this.ensureDecision(s);
    const p = b.payload;
    if (p.expectedInboxVersion !== s.inboxVersion)
      ERR("REVISION_CONFLICT", 409, "AI收件箱已改变，请同步后再提问", s);
    if (p.uploadBatch.length) await this.upload(s, p.uploadBatch, meta, false);
    const questions: Record<string, string> = {
      explain_basis: "请解释当前判断的依据，并区分证据与推断。",
      compare_routes: "请比较当前路线的已知依据和不确定性。",
      uncertainties: "当前资料还无法回答哪些关键问题？",
      next_information: "下一条最值得核验的具体问题是什么？",
    };
    let text =
      p.text ??
      translatePublicText(questions[p.questionKind], asLocale(s.locale));
    if (!text?.trim()) ERR("INVALID_REQUEST", 400, "请输入问题", s);
    if (p.text !== null || p.questionKind === "free_text") {
      if (s.statements.length >= 100)
        ERR("RATE_LIMITED", 429, "本局未核验陈述数量已达上限", s);
      const statement: P.PlayerStatementView = {
        statementId: uid(),
        sceneId: s.sceneId!,
        text: text.trim(),
        sentAtMissionMs: s.mission,
        trustStatus: "unverified_player_statement",
      };
      s.statements.push(statement);
      await this.store.insert("player_statements", {
        session_id: s.sessionId,
        statement_id: statement.statementId,
        scene_id: s.sceneId,
        binding_id: s.actors.commander,
        statement_text: statement.text,
        trust: "unverified",
        created_mission_ms: s.mission,
      });
    }
    const kind = (
      {
        explain_basis: "why",
        compare_routes: "compare",
        uncertainties: "uncertainties",
        next_information: "next_check",
        free_text: "free_text",
      } as const
    )[p.questionKind];
    const job = await this.enqueueAdvisor(s, {
      questionId: uid(),
      kind,
      text,
      selectedEvidenceRefs: [],
    });
    await this.event(
      s,
      "agent.job_queued",
      {
        jobId: job.jobId,
        agentRole: "advisor",
        inputVersion: job.inputVersion,
      },
      "human",
      s.actors.commander,
      meta.idempotencyKey,
    );
    return {
      requestId: meta.requestId ?? meta.idempotencyKey,
      stateVersion: s.version,
      inboxVersion: s.inboxVersion,
      assistantContextVersion: s.contextVersion,
      job,
      operationLocation: `/api/v1/sessions/${s.sessionId}/advice/${job.jobId}`,
    };
  }
  private async jobView(row: any): Promise<A.AgentJobView> {
    return {
      jobId: row.job_id,
      agentRole: row.agent_role,
      status: row.status,
      mode: row.mode,
      inputVersion: row.input_version,
      createdAt: iso(row.created_at_ms),
      attemptCount: (
        await this.store.one(
          "SELECT COUNT(*) AS n FROM agent_attempts WHERE session_id=? AND job_id=?",
          row.session_id,
          row.job_id,
        )
      ).n,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error_code
        ? {
            code: row.error_code,
            retryable: [
              "MODEL_TIMEOUT",
              "MODEL_TRANSPORT",
              "MODEL_RATE_LIMIT",
            ].includes(row.error_code),
          }
        : null,
    };
  }
  private async currentJob(s: State): Promise<P.AdvisorJobView | null> {
    const row = await this.store.one(
      "SELECT * FROM agent_jobs WHERE session_id=? AND agent_role='advisor' AND scene_id=? AND context_version=? AND status NOT IN ('cancelled','superseded') ORDER BY created_at_ms DESC LIMIT 1",
      s.sessionId,
      s.sceneId,
      s.contextVersion,
    );
    return row ? ((await this.jobView(row)) as P.AdvisorJobView) : null;
  }
  private async receipt(
    s: State,
    b: P.DisplayReceiptRequest,
  ): Promise<P.ReceiptView> {
    const p = b.payload;
    let key: string,
      kind: "opened" | "displayed" = "displayed";
    if (p.displayKind === "report_opened") {
      if (!s.reports.some((r) => r.reportId === p.reportId))
        ERR("RESOURCE_NOT_FOUND", 404, "报告尚未向你公开", s);
      key = `report:${p.reportId}`;
      kind = "opened";
    } else if (p.displayKind === "advice_displayed") {
      const job = await this.store.one(
        "SELECT * FROM agent_jobs WHERE session_id=? AND job_id=?",
        s.sessionId,
        p.jobId,
      );
      if (!job?.result_json || job.agent_role !== "advisor")
        ERR("RESOURCE_NOT_FOUND", 404, "该建议尚未生成", s);
      key = `advice:${p.jobId}`;
    } else if (p.displayKind === "consequence_seen") {
      key = `operation:${p.operationId}`;
    } else
      key = `context:${b.observedSceneId ?? "briefing"}:${b.observedStateVersion}`;
    const record = await this.store.one(
      "SELECT * FROM runtime_display_bindings WHERE session_id=? AND record_key=?",
      s.sessionId,
      key,
    );
    if (!record) ERR("RESOURCE_NOT_FOUND", 404, "该公开记录尚不存在", s);
    const old = await this.store.one(
      "SELECT receipt_id FROM display_receipts WHERE session_id=? AND binding_id=? AND public_record_id=? AND record_revision=? AND receipt_kind=?",
      s.sessionId,
      s.actors.commander,
      record.public_record_id,
      record.revision,
      kind,
    );
    if (old)
      return {
        receiptId: old.receipt_id,
        accepted: true,
        stateVersion: s.version,
      };
    const rid = uid();
    await this.store.insert("display_receipts", {
      session_id: s.sessionId,
      receipt_id: rid,
      binding_id: s.actors.commander,
      public_record_id: record.public_record_id,
      record_revision: record.revision,
      receipt_kind: kind,
      recorded_mission_ms: s.mission,
      received_at_ms: this.clock.nowMs(),
    });
    if (p.reportId && !s.viewedReportIds.includes(p.reportId))
      s.viewedReportIds.push(p.reportId);
    if (p.jobId && !s.displayedAdviceIds.includes(p.jobId))
      s.displayedAdviceIds.push(p.jobId);
    if (p.displayKind === "context_displayed") s.contextDisplayed = true;
    await this.event(
      s,
      "display.received",
      {
        receiptId: rid,
        displayKind: p.displayKind,
        reportId: p.reportId,
        jobId: p.jobId,
        operationId: p.operationId,
        observedStateVersion: b.observedStateVersion,
        observedSceneId: b.observedSceneId,
      },
      "human",
      s.actors.commander,
    );
    return { receiptId: rid, accepted: true, stateVersion: s.version };
  }
  private provenance(s: State, scene = s.sceneId): P.ProvenanceView {
    if (!scene) ERR("PHASE_NOT_ALLOWED", 422, "尚未进入决策现场", s);
    const reports = s.reports.filter((r) => r.sceneId === scene);
    // UUIDv5: the session is the namespace; names contain only disclosed public
    // report relationships. Re-reading a graph never assigns new identifiers.
    const disclosureId = (...name: string[]): string => {
      const bytes = createHash("sha1")
        .update(Buffer.from(s.sessionId.replaceAll("-", ""), "hex"))
        .update(canonical(["provenance-v1", ...name]))
        .digest();
      bytes[6] = (bytes[6]! & 0x0f) | 0x50;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = bytes.subarray(0, 16).toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    const nodes: P.ProvenanceNode[] = reports.map((r) => ({
      nodeId: r.reportId,
      kind: "report",
      label: r.card.title,
      reportId: r.reportId,
    }));
    const edges: P.ProvenanceEdge[] = [];
    for (const report of reports) {
      const item = s.inventory.find(
        (i) => i.card.evidenceInstanceId === report.evidenceInstanceId,
      )!;
      if (!item.traceRelated.length) continue;
      const nodeId = disclosureId("source", report.reportId);
      nodes.push({
        nodeId,
        kind: "verified_source",
        label: item.traceRootLabel ?? "已核验的传播链",
        reportId: null,
      });
      for (const r of reports.filter((r) =>
        item.traceRelated.includes(r.card.definitionId),
      ))
        edges.push({
          edgeId: disclosureId("same_origin", report.reportId, r.reportId),
          fromNodeId: r.reportId,
          toNodeId: nodeId,
          relation: "same_origin",
          status: "verified",
          disclosedByReportId: report.reportId,
        });
    }
    return {
      sessionId: s.sessionId,
      sceneId: scene,
      stateVersion: s.version,
      nodes,
      edges,
      notice:
        "只显示通过已收到报告披露的来源关系。同源关系确认不等于内容全部正确。",
    };
  }
  private async choiceMeta(s: State, version: number) {
    const current = await this.currentJob(s);
    const shown = current
      ? await this.shownAt(s, `advice:${current.jobId}`)
      : null;
    return {
      eligibleAdviceJobId:
        current?.status === "succeeded" &&
        current.mode === "live_model" &&
        shown !== null &&
        shown <= s.mission
          ? current.jobId
          : null,
      contextDisplayedAtMs: await this.shownAt(
        s,
        `context:${s.sceneId ?? "briefing"}:${version}`,
      ),
      availableChecks: (await this.taskOptions(s)).flatMap((o) =>
        questionKeysForTarget(o.targetId).map((questionKey) => ({
          questionKey,
          available: o.available,
          affordable: o.available,
        })),
      ),
    };
  }
  private async shownAt(s: State, key: string): Promise<number | null> {
    const row = await this.store.one(
      "SELECT MIN(d.recorded_mission_ms) AS at FROM display_receipts d JOIN runtime_display_bindings b ON b.session_id=d.session_id AND b.public_record_id=d.public_record_id WHERE d.session_id=? AND b.record_key=?",
      s.sessionId,
      key,
    );
    return row?.at ?? null;
  }
  private async evaluatorInput(s: State): Promise<A.EvaluatorInput> {
    const slices: FilteredDecisionSlice[] = await asyncArray.map(
      s.decisions,
      async (d) => {
        const snap = await this.store.one(
          "SELECT d.*,e.event_id FROM decision_snapshots d JOIN events e ON e.session_id=d.session_id AND e.seq=d.source_seq WHERE d.session_id=? AND d.snapshot_id=?",
          s.sessionId,
          d.decisionId,
        );
        const displayedReports = await asyncArray.map(
          d.viewedReportIds
            .map((id) => s.reports.find((r) => r.reportId === id)!)
            .filter(Boolean),
          async (r) => ({
            instanceId: r.evidenceInstanceId,
            revision: r.revision,
            definitionId: r.card.definitionId,
            body: r.card.body,
            freshness: r.card.freshness,
            displayedAtMissionMs:
              (await this.shownAt(s, `report:${r.reportId}`)) ??
              d.committedAtMissionMs,
          }),
        );
        const uploads = d.uploadedIds
          .map((id) => s.uploads.find((u) => u.uploadId === id)!)
          .filter(Boolean);
        const jobIds = d.displayedAdviceJobIds.slice().reverse();
        let displayedAdvice: FilteredDecisionSlice["displayedAdvice"] = null;
        for (const id of jobIds) {
          const row = await this.store.one(
              "SELECT * FROM agent_jobs WHERE session_id=? AND job_id=? AND scene_id=? AND agent_role='advisor' AND result_json IS NOT NULL",
              s.sessionId,
              id,
              d.sceneId,
            ),
            at = await this.shownAt(s, `advice:${id}`);
          if (row && at !== null && at <= d.committedAtMissionMs) {
            displayedAdvice = {
              jobId: id,
              displayedAtMissionMs: at,
              output: JSON.parse(row.result_json),
            };
            break;
          }
        }
        const contextRow = await this.store.one(
          "SELECT MIN(d.recorded_mission_ms) AS at FROM display_receipts d JOIN public_records p ON p.session_id=d.session_id AND p.public_record_id=d.public_record_id WHERE d.session_id=? AND p.record_kind='briefing' AND json_extract(p.public_payload_json,'$.sceneId')=? AND d.recorded_mission_ms<=?",
          s.sessionId,
          d.sceneId,
          d.committedAtMissionMs,
        );
        return {
          contextId: d.decisionId,
          sourceEventId: snap.event_id,
          sceneId: d.sceneId,
          subjectBindingId: s.actors.commander,
          controllerKind: "human",
          kind:
            s.decisionMeta?.[d.decisionId]?.kind ??
            (d.actionId === "WAIT" ? "wait" : "route_decision"),
          cutoffMissionMs: d.committedAtMissionMs,
          chosenActionId: d.actionId,
          legalActionIds: d.legalActionIds,
          displayedReports,
          advisorUploadedRefs: uploads.map((u) => ({
            instanceId: u.evidenceInstanceId,
            revision: u.revision,
          })),
          displayedAdvice,
          reasonAnnotation: d.reasonAnnotation,
          reasonText: d.reason,
          referencedEvidenceRefs: (
            await asyncArray.filter(d.viewedReportIds, async (id) => {
              const event = JSON.parse(
                (
                  await this.store.one(
                    "SELECT payload_json FROM events WHERE session_id=? AND seq=?",
                    s.sessionId,
                    snap.source_seq,
                  )
                ).payload_json,
              );
              return event.referencedReportIds?.includes(id);
            })
          ).map((id) => {
            const r = s.reports.find((r) => r.reportId === id)!;
            return { instanceId: r.evidenceInstanceId, revision: r.revision };
          }),
          visibleCostSummary: d.knownCosts
            .map((c) => `${c.actionId}: ${c.cost.description}`)
            .join("；"),
          contextDisplayedAtMs:
            s.decisionMeta?.[d.decisionId]?.contextDisplayedAtMs ?? null,
          availableChecks:
            s.decisionMeta?.[d.decisionId]?.availableChecks ?? [],
          check: s.decisionMeta?.[d.decisionId]?.check ?? null,
          oralKnowledgeStatus: "not_collected",
          unobservedCommunication: false,
          coverageComplete: true,
          technicalLimitations: [],
        };
      },
    );
    return localizePublic(
      buildEvaluatorInput({
        sessionId: s.sessionId,
        sealedHash: s.outcome!.sealedHash,
        subjectBindingId: s.actors.commander,
        decisions: slices,
        terminalKind:
          s.outcome!.terminationReason === "technical_interruption"
            ? "technical_interruption"
            : s.outcome!.terminationReason === "abandoned"
              ? "abandoned"
              : s.runPurpose === "design_preview"
                ? "demo"
                : "normal_end",
        limitations: [
          "评价仅针对本次已记录行为；未选填的理由和未收到的展示回执不作推断。",
        ],
      }),
      asLocale(s.locale),
    );
  }
  private async audit(s: State, eventType: string, data: unknown) {
    const auditId = uid();
    await this.store.insert("diagnostic_records", {
      session_id: s.sessionId,
      diagnostic_id: auditId,
      category: "postgame_audit",
      recorded_at_ms: this.clock.nowMs(),
      payload_json: canonical({
        auditId,
        sessionId: s.sessionId,
        sealedHash: s.outcome!.sealedHash,
        createdAt: iso(this.clock.nowMs()),
        eventType,
        data,
      }),
    });
  }
  private async evaluate(
    s: State,
    _b: P.EvaluationRequest,
    meta: CommandMeta,
  ): Promise<P.EvaluationAccepted> {
    const configHash =
      this.options.agents?.configHash ?? hash("offline-core-v1");
    let row = await this.store.one(
      "SELECT * FROM agent_jobs WHERE session_id=? AND agent_role='evaluator' AND seal_hash=? AND config_hash=?",
      s.sessionId,
      s.outcome!.sealedHash,
      configHash,
    );
    if (row) {
      const count = (
        await this.store.one(
          "SELECT COUNT(*) AS n FROM agent_attempts WHERE session_id=? AND job_id=?",
          s.sessionId,
          row.job_id,
        )
      ).n;
      if (
        ["fallback", "failed"].includes(row.status) &&
        count < row.max_attempts &&
        this.options.agents?.configured
      ) {
        await this.store.run(
          "UPDATE agent_jobs SET status='queued',mode='live_model',deadline_at_ms=?,updated_at_ms=? WHERE session_id=? AND job_id=?",
          this.agentDeadline("evaluator"),
          this.clock.nowMs(),
          s.sessionId,
          row.job_id,
        );
        row = await this.store.one(
          "SELECT * FROM agent_jobs WHERE session_id=? AND job_id=?",
          s.sessionId,
          row.job_id,
        );
      }
    } else {
      const input = await this.evaluatorInput(s);
      for (const fact of input.facts) {
        const snap = await this.store.one(
          "SELECT source_seq,state_version FROM decision_snapshots WHERE session_id=? AND snapshot_id=?",
          s.sessionId,
          fact.contextId,
        );
        await this.store.insert("behavior_facts", {
          session_id: s.sessionId,
          fact_id: fact.factId,
          seal_hash: s.outcome!.sealedHash,
          context_id: fact.contextId,
          rule_id: `${fact.ruleId}:${fact.kind}`,
          subject_binding_id: s.actors.commander,
          cutoff_seq: snap.source_seq,
          cutoff_state_version: snap.state_version,
          fact_payload_json: canonical(fact),
          visible_refs_json: canonical(fact.evidenceRefs),
        });
      }
      const jobId = uid();
      await this.store.insert("agent_jobs", {
        session_id: s.sessionId,
        job_id: jobId,
        agent_role: "evaluator",
        seal_hash: s.outcome!.sealedHash,
        status: "queued",
        mode: this.options.agents?.configured
          ? "live_model"
          : "offline_template",
        input_hash: hash(input),
        config_hash: configHash,
        input_version: 1,
        evaluator_input_json: canonical(input),
        deadline_at_ms: this.agentDeadline("evaluator"),
        created_at_ms: this.clock.nowMs(),
        updated_at_ms: this.clock.nowMs(),
      });
      await this.audit(s, "evaluator.job_queued", { jobId, inputVersion: 1 });
      row = await this.store.one(
        "SELECT * FROM agent_jobs WHERE session_id=? AND job_id=?",
        s.sessionId,
        jobId,
      );
    }
    if (row.status === "queued") this.jobsPending = true;
    return {
      requestId: meta.requestId ?? meta.idempotencyKey,
      sealedHash: s.outcome!.sealedHash,
      job: (await this.jobView(row)) as P.EvaluationJobView,
      operationLocation: `/api/v1/sessions/${s.sessionId}/evaluations/${row.job_id}`,
    };
  }
  private replayCursor(s: State, offset: number) {
    const h = hash(`${s.outcome!.sealedHash}:replay:${offset}`).slice(0, 32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
  }
  private replay(s: State, offset = 0): P.ReplayView {
    return {
      sessionId: s.sessionId,
      sealedHash: s.outcome!.sealedHash,
      decisions: s.decisions.slice(offset, offset + 25),
      reports: s.reports,
      playerStatements: s.statements,
      publicLog: s.publicLog.slice(0, 200),
      nextCursor:
        offset + 25 < s.decisions.length
          ? this.replayCursor(s, offset + 25)
          : null,
    };
  }
  private async export(
    s: State,
    b: P.ExportRequest,
    meta: CommandMeta,
  ): Promise<P.ExportAccepted> {
    const exportId = uid();
    const pages: P.ReplayView[] = [];
    for (
      let offset = 0;
      offset < Math.max(1, s.decisions.length);
      offset += 25
    ) {
      const page = this.replay(s, offset);
      if (!b.includePlayerStatements) page.playerStatements = [];
      pages.push(page);
    }
    const job = await this.store.one(
      "SELECT * FROM agent_jobs WHERE session_id=? AND agent_role='evaluator' ORDER BY created_at_ms DESC LIMIT 1",
      s.sessionId,
    );
    const artifact: P.ExportArtifact = localizePublic(
      {
        format: "last-mile-review-json",
        formatVersion: "0.5",
        outcome: s.outcome!,
        replayPages: pages,
        includedPlayerStatements: b.includePlayerStatements,
        generatedAt: iso(this.clock.nowMs()),
        evaluationJob: job
          ? ((await this.jobView(job)) as P.EvaluationJobView)
          : null,
      },
      asLocale(s.locale),
    );
    await this.store.insert("export_jobs", {
      session_id: s.sessionId,
      export_id: exportId,
      sealed_hash: s.outcome!.sealedHash,
      request_id: meta.idempotencyKey,
      export_kind: "public_replay",
      status: "completed",
      relative_output_path: `sqlite-artifacts/${exportId}.json`,
      output_hash: hash(artifact),
      created_at_ms: this.clock.nowMs(),
      completed_at_ms: this.clock.nowMs(),
    });
    await this.store.insert("runtime_export_artifacts", {
      export_id: exportId,
      session_id: s.sessionId,
      artifact_json: canonical(artifact),
    });
    await this.audit(s, "export.finished", { exportId, status: "succeeded" });
    const view = await this.exportView(s.sessionId, exportId);
    await this.publicEvent(s, "export.updated", view);
    return {
      requestId: meta.requestId ?? meta.idempotencyKey,
      export: view,
      operationLocation: `/api/v1/sessions/${s.sessionId}/exports/${exportId}`,
    };
  }
  private async exportView(sid: string, id: string): Promise<P.ExportView> {
    const row = await this.store.one(
      "SELECT * FROM export_jobs WHERE session_id=? AND export_id=?",
      sid,
      id,
    );
    if (!row) ERR("RESOURCE_NOT_FOUND", 404, "找不到导出结果");
    return {
      exportId: id,
      sessionId: sid,
      sealedHash: row.sealed_hash,
      status: row.status === "completed" ? "succeeded" : row.status,
      createdAt: iso(row.created_at_ms),
      completedAt: row.completed_at_ms ? iso(row.completed_at_ms) : null,
      artifact:
        row.status === "completed"
          ? JSON.parse(
              (
                await this.store.one(
                  "SELECT artifact_json FROM runtime_export_artifacts WHERE session_id=? AND export_id=?",
                  sid,
                  id,
                )
              ).artifact_json,
            )
          : null,
      errorCode: row.error_code ?? null,
    };
  }
  private async readInternal(
    operationId: ReadOperation,
    sessionId?: string,
    id?: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<unknown> {
    const locale = sessionId
      ? ((await this.getSessionLocaleInternal(sessionId)) ?? "en-US")
      : "en-US";
    try {
      return localizePublic(
        await this.readCanonical(operationId, sessionId, id, query),
        locale,
      );
    } catch (error) {
      if (error instanceof DomainError)
        error.message = translateFixed(error.message, locale);
      throw error;
    }
  }
  private async readCanonical(
    operationId: ReadOperation,
    sessionId?: string,
    id?: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<unknown> {
    if (operationId === "getHealth")
      return {
        status:
          this.options.agents?.configured && !this.closed && !this.storageFailed
            ? "ok"
            : "degraded",
        apiVersion: "v1",
        contractVersion: "0.5",
        // Initialization/liveness only: an idle PostgreSQL socket may sleep.
        // The next real operation reconnects; its failure freezes this process.
        storageReady: !this.closed && !this.storageFailed,
        modelConfigured: !!this.options.agents?.configured,
      } satisfies P.HealthView;
    if (operationId === "getBootstrap")
      return {
        launchId: this.launchId,
        apiVersion: "v1",
        contractVersion: "0.5",
        capabilities: [
          "commander.read",
          "session.create",
          "session.command",
          "evaluation.request",
          "export.request",
        ],
        profiles: [
          {
            profileId: "SINGLE_PLAYER_REFERENCE",
            status: "review",
            mode: "single_player",
            normalStartAllowed: false,
            designPreviewAllowed: true,
            policyHash: this.world.policyHash,
            contentVersionId: this.contentVersionId,
            description:
              "设计预览：单人指挥官、NPC岗位与三处决策；规则仍待团队评审。",
          },
        ],
        defaultLocale: "en-US",
        supportedLocales: ["en-US", "zh-CN"],
        maximumRequestBytes: 65536,
        sseReconnectMs: 2000,
      } satisfies P.BootstrapView;
    if (!sessionId) ERR("INVALID_REQUEST", 400, "缺少会话");
    await this.authorize(sessionId);
    await this.tickInternal(sessionId);
    const s = await this.load(sessionId);
    switch (operationId) {
      case "getSession":
        return await this.projection(s);
      case "getTask": {
        const t = s.tasks.find((t) => t.view.taskId === id);
        if (!t) ERR("RESOURCE_NOT_FOUND", 404, "找不到任务", s);
        return t.view;
      }
      case "getReport": {
        const r = s.reports.find((r) => r.reportId === id);
        if (!r) ERR("RESOURCE_NOT_FOUND", 404, "该报告尚未上报", s);
        return r;
      }
      case "getOperation": {
        const op = s.operations.find((o) => o.view.operationId === id);
        if (!op) ERR("RESOURCE_NOT_FOUND", 404, "找不到行动", s);
        return this.operationView(s, op);
      }
      case "getAdvice":
      case "getEvaluation": {
        const row = await this.store.one(
          "SELECT * FROM agent_jobs WHERE session_id=? AND job_id=? AND agent_role=?",
          sessionId,
          id,
          operationId === "getAdvice" ? "advisor" : "evaluator",
        );
        if (!row) ERR("RESOURCE_NOT_FOUND", 404, "找不到该工作", s);
        return await this.jobView(row);
      }
      case "getProvenance":
        return this.provenance(
          s,
          (query.sceneId as P.SceneId | undefined) ?? s.sceneId,
        );
      case "getOutcome":
        if (!s.outcome) ERR("NOT_TERMINAL", 422, "任务还未结束", s);
        return s.outcome;
      case "getReplay": {
        if (!s.outcome) ERR("NOT_TERMINAL", 422, "任务还未结束", s);
        let offset = 0;
        if (query.cursor) {
          offset = -1;
          for (let i = 25; i < s.decisions.length; i += 25)
            if (this.replayCursor(s, i) === query.cursor) offset = i;
          if (offset < 0)
            ERR("CURSOR_SCOPE_MISMATCH", 403, "回放游标不属于本局", s);
        }
        return this.replay(s, offset);
      }
      case "getExport":
        return await this.exportView(sessionId, id!);
      default:
        ERR("RESOURCE_NOT_FOUND", 404, "未知读取操作");
    }
  }
  private async getEventsSinceInternal(
    sessionId: string,
    cursor?: string,
  ): Promise<P.PublicSseEvent[]> {
    await this.authorize(sessionId);
    let after = 0;
    if (cursor) {
      const at = cursor.lastIndexOf(":");
      if (
        cursor.slice(0, at) !== (await this.load(sessionId)).runEpoch ||
        !/^\d+$/.test(cursor.slice(at + 1))
      )
        ERR("CURSOR_SCOPE_MISMATCH", 403, "事件游标不属于当前会话");
      after = Number(cursor.slice(at + 1));
      if (after > (await this.cursor(await this.load(sessionId))))
        ERR("CURSOR_EXPIRED", 410, "事件游标超过当前记录");
    }
    return (
      await this.store.all(
        "SELECT public_payload_json FROM view_events WHERE session_id=? AND view_role='commander' AND cursor>? ORDER BY cursor LIMIT 250",
        sessionId,
        after,
      )
    ).map((r) => JSON.parse(r.public_payload_json));
  }
  private async subscribeInternal(
    sessionId: string,
    listener: (e: P.PublicSseEvent) => void,
  ) {
    await this.authorize(sessionId);
    let listeners = this.listeners.get(sessionId);
    if (!listeners) {
      listeners = new Map();
      this.listeners.set(sessionId, listeners);
    }
    listeners.set(listener, await this.cursor(await this.load(sessionId)));
    return () => {
      listeners!.delete(listener);
      if (!listeners!.size) this.listeners.delete(sessionId);
    };
  }
  startScheduler() {
    if (!this.timer)
      this.timer = setInterval(() => {
        if (
          this.closed ||
          this.closing ||
          this.storageFailed ||
          this.schedulerBusy ||
          (!this.liveSessions.size && !this.jobsPending)
        )
          return;
        this.schedulerBusy = true;
        void this.tick()
          .catch(() => console.error("Core scheduler unavailable"))
          .finally(() => {
            this.schedulerBusy = false;
          });
      }, 1000);
    this.timer.unref();
    return () => {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
  private async recover() {
    for (const row of await this.store.all(
      "SELECT * FROM agent_attempts WHERE status IN ('sending','running')",
    ))
      await this.store.run(
        "UPDATE agent_attempts SET status='unknown',finished_at_ms=?,error_code='MODEL_TRANSPORT' WHERE session_id=? AND job_id=? AND attempt_no=?",
        Math.max(this.clock.nowMs(), row.sent_at_ms),
        row.session_id,
        row.job_id,
        row.attempt_no,
      );
    await this.store.run(
      "UPDATE agent_jobs SET status='failed',error_code='MODEL_TRANSPORT',updated_at_ms=? WHERE agent_role='evaluator' AND status IN ('queued','running')",
      this.clock.nowMs(),
    );
    for (const row of await this.store.all(
      "SELECT session_id FROM sessions WHERE lifecycle IN ('briefing','running')",
    )) {
      await this.tx(async () => {
        const s = await this.load(row.session_id);
        s.version++;
        await this.seal(s, "technical_interruption");
        await this.save(s);
      });
    }
  }
  private async closeInternal() {
    if (this.closed || this.closing) return;
    this.closing = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      if (this.storageFailed) return;
      for (const sid of this.granted) {
        // Sample once. Events due at shutdown are committed before deciding whether
        // a technical interruption remains necessary; no model work starts here.
        const cutoff = this.missionNow(await this.load(sid));
        await this.tickInternal(sid, cutoff);
        const s = await this.load(sid);
        if (LIVE.has(s.lifecycle))
          await this.tx(async () => {
            s.mission = cutoff;
            s.version++;
            await this.seal(s, "technical_interruption");
            await this.save(s);
          });
      }
      await this.store.run(
        "UPDATE launches SET ended_at_ms=? WHERE launch_id=?",
        this.clock.nowMs(),
        this.launchId,
      );
    } finally {
      this.closed = true;
      await this.store.close();
    }
  }
  private async dispatch() {
    if (this.closed || this.closing || this.storageFailed || !this.jobsPending)
      return;
    const slots =
      (this.options.cloud?.maxConcurrentModelJobs ?? Number.MAX_SAFE_INTEGER) -
      this.dispatched.size;
    if (slots <= 0) return;
    const rows = await this.store.all(
      "SELECT * FROM agent_jobs WHERE status='queued' ORDER BY created_at_ms LIMIT ?",
      Math.min(slots, 100) + 1,
    );
    this.jobsPending = rows.length > Math.min(slots, 100);
    for (const row of rows.slice(0, Math.min(slots, 100))) {
      if (this.dispatched.has(row.job_id)) continue;
      try {
        // Complete every fallible read before occupying a slot or changing status.
        // A storage failure here leaves a durable queued job for recovery.
        const locale = asLocale((await this.load(row.session_id)).locale);
        const input =
          row.agent_role === "advisor"
            ? JSON.parse(
                (
                  await this.store.one(
                    "SELECT permitted_input_json FROM input_manifests WHERE session_id=? AND manifest_id=?",
                    row.session_id,
                    row.manifest_id,
                  )
                ).permitted_input_json,
              )
            : JSON.parse(row.evaluator_input_json);
        await this.tx(async () => {
          await this.store.run(
            "UPDATE agent_jobs SET status='running',updated_at_ms=? WHERE session_id=? AND job_id=?",
            this.clock.nowMs(),
            row.session_id,
            row.job_id,
          );
        });
        this.dispatched.add(row.job_id);
        const current = async () => {
          if (this.closed || this.closing || this.storageFailed) return false;
          const j = await this.store.one(
            "SELECT status FROM agent_jobs WHERE session_id=? AND job_id=?",
            row.session_id,
            row.job_id,
          );
          if (!j || j.status !== "running") return false;
          const s = await this.load(row.session_id);
          return row.agent_role === "evaluator"
            ? s.outcome?.sealedHash === row.seal_hash
            : s.lifecycle === "running" &&
                s.sceneId === row.scene_id &&
                s.contextVersion === row.context_version;
        };
        const control: AttemptControl = {
          locale,
          isCurrent: () => this.serialized(current),
          beginAttempt: () =>
            this.serialized(async () => {
              if (!(await current())) throw Error("CONTEXT_SUPERSEDED");
              return this.tx(async () => {
                const count = Number(
                  (
                    await this.store.one(
                      "SELECT COUNT(*) AS n FROM agent_attempts WHERE session_id=? AND job_id=?",
                      row.session_id,
                      row.job_id,
                    )
                  ).n,
                );
                const ticket = { attemptNo: count + 1, requestKey: uid() };
                await this.store.insert("agent_attempts", {
                  session_id: row.session_id,
                  job_id: row.job_id,
                  attempt_no: ticket.attemptNo,
                  request_key: ticket.requestKey,
                  status: "sending",
                  sent_at_ms: this.clock.nowMs(),
                });
                if (this.options.cloud) {
                  const day = iso(this.clock.nowMs()).slice(0, 10);
                  await this.store.run(
                    "INSERT INTO cloud_daily_usage(day,attempt_count) VALUES(?,0) ON CONFLICT(day) DO NOTHING",
                    day,
                  );
                  const reserved = await this.store.run(
                    "UPDATE cloud_daily_usage SET attempt_count=attempt_count+1 WHERE day=? AND attempt_count<?",
                    day,
                    this.options.cloud.maxModelAttemptsPerDay,
                  );
                  if (reserved.changes !== 1)
                    throw Error("MODEL_BUDGET_EXHAUSTED");
                }
                return ticket;
              });
            }),
          finishAttempt: (n, result) =>
            this.serialized(async () => {
              if (this.closed) return;
              await this.tx(async () => {
                const a = await this.store.one(
                  "SELECT * FROM agent_attempts WHERE session_id=? AND job_id=? AND attempt_no=?",
                  row.session_id,
                  row.job_id,
                  n,
                );
                if (!a || !["sending", "running"].includes(a.status)) return;
                await this.store.run(
                  "UPDATE agent_attempts SET status=?,finished_at_ms=?,provider_request_id=?,input_tokens=?,output_tokens=?,response_hash=?,error_code=? WHERE session_id=? AND job_id=? AND attempt_no=?",
                  result.status,
                  Math.max(this.clock.nowMs(), a.sent_at_ms),
                  result.providerRequestId ?? null,
                  result.inputTokens ?? null,
                  result.outputTokens ?? null,
                  result.responseHash ?? null,
                  result.errorCode ?? null,
                  row.session_id,
                  row.job_id,
                  n,
                );
              });
            }),
        };
        // No model invocation, provider callback, or completion inherits a DB
        // transaction's AsyncLocalStorage context or occupies the command queue.
        this.detached.runInAsyncScope(() => {
          const run = async () =>
            row.agent_role === "advisor"
              ? this.options.agents!.runAdvisor(input, control)
              : this.options.agents!.runEvaluator(input, control);
          void run()
            .then(
              (result) =>
                this.serialized(async () => {
                  if (await current()) await this.publishJob(row, result);
                }),
              () =>
                this.serialized(async () => {
                  if (await current())
                    await this.publishJob(row, {
                      status: "failed",
                      mode: row.mode,
                      result: null,
                      error: { code: "MODEL_TRANSPORT", retryable: true },
                    });
                }),
            )
            .catch(() => console.error("Agent completion unavailable"))
            .finally(() => {
              void this.serialized(async () => {
                this.dispatched.delete(row.job_id);
                this.scheduleDispatch();
              }).catch(() => {});
            });
        });
      } catch (error) {
        this.dispatched.delete(row.job_id);
        this.jobsPending = true;
        throw error;
      }
    }
  }
  private async publishJob(row: any, result: AgentCompletion) {
    if (this.closed) return;
    const sid = row.session_id;
    const receivedMission = this.missionNow(await this.load(sid));
    if (row.agent_role === "advisor")
      await this.tickInternal(sid, receivedMission);
    await this.tx(async () => {
      const current = await this.store.one(
        "SELECT * FROM agent_jobs WHERE session_id=? AND job_id=?",
        sid,
        row.job_id,
      );
      if (current.status !== "running") return;
      const s = await this.load(sid);
      if (
        row.agent_role === "advisor" &&
        (s.lifecycle !== "running" ||
          s.sceneId !== row.scene_id ||
          s.contextVersion !== row.context_version)
      )
        return;
      await this.store.run(
        "UPDATE agent_jobs SET status=?,mode=?,result_json=?,error_code=?,updated_at_ms=? WHERE session_id=? AND job_id=?",
        result.status,
        result.mode,
        result.result ? canonical(result.result) : null,
        result.error?.code ?? null,
        this.clock.nowMs(),
        sid,
        row.job_id,
      );
      const view = await this.jobView(
        await this.store.one(
          "SELECT * FROM agent_jobs WHERE session_id=? AND job_id=?",
          sid,
          row.job_id,
        ),
      );
      if (row.agent_role === "advisor") {
        s.mission = Math.max(s.mission, receivedMission);
        s.version++;
        await this.event(
          s,
          "agent.job_finished",
          { jobId: row.job_id, status: result.status, mode: result.mode },
          "system",
        );
        if (result.result)
          await this.publicRecord(s, `advice:${row.job_id}`, "advice", view);
        this.log(
          s,
          "advice_displayed",
          result.mode === "offline_template"
            ? "离线资料检查模板已准备，尚未视为玩家已阅读。"
            : "AI分析已准备，尚未视为玩家已阅读。",
          "assistant",
          [],
          row.job_id,
        );
        await this.contextRecord(s);
        await this.save(s);
        await this.publicEvent(s, "advice.updated", view);
        await this.publicEvent(
          s,
          "projection.changed",
          await this.projection(s),
        );
      } else {
        if (result.result) {
          const revision =
            ((
              await this.store.one(
                "SELECT MAX(revision) AS n FROM evaluation_reports WHERE session_id=? AND sealed_hash=? AND config_hash=?",
                sid,
                row.seal_hash,
                row.config_hash,
              )
            )?.n ?? 0) + 1;
          await this.store.insert("evaluation_reports", {
            session_id: sid,
            evaluation_id: uid(),
            job_id: row.job_id,
            sealed_hash: row.seal_hash,
            config_hash: row.config_hash,
            revision,
            mode: result.mode,
            report_json: canonical(result.result),
            created_at_ms: this.clock.nowMs(),
          });
        }
        await this.audit(s, "evaluator.job_finished", {
          jobId: row.job_id,
          status: result.status,
          mode: result.mode,
        });
        await this.publicEvent(s, "evaluation.updated", view);
      }
    });
    await this.flush(sid);
  }
}
