import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type * as P from "../../docs/engineering_v0.5/contracts/public.types.js";
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export const hash = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonical(value))
    .digest("hex");
export interface Flags {
  manifestPending: boolean;
  inspectionPending: boolean;
  bridgeRefused: boolean;
}
export interface EvidenceDefinition {
  definitionId: string;
  sceneId: P.SceneId;
  sourceRole: "analyst" | "liaison";
  channel: P.EvidenceCard["channel"];
  acquisition: "preloaded" | "investigation";
  topicId: string;
  priority: number;
  title: string;
  body: string;
  statementKind: P.EvidenceCard["statementKind"];
  sourceLabel: string;
  observationScope: string;
  observationAgeMs: number | null;
  provenanceStatus: P.EvidenceCard["provenanceStatus"];
  hiddenRootId: string;
  traceCostChannel: "localAgency" | "witness" | null;
  traceResult: {
    title: string;
    body: string;
    status: P.EvidenceCard["provenanceStatus"];
    rootLabel: string;
    relatedDefinitionIds: string[];
  } | null;
}
export interface Step {
  kind: "hold" | "route" | "conditionalHold";
  nodeId?: string;
  routeId?: string;
  fromFraction?: number;
  toFraction?: number;
  durationMs?: number;
  flag?: keyof Flags;
  clearFlag?: keyof Flags;
}
export interface Plan {
  actionId: string;
  label: string;
  steps: Step[];
  nextSceneId: P.SceneId | null;
  endNodeId: string;
  effects: { flag: keyof Flags; value: boolean }[];
}
export interface ResolvedStep extends Step {
  durationMs: number;
  startMs: number;
  endMs: number;
}
export interface Route {
  routeId: string;
  fromNode: string;
  toNode: string;
  durationMs: number;
  bidirectional: boolean;
  enabled: boolean;
  waypoints: number[][];
}
export interface CaseDefinition {
  privateCaseId: "A" | "B";
  evidenceDefinitions: EvidenceDefinition[];
  actionPlans: Plan[];
  endingText: string;
}
export class World {
  readonly campaign: any;
  readonly policy: any;
  readonly map: any;
  readonly publicActions: any[];
  readonly contentHash: string;
  readonly policyHash: string;
  constructor(dir: string) {
    const read = (name: string) =>
      JSON.parse(readFileSync(resolve(dir, name), "utf8"));
    this.campaign = read("campaign-reference.json");
    this.policy = read("reference-policy.json");
    this.map = read("public-map.json");
    this.publicActions = read("public-actions.json").actions;
    this.contentHash = hash({
      campaign: this.campaign,
      map: this.map,
      actions: this.publicActions,
    });
    this.policyHash = hash(this.policy);
    if (this.campaign.cases.length !== 2 || this.campaign.scenes.length !== 3)
      throw Error("Invalid authored campaign");
  }
  case(id: string): CaseDefinition {
    const c = this.campaign.cases.find(
      (c: CaseDefinition) => c.privateCaseId === id,
    );
    if (!c) throw Error("Unknown private case");
    return c;
  }
  route(id: string): Route {
    const r = this.map.routes.find((r: Route) => r.routeId === id);
    if (!r) throw Error("Unknown authored route");
    return r;
  }
  resolve(plan: Plan, flags: Flags, start: number): ResolvedStep[] {
    let t = start;
    return plan.steps.flatMap((step) => {
      if (step.kind === "conditionalHold" && !flags[step.flag!]) return [];
      const duration =
        step.kind === "route"
          ? Math.round(
              this.route(step.routeId!).durationMs *
                Math.abs(step.toFraction! - step.fromFraction!),
            )
          : step.durationMs!;
      if (!(duration > 0)) throw Error("Invalid authored duration");
      const r = {
        ...step,
        kind: step.kind === "conditionalHold" ? "hold" : step.kind,
        durationMs: duration,
        startMs: t,
        endMs: t + duration,
        ...(step.kind === "conditionalHold" ? { clearFlag: step.flag } : {}),
      } as ResolvedStep;
      t += duration;
      return [r];
    });
  }
  location(step: ResolvedStep, at: number): P.KnownLocation {
    if (step.kind !== "route")
      return { nodeId: step.nodeId!, routeId: null, progressPermille: 0 };
    const r = this.route(step.routeId!);
    const progress = Math.min(
      1,
      Math.max(0, (at - step.startMs) / step.durationMs),
    );
    const f =
      step.fromFraction! + (step.toFraction! - step.fromFraction!) * progress;
    return {
      nodeId: f === 0 ? r.fromNode : f === 1 ? r.toNode : null,
      routeId: f === 0 || f === 1 ? null : r.routeId,
      progressPermille: f === 0 || f === 1 ? 0 : Math.round(f * 1000),
    };
  }
  scene(id: P.SceneId) {
    return this.campaign.scenes.find((s: any) => s.sceneId === id);
  }
  kind(channel: string): P.TaskOption["investigationKind"] {
    return (
      {
        satellite: "satellite_scan",
        drone: "drone_observe",
        localAgency: "agency_contact",
        witness: "witness_interview",
      } as const
    )[channel as "drone"];
  }
}
