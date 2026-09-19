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
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});

describe("paid provenance disclosure satisfies the complete public graph contract", () => {
  for (const caseId of ["A", "B"] as const) {
    it(`case ${caseId}: disclosed nodes and edges are stable UUIDs with valid references`, async () => {
      const service = await createGameService({
        selectCase: () => caseId,
        clock: {
          nowMs: () => 1800000000000,
          monotonicMs: () => 0,
        },
      });
      services.push(service);
      const bootstrap = (await service.read("getBootstrap")) as P.BootstrapView;
      const created = (await service.execute(
        "createSession",
        {
          profileId: "SINGLE_PLAYER_REFERENCE",
          runPurpose: "design_preview",
          locale: "zh-CN",
          contentVersionId: bootstrap.profiles[0]!.contentVersionId,
        },
        { idempotencyKey: randomUUID() },
      )) as P.SessionCreated;
      const get = async () => {
        // Evidence resolves immediately, while offline AI publication remains
        // asynchronous and can update the version before the next command.
        for (let i = 0; i < 100; i++) {
          const current = (await service.read(
            "getSession",
            created.sessionId,
          )) as P.SessionProjection;
          if (
            !current.latestAdviceJob ||
            !["queued", "running"].includes(current.latestAdviceJob.status)
          )
            return current;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        throw new Error("Offline advice did not settle");
      };
      const command = async (
        operation: Parameters<GameService["execute"]>[0],
        payload: unknown,
      ) => {
        const current = await get();
        return await service.execute(
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
      const graph = async () =>
        (await service.read("getProvenance", created.sessionId, undefined, {
          sceneId: "E2",
        })) as P.ProvenanceView;

      await command("startSession", { acknowledgeDesignPreview: true });
      await command("commitAction", {
        actionId: "E1_BYPASS",
        waitDurationMs: null,
        reason: "",
        reasonAnnotation: null,
        basedOnAdviceJobId: null,
        referencedReportIds: [],
        cancelPendingInvestigations: true,
      });
      for (const targetRole of ["analyst", "liaison"]) {
        await command("createTask", {
          taskKind: "request_report",
          targetRole,
          topicId: "cause",
        });
      }
      const source = (await get()).reports.find(
        (r) => r.card.definitionId === "market_broadcast",
      )!;
      expect(source).toBeDefined();
      expect((await graph()).edges).toEqual([]);
      await command("createTask", {
        taskKind: "investigate_and_report",
        targetRole: "liaison",
        topicId: "cause",
        targetId: "market_broadcast.trace",
        investigationKind: "provenance_trace",
        sourceReportId: source.reportId,
        reasonAnnotation: null,
      });

      const first = await graph();
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
      const second = await graph();
      expect(second.nodes).toEqual(first.nodes);
      expect(second.edges).toEqual(first.edges);
      expect(
        (await get()).resources.find((r) => r.channel === "localAgency")?.spent,
      ).toBe(1);
      expect(JSON.stringify(first)).not.toMatch(
        /hiddenRootId|privateCaseId|market_rumor/,
      );
    });
  }
});
