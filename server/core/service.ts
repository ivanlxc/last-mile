import type * as Public from "../../docs/engineering_v0.5/contracts/public.types.js";
import type * as Agent from "../../docs/engineering_v0.5/contracts/agent-derived.types.js";
import type { Store } from "./store.js";
export type { Public, Agent };
export type MutationOperation =
  | "createSession"
  | "startSession"
  | "createTask"
  | "uploadReports"
  | "askAdvisor"
  | "commitAction"
  | "recordDisplay"
  | "abandonSession"
  | "requestEvaluation"
  | "createExport";
export type ReadOperation =
  | "getHealth"
  | "getBootstrap"
  | "getSession"
  | "getTask"
  | "getReport"
  | "getAdvice"
  | "getOperation"
  | "getProvenance"
  | "getOutcome"
  | "getEvaluation"
  | "getReplay"
  | "getExport";
export interface CommandMeta {
  sessionId?: string;
  idempotencyKey: string;
  runEpoch?: string;
  requestId?: string;
  launchId?: string;
  playerId?: string;
}
export interface Clock {
  nowMs(): number;
  monotonicMs(): number;
}
export interface AttemptControl {
  readonly locale?: "en-US" | "zh-CN";
  beginAttempt():
    | { attemptNo: number; requestKey: string }
    | Promise<{ attemptNo: number; requestKey: string }>;
  finishAttempt(
    attemptNo: number,
    result: {
      status: "succeeded" | "failed" | "timeout" | "unknown";
      errorCode?: string;
      inputTokens?: number;
      outputTokens?: number;
      providerRequestId?: string;
      responseHash?: string;
    },
  ): void | Promise<void>;
  isCurrent(): boolean | Promise<boolean>;
}
export interface AgentCompletion {
  mode: "live_model" | "offline_template";
  status: "succeeded" | "fallback" | "failed";
  result: Agent.AdvisorOutput | Agent.EvaluatorOutput | null;
  error?: {
    code: NonNullable<Agent.AgentJobView["error"]>["code"];
    retryable: boolean;
  };
}
/** The gateway receives an already allowlisted frozen input, never a world/case/session record. */
export interface AgentGateway {
  configured: boolean;
  configHash: string;
  /** Internal whole-job wall-clock budgets; older injected gateways may omit. */
  readonly jobTimeoutMs?: Readonly<{ advisor: number; evaluator: number }>;
  runAdvisor(
    input: Agent.AdvisorInput,
    control: AttemptControl,
  ): Promise<AgentCompletion>;
  runEvaluator(
    input: Agent.EvaluatorInput,
    control: AttemptControl,
  ): Promise<AgentCompletion>;
}
export interface GameServiceOptions {
  dbPath?: string;
  databaseUrl?: string;
  store?: Store;
  cloud?: {
    maxActiveSessions: number;
    maxSessionsPerPlayerPerDay: number;
    maxModelAttemptsPerDay: number;
    maxConcurrentModelJobs: number;
  };
  contentDir?: string;
  clock?: Clock;
  launchId?: string;
  tokenHash?: string;
  agents?: AgentGateway;
  recoverOnStartup?: boolean;
  resumeSessionIds?: string[];
  /** Internal tests only; never supplied by HTTP. */ selectCase?: () =>
    "A" | "B";
  autoTick?: boolean;
  /** Called once after an uncertain storage failure; the host should restart. */
  onStorageFailure?: () => void;
}
export class DomainError extends Error {
  constructor(
    public code: Public.ErrorCode,
    public status: number,
    message: string,
    public currentStateVersion: number | null = null,
    public retryable = false,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
export interface GameService {
  getSessionLocale?(id: string): Promise<"en-US" | "zh-CN" | null>;
  readonly launchId: string;
  readonly lastExecutionReplayed: boolean;
  execute(
    operationId: MutationOperation,
    body: unknown,
    meta: CommandMeta,
  ): Promise<unknown>;
  executeWithMeta(
    operationId: MutationOperation,
    body: unknown,
    meta: CommandMeta,
  ): Promise<{ result: unknown; replayed: boolean }>;
  read(
    operationId: ReadOperation,
    sessionId?: string,
    id?: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<unknown>;
  getEventsSince(
    sessionId: string,
    cursor?: string,
  ): Promise<Public.PublicSseEvent[]>;
  subscribe(
    sessionId: string,
    listener: (event: Public.PublicSseEvent) => void,
  ): Promise<() => void>;
  tick(sessionId?: string): Promise<void>;
  hasSessionAccess(
    sessionId: string,
    capability?: "read" | "command" | "evaluation" | "export",
  ): Promise<boolean>;
  hasPlayerSessionAccess(
    sessionId: string,
    playerId: string,
    capability?: "read" | "command" | "evaluation" | "export",
  ): Promise<boolean>;
  listPlayerSessions(playerId: string): Promise<PlayerSessionSummary[]>;
  startScheduler(): () => void;
  close(): Promise<void>;
}
export interface PlayerSessionSummary {
  sessionId: string;
  locale: "en-US" | "zh-CN";
  status: "created" | "active" | "sealed";
  createdAt: string;
  updatedAt: string;
}
export { createGameService } from "./implementation.js";
