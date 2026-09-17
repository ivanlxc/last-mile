/** Shared implementation boundaries, not implementations. Server-only ports must
 * never be imported into Commander UI. Wire data is validated by JSON Schema. */
import type * as Public from "./public.types";
import type * as Internal from "./internal.types";
import type * as Agent from "./agent-derived.types";
import type { PrivatePolicy, PrivateCampaign } from "./content-derived.types";
import type { ModelAdapter } from "../agents/modelAdapter";
export type { StructuredRequest, StructuredResult, ModelConfig, ModelUsage } from "../agents/modelAdapter";

export type UUID = Public.Uuid;
export type Sha256 = Public.Sha256;
export type SceneId = Public.SceneId;
export type Result<T> = { ok: true; value: T } | { ok: false; problem: Public.Problem };
export type InvestigatorRole = "analyst" | "liaison";
export type InvestigationChannel = "satellite" | "drone" | "localAgency" | "witness";
export type CommandKind = keyof CommandRequestMap;
export interface CommandRequestMap {
  createSession: Public.CreateSessionRequest;
  startSession: Public.StartRequest;
  createTask: Public.TaskRequest;
  uploadReports: Public.UploadRequest;
  askAdvisor: Public.QuestionRequest;
  commitAction: Public.ActionRequest;
  recordDisplay: Public.DisplayReceiptRequest;
  abandonSession: Public.AbandonRequest;
  requestEvaluation: Public.EvaluationRequest;
  createExport: Public.ExportRequest;
}
export interface CommandResponseMap {
  createSession: Public.SessionCreated;
  startSession: Public.SessionProjection;
  createTask: Public.TaskAccepted;
  uploadReports: Public.UploadView;
  askAdvisor: Public.QuestionAccepted;
  commitAction: Public.ActionAccepted;
  recordDisplay: Public.ReceiptView;
  abandonSession: Public.OutcomeView;
  requestEvaluation: Public.EvaluationAccepted;
  createExport: Public.ExportAccepted;
}
export interface AuthenticatedContext {
  readonly launchId: UUID;
  readonly actorBindingId: UUID;
  readonly role: "commander";
  readonly capabilities: ReadonlyArray<"commander.read" | "session.create" | "session.command" | "evaluation.request" | "export.request">;
  readonly permittedSessionId: UUID | null;
  readonly originVerified: true;
}
export interface CommandMeta {
  readonly requestId: UUID;
  readonly idempotencyKey: UUID;
  readonly sessionId: UUID | null;
  readonly runEpoch: UUID | null;
  readonly method: "POST";
  readonly path: string;
  readonly canonicalRequestHash: Sha256;
}
export interface HttpReceipt<T> {
  readonly httpStatus: 200 | 201 | 202;
  readonly requestId: UUID;
  readonly replayed: boolean;
  readonly location: string | null;
  readonly body: T;
}
export interface SessionCoordinatorPort {
  execute<K extends CommandKind>(auth: AuthenticatedContext, meta: CommandMeta, kind: K,
    input: CommandRequestMap[K]): Promise<Result<HttpReceipt<CommandResponseMap[K]>>>;
  /** Session serial lock; due events commit even if the next command is rejected. */
  catchUp(sessionId: UUID, sampledMonotonicMs: number): Promise<Result<Public.SessionProjection>>;
}
export interface ClockPort {
  monotonicMs(): number;
  wallNow(): Date;
}
export interface SessionLockPort {
  withSession<T>(sessionId: UUID, work: () => Promise<T>): Promise<T>;
}

