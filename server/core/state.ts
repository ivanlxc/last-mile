import type * as P from "../../docs/engineering_v0.5/contracts/public.types.js";
import type { Flags, Plan, ResolvedStep } from "./world.js";
import type { FilteredDecisionSlice } from "../ai/facts.js";
export type Role = "analyst" | "liaison";
export type Channel = "satellite" | "drone" | "localAgency" | "witness";
export interface InventoryItem {
  card: P.EvidenceCard;
  owner: Role;
  topic: string;
  priority: number;
  definitionId: string;
  acquired: number;
  traceRelated: string[];
  traceRootLabel?: string;
}
export interface Task {
  view: P.TaskView;
  due: number;
  accepted: number;
  definitionId: string;
  reservationId: string;
  resourceChargeId: string | null;
  inventoryId: string | null;
  sourceReportId: string | null;
  trace: boolean;
}
export interface Operation {
  view: P.OperationView;
  plan: Plan;
  steps: ResolvedStep[];
  index: number;
  entry: boolean;
  decisionId: string | null;
}
export interface State {
  sessionId: string;
  runEpoch: string;
  caseId: "A" | "B";
  runPurpose: "approved_play" | "design_preview";
  locale: "zh-CN" | "en-US";
  version: number;
  lifecycle: "briefing" | "running" | "completed" | "abandoned" | "interrupted";
  phase:
    | "briefing"
    | "decision"
    | "coordinating"
    | "travelling"
    | "resolving"
    | "terminal";
  sceneId: P.SceneId | null;
  mission: number;
  createdAt: number;
  startWall: number | null;
  flags: Flags;
  location: P.KnownLocation;
  actors: Record<"commander" | Role, string>;
  accounts: Record<string, string>;
  inventory: InventoryItem[];
  tasks: Task[];
  operations: Operation[];
  reports: P.ReportView[];
  uploads: P.UploadSnapshot[];
  statements: P.PlayerStatementView[];
  decisionMeta: Record<
    string,
    Pick<
      FilteredDecisionSlice,
      | "kind"
      | "contextDisplayedAtMs"
      | "availableChecks"
      | "check"
      | "referencedEvidenceRefs"
    > & { eligibleAdviceJobId: string | null }
  >;
  decisions: P.DecisionReplay[];
  publicLog: P.PublicLogEntry[];
  viewedReportIds: string[];
  displayedAdviceIds: string[];
  contextDisplayed: boolean;
  inboxVersion: number;
  contextVersion: number;
  contextEpoch: string;
  routeIdsTaken: string[];
  medical: P.MedicalView;
  outcome: P.OutcomeView | null;
  arrivalMs: number | null;
}
