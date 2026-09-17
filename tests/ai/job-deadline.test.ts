import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createAiService,
  MockProvider,
  type ProviderRequest,
} from "../../server/ai/index.js";
import {
  createGameService,
  type AgentGateway,
  type Clock,
  type GameService,
  type MutationOperation,
} from "../../server/core/service.js";
import type * as P from "../../docs/engineering_v0.5/contracts/public.types.js";

class FakeClock implements Clock {
  time = 0;
  nowMs() {
    return 1800000000000 + this.time;
  }
  monotonicMs() {
    return this.time;
  }
}
const services: GameService[] = [];
const databases: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup(agents: AgentGateway) {
  const dir = mkdtempSync(join(tmpdir(), "last-mile-job-deadline-"));
  dirs.push(dir);
  const dbPath = join(dir, "test.sqlite");
  const clock = new FakeClock();
  const service = createGameService({
    clock,
    dbPath,
    agents,
    selectCase: () => "A",
  });
  services.push(service);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  databases.push(db);
  const bootstrap = service.read("getBootstrap") as P.BootstrapView;
  const session = service.execute(
    "createSession",
    {
      profileId: "SINGLE_PLAYER_REFERENCE",
      runPurpose: "design_preview",
      locale: "en-US",
      contentVersionId: bootstrap.profiles[0]!.contentVersionId,
    },
    { idempotencyKey: randomUUID() },
  ) as P.SessionCreated;
  const sid = session.sessionId;
  const get = () => service.read("getSession", sid) as P.SessionProjection;
  const command = (op: MutationOperation, payload: unknown) => {
    const state = get();
    return service.execute(
      op,
      {
        expectedStateVersion: state.stateVersion,
        expectedSceneId: state.sceneId,
        payload,
      },
      {
        sessionId: sid,
        runEpoch: state.runEpoch,
        idempotencyKey: randomUUID(),
      },
    );
  };
  const jobRow = (jobId: string) =>
    db
      .prepare(
        "SELECT deadline_at_ms,created_at_ms,updated_at_ms,config_hash FROM agent_jobs WHERE session_id=? AND job_id=?",
      )
      .get(sid, jobId) as {
      deadline_at_ms: number;
      created_at_ms: number;
      updated_at_ms: number;
      config_hash: string;
    };
  command("startSession", { acknowledgeDesignPreview: true });
  clock.time += 30000;
  service.tick(sid);
  return { service, sid, get, command, clock, jobRow };
}

describe("persisted Agent job deadlines", () => {
  for (const mode of ["configured", "defaults", "legacy_gateway"] as const)
    it(`${mode}: public job IDs resolve to the correct creation and explicit retry deadlines`, async () => {
      const requests: ProviderRequest[] = [];
      const service = createAiService({
        env:
          mode === "configured"
            ? {
                AI_ADVISOR_TIMEOUT_MS: "20000",
                AI_EVALUATOR_TIMEOUT_MS: "30000",
              }
            : {},
        provider: new MockProvider((request) => {
          requests.push(request);
          // A transport failure is one sent attempt and can be retried explicitly.
          return {
            ok: false,
            code: "MODEL_TRANSPORT",
            reason: "transport",
            retryable: true,
            repairable: false,
            usage: null,
            providerRequestId: null,
          };
        }),
      });
      const { jobTimeoutMs, ...legacy } = service;
      const agents: AgentGateway = mode === "legacy_gateway" ? legacy : service;
      const expected =
        mode === "legacy_gateway"
          ? { advisor: 20000, evaluator: 25000 }
          : mode === "configured"
            ? { advisor: 42000, evaluator: 62000 }
            : { advisor: 18000, evaluator: 42000 };
      if (mode !== "legacy_gateway") expect(jobTimeoutMs).toEqual(expected);
      const x = setup(agents);
      // Entering E1 automatically requests initial advice. The assertions below
      // track the explicit question and the sealed evaluation only.
      await settle();
      requests.length = 0;
      const advice = x.command("askAdvisor", {
        questionKind: "uncertainties",
        text: null,
        expectedInboxVersion: x.get().inboxVersion,
        uploadBatch: [],
      }) as P.QuestionAccepted;
      expect(x.jobRow(advice.job.jobId)).toMatchObject({
        created_at_ms: x.clock.nowMs(),
        deadline_at_ms: x.clock.nowMs() + expected.advisor,
        config_hash: agents.configHash,
      });
      await settle();
      expect(
        x.service.read("getAdvice", x.sid, advice.job.jobId),
      ).toMatchObject({
        jobId: advice.job.jobId,
        attemptCount: 1,
        status: "fallback",
      });
      const outcome = x.command("abandonSession", {
        reason: "player_exit",
      }) as P.OutcomeView;
      const requestEvaluation = () =>
        x.service.execute(
          "requestEvaluation",
          {
            sealedHash: outcome.sealedHash,
            evaluationConfigId: "EVALUATION_REFERENCE_V1",
          },
          {
            sessionId: x.sid,
            runEpoch: outcome.runEpoch,
            idempotencyKey: randomUUID(),
          },
        ) as P.EvaluationAccepted;
      const first = requestEvaluation();
      const createdAt = x.clock.nowMs();
      expect(x.jobRow(first.job.jobId)).toMatchObject({
        created_at_ms: createdAt,
        deadline_at_ms: createdAt + expected.evaluator,
        config_hash: agents.configHash,
      });
      await settle();
      expect(
        x.service.read("getEvaluation", x.sid, first.job.jobId),
      ).toMatchObject({
        status: "fallback",
        attemptCount: 1,
      });
      x.clock.time += 4000;
      const retried = requestEvaluation();
      expect(retried.job.jobId).toBe(first.job.jobId);
      const retryDeadline = x.clock.nowMs() + expected.evaluator;
      expect(x.jobRow(first.job.jobId)).toMatchObject({
        created_at_ms: createdAt,
        updated_at_ms: x.clock.nowMs(),
        deadline_at_ms: retryDeadline,
      });
      await settle();
      expect(
        x.service.read("getEvaluation", x.sid, first.job.jobId),
      ).toMatchObject({
        status: "fallback",
        attemptCount: 2,
      });
      // Exhausting the lifetime budget does not queue or extend the job again.
      x.clock.time += 4000;
      expect(requestEvaluation().job.jobId).toBe(first.job.jobId);
      expect(x.jobRow(first.job.jobId).deadline_at_ms).toBe(retryDeadline);
      await settle();
      expect(requests).toHaveLength(3);
      expect(requests.map((r) => r.timeoutMs)).toEqual(
        mode === "configured" ? [20000, 30000, 30000] : [8000, 20000, 20000],
      );
      expect(JSON.stringify(requests.map((r) => r.input))).not.toMatch(
        /jobTimeoutMs|deadline_at_ms/,
      );
      expect(first.job).not.toHaveProperty("jobTimeoutMs");
      expect(first.job).not.toHaveProperty("deadline_at_ms");
    });
});