export type PrivateCase = PrivateCampaign["cases"][number];
export type EvidenceDefinition = PrivateCase["evidenceDefinitions"][number];
export type ActionPlan = PrivateCase["actionPlans"][number];
export interface ContentRegistryPort {
  loadVersion(contentVersionId: UUID): Promise<{ campaign: PrivateCampaign; contentHash: Sha256 }>;
  loadPolicy(profileId: "SINGLE_PLAYER_REFERENCE"): Promise<{ policy: PrivatePolicy; policyHash: Sha256 }>;
  selectCase(campaign: PrivateCampaign, seed: Sha256): PrivateCase;
}
export interface WorldSnapshot {
  readonly sessionId: UUID;
  readonly runEpoch: UUID;
  readonly missionTimeMs: number;
  readonly stateVersion: number;
  readonly lastInternalSeq: number;
  readonly privateCaseId: string;
  readonly contentVersionId: UUID;
  readonly policyHash: Sha256;
  readonly flags: PrivateCampaign["initialFlags"];
  readonly publicProjection: Public.SessionProjection;
}
export interface WorldTransition {
  readonly stateAfter: WorldSnapshot;
  readonly events: ReadonlyArray<Internal.InternalEvent>;
  readonly operation: Public.OperationView | null;
  readonly releasedEvidence: ReadonlyArray<OwnedEvidence>;
  readonly outcome: Public.OutcomeView | null;
}
export interface WorldEnginePort {
  /** Pure calculation. Does not persist, send HTTP, call models or read UI state. */
  advance(snapshot: WorldSnapshot, privateCase: PrivateCase, policy: PrivatePolicy,
    targetMissionTimeMs: number): Result<WorldTransition>;
  commitAction(snapshot: WorldSnapshot, plan: ActionPlan, input: Public.ActionRequest,
    decisionId: UUID, operationId: UUID): Result<WorldTransition>;
}
export interface SchedulerPort {
  schedule(sessionId: UUID, runEpoch: UUID, dueAtMissionMs: number,
    kind: "investigation_due" | "operation_due" | "mission_deadline" | "medical_target" | "advisor_debounce",
    ownerId: UUID): Promise<void>;
  cancelSession(sessionId: UUID, runEpoch: UUID): Promise<void>;
  /** Restores jobs from durable rows; never re-spends already accepted resources. */
  recoverSession(sessionId: UUID): Promise<void>;
}
export interface OwnedEvidence {
  readonly ownerRole: InvestigatorRole;
  readonly card: Public.EvidenceCard;
  readonly payloadHash: Sha256;
  readonly acquiredAtMissionMs: number;
  readonly publicTopicIds: ReadonlyArray<string>;
  readonly publicPriority: number;
}
export interface CandidateMetadata {
  readonly evidenceInstanceId: UUID;
  readonly definitionId: string;
  readonly publicTopicIds: ReadonlyArray<string>;
  readonly publicPriority: number;
  readonly acquiredAtMissionMs: number;
}
export interface NpcRoleControllerPort {
  /** No caseId, truth utility or private future consequence is accepted. */
  chooseAcquiredReport(topicId: string, candidates: ReadonlyArray<CandidateMetadata>): UUID | null;
  validateTask(option: Public.TaskOption, request: Public.TaskRequest): Result<InvestigationChannel | null>;
}
export interface InvestigationBrokerPort {
  prepare(snapshot: WorldSnapshot, option: Public.TaskOption, taskId: UUID,
    request: Public.TaskRequest, reservationLedgerId: UUID, spendLedgerId: UUID): Result<Internal.InvestigationRecord>;
  complete(record: Internal.InvestigationRecord, definition: EvidenceDefinition,
    completedAtMissionMs: number): Result<OwnedEvidence>;
}
export interface ReportingServicePort {
  create(task: Public.TaskView, evidence: OwnedEvidence, reportId: UUID,
    reportedAtMissionMs: number): Result<Public.ReportView>;
}
export interface UploadServicePort {
  /** All items validated before any write; existing identical versions are no-ops. */
  prepare(snapshot: WorldSnapshot, request: Public.UploadRequest,
    commanderReports: ReadonlyArray<Public.ReportView>): Result<Public.UploadView>;
}
export interface ProjectionServicePort {
  commander(sessionId: UUID): Promise<Result<Public.SessionProjection>>;
  provenance(sessionId: UUID, sceneId: SceneId): Promise<Result<Public.ProvenanceView>>;
  outcome(sessionId: UUID): Promise<Result<Public.OutcomeView>>;
  replay(sessionId: UUID, cursor: UUID | null): Promise<Result<Public.ReplayView>>;
  /** Constructs a new whitelist object; never casts InternalEvent to SSE. */
  publishable(event: Internal.InternalEvent, visibleState: Public.SessionProjection): ReadonlyArray<Public.PublicSseEvent>;
  /** Only public review-job views are published; audit payloads remain private. */
  postgamePublishable(event: Internal.PostgameAuditEvent, sealedState: Public.SessionProjection,
    evaluationJob: Public.EvaluationJobView | null, exportView: Public.ExportView | null
  ): ReadonlyArray<Public.SseEvaluationUpdated | Public.SseExportUpdated>;
}
export interface PublicEventStreamPort {
  subscribe(auth: AuthenticatedContext, sessionId: UUID, after: string | null,
    signal: AbortSignal): AsyncIterable<Public.PublicSseEvent>;
}

