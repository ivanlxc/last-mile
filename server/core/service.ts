import type * as Public from "../../docs/engineering_v0.5/contracts/public.types.js";
import type * as Agent from "../../docs/engineering_v0.5/contracts/agent-derived.types.js";
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
}
export interface Clock {
  nowMs(): number;
  monotonicMs(): number;
}
export interface AttemptControl {
  readonly locale?: "en-US" | "zh-CN";
  beginAttempt(): { attemptNo: number; requestKey: string };
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
  ): void;
  isCurrent(): boolean;
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
  getSessionLocale?(id: string): "en-US" | "zh-CN" | null;
  readonly launchId: string;
  readonly lastExecutionReplayed: boolean;
  execute(
    operationId: MutationOperation,
    body: unknown,
    meta: CommandMeta,
  ): unknown;
  read(
    operationId: ReadOperation,
    sessionId?: string,
    id?: string,
    query?: Record<string, string | number | undefined>,
  ): unknown;
  getEventsSince(sessionId: string, cursor?: string): Public.PublicSseEvent[];
  subscribe(
    sessionId: string,
    listener: (event: Public.PublicSseEvent) => void,
  ): () => void;
  tick(sessionId?: string): void;
  hasSessionAccess(
    sessionId: string,
    capability?: "read" | "command" | "evaluation" | "export",
  ): boolean;
  startScheduler(): () => void;
  close(): void;
}
export { createGameService } from "./implementation.js";
