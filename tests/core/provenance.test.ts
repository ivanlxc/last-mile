import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createGameService,
  type GameService,
} from "../../server/core/service.js";
import { ContractRegistry } from "../../server/http/contracts.js";
import type * as P from "../../docs/engineering_v0.5/contracts/public.types.js";

const registry = new ContractRegistry(process.cwd());
const services: GameService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

describe("paid provenance disclosure satisfies the complete public graph contract", () => {
  for (const caseId of ["A", "B"] as const) {
    it(`case ${caseId}: disclosed nodes and edges are stable UUIDs with valid references`, () => {
      let elapsed = 0;
      const service = createGameService({
        selectCase: () => caseId,
        clock: {
          nowMs: () => 1800000000000 + elapsed,
          monotonicMs: () => elapsed,
        },
      });
      services.push(service);
      const bootstrap = service.read("getBootstrap") as P.BootstrapView;
      const created = service.execute(
        "createSession",
        {
          profileId: "SINGLE_PLAYER_REFERENCE",
          runPurpose: "design_preview",
          locale: "zh-CN",
          contentVersionId: bootstrap.profiles[0]!.contentVersionId,
        },
        { idempotencyKey: randomUUID() },
      ) as P.SessionCreated;
      const get = () =>
        service.read("getSession", created.sessionId) as P.SessionProjection;
      const command = (
        operation: Parameters<GameService["execute"]>[0],
        payload: unknown,
      ) => {
        const current = get();
        return service.execute(
          operation,
          {
            expectedStateVersion: current.stateVersion,
            expectedSceneId: current.sceneId,
            payload,
          },
          {
            sessionId: created.sessionId,
            runEpoch: current.runEpoch,
            idempotencyKey: randomUUID(),
          },
        );
      };
      const advance = (milliseconds: number) => {
        elapsed += milliseconds;
        service.tick(created.sessionId);
      };
      const graph = () =>
        service.read("getProvenance", created.sessionId, undefined, {
          sceneId: "E2",
        }) as P.ProvenanceView;

      command("startSession", { acknowledgeDesignPreview: true });
      advance(30000);
      command("commitAction", {
        actionId: "E1_BYPASS",
        waitDurationMs: null,
        reason: "",
        reasonAnnotation: null,
        basedOnAdviceJobId: null,
        referencedReportIds: [],
        cancelPendingInvestigations: true,
      });
      advance(130000);
      for (const targetRole of ["analyst", "liaison"]) {
        command("createTask", {
          taskKind: "request_report",
          targetRole,
          topicId: "cause",
        });
      }
      advance(1000);
      const source = get().reports.find(
        (r) => r.card.definitionId === "market_broadcast",
      )!;
      expect(source).toBeDefined();
      expect(graph().edges).toEqual([]);
      command("createTask", {
        taskKind: "investigate_and_report",
        targetRole: "liaison",
        topicId: "cause",
        targetId: "market_broadcast.trace",
        investigationKind: "provenance_trace",
        sourceReportId: source.reportId,
        reasonAnnotation: null,
      });
      advance(15000);

      const first = graph();
      expect(registry.errors("ProvenanceView", first)).toEqual([]);
      expect(first.nodes.some((node) => node.kind === "verified_source")).toBe(
        true,
      );
      expect(first.edges.length).toBeGreaterThanOrEqual(2);
      const ids = new Set(first.nodes.map((node) => node.nodeId));
      for (const edge of first.edges) {
        expect(ids.has(edge.fromNodeId)).toBe(true);
        expect(ids.has(edge.toNodeId)).toBe(true);
        expect(edge.edgeId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
      const second = graph();
      expect(second.nodes).toEqual(first.nodes);
      expect(second.edges).toEqual(first.edges);
      expect(
        get().resources.find((r) => r.channel === "localAgency")?.spent,
      ).toBe(1);
      expect(JSON.stringify(first)).not.toMatch(
        /hiddenRootId|privateCaseId|market_rumor/,
      );
    });
  }
});