export type AgentJobCreation =
  { agentRole: "advisor"; input: Agent.AdvisorInput; publicJob: Public.AdvisorJobView; manifestId: UUID }
  | { agentRole: "evaluator"; input: Agent.EvaluatorInput; publicJob: Public.EvaluationJobView; sealedHash: Sha256 };
export interface AgentOrchestratorPort {
  /** Receives only already committed work; model calls never run inside DB TX. */
  dispatch(job: AgentJobCreation): Promise<void>;
  cancel(jobId: UUID, reason: "context_superseded" | "session_terminal"): Promise<void>;
}
export interface AdvisorContextBuilderPort {
  build(sessionId: UUID, sceneId: SceneId, committedInboxVersion: number,
    statementId: UUID | null): Promise<Result<Agent.AdvisorInput>>;
}
export interface FactBuilderPort {
  build(sealedHash: Sha256, evaluationConfigId: "EVALUATION_REFERENCE_V1"): Promise<Result<Agent.EvaluatorInput>>;
}
/** Canonical adapter preserves requestKey, schema/config-selected parameters,
 * providerRequestId and attempt usage. Orchestrators validate its raw output. */
export type ModelAdapterPort = ModelAdapter;
export interface ExportServicePort {
  build(outcome: Public.OutcomeView, replay: ReadonlyArray<Public.ReplayView>,
    evaluationJob: Public.EvaluationJobView | null, includePlayerStatements: boolean): Result<Public.ExportArtifact>;
}

/** Gameplay transaction only. SQLite maps camelCase records to snake_case columns.
 * Terminal seals prohibit further writes through this path. */
export interface AtomicWriteSet {
  readonly stateAfter: WorldSnapshot;
  readonly command: Internal.CommandRecord;
  readonly events: ReadonlyArray<Internal.InternalEvent>;
  readonly publicEvents: ReadonlyArray<Public.PublicSseEvent>;
  readonly quotaEntries: ReadonlyArray<Internal.QuotaEntry>;
  readonly acquiredEvidence: ReadonlyArray<OwnedEvidence>;
  readonly tasks: ReadonlyArray<Public.TaskView>;
  readonly investigations: ReadonlyArray<Internal.InvestigationRecord>;
  readonly reports: ReadonlyArray<Public.ReportView>;
  readonly uploads: ReadonlyArray<Public.UploadSnapshot>;
  readonly agentJobs: ReadonlyArray<Extract<AgentJobCreation, { agentRole: "advisor" }>>;
  readonly operations: ReadonlyArray<Public.OperationView>;
  readonly decisionSnapshots: ReadonlyArray<Public.DecisionReplay>;
  readonly outcome: Public.OutcomeView | null;
}
/** Backend transaction token, never accepted from HTTP. No gameplay sequence is allocated. */
export interface PostgameTransaction {
  readonly transactionId: UUID;
  readonly sessionId: UUID;
  readonly sealedHash: Sha256;
}
export interface AuditStorePort {
  /** Validates an existing immutable seal. Matching evaluator/fact/export table
   * mutations and append() share this short transaction; model calls run outside it. */
  withTransaction<T>(sessionId: UUID, sealedHash: Sha256,
    work: (tx: PostgameTransaction) => Promise<T>): Promise<Result<T>>;
  /** Maps auditId to diagnostic_id, createdAt to recorded_at_ms and the full
   * closed event to payload_json, category=postgame_audit. Session/seal must match
   * tx; auditId is idempotent. Never touches events, last_event_seq or stateVersion. */
  append(tx: PostgameTransaction, event: Internal.PostgameAuditEvent): Promise<Result<void>>;
}
export interface SqliteStorePort {
  readWorld(sessionId: UUID): Promise<Result<WorldSnapshot>>;
  findReceipt(meta: CommandMeta): Promise<Result<HttpReceipt<Internal.CommandSuccess> | null>>;
  /** DB unique(session scope, key); hash includes method/path/runEpoch/body. */
  commit(writeSet: AtomicWriteSet, expectedStateVersion: number): Promise<Result<void>>;
  /** Due-system-event TX has no user command and survives later user rejection. */
  commitCatchUp(transition: WorldTransition, expectedStateVersion: number): Promise<Result<void>>;
  loadOwnedEvidence(sessionId: UUID, role: InvestigatorRole): Promise<ReadonlyArray<OwnedEvidence>>;
}
