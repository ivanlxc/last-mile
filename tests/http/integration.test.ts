import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  createGameService,
  type GameService,
} from "../../server/core/service.js";
import { createAiService } from "../../server/ai/index.js";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";
import { ContractRegistry } from "../../server/http/contracts.js";
import type * as Public from "../../docs/engineering_v0.5/contracts/public.types.js";

const registry = new ContractRegistry(process.cwd());
const config = {
  ...loadHttpConfig({ LAST_MILE_ROOT: process.cwd() }),
  clientDir: "/__no_client__",
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture() {
  let elapsed = 0;
  const service = createGameService({
    dbPath: ":memory:",
    autoTick: false,
    recoverOnStartup: false,
    clock: {
      nowMs: () => Date.UTC(2026, 8, 16) + elapsed,
      monotonicMs: () => elapsed,
    },
    agents: createAiService({ env: {} }),
    selectCase: () => "A",
  });
  const app = await createHttpApp({
    service,
    config,
    launchToken: "test-local-launch",
    closeServiceOnClose: true,
  });
  apps.push(app);
  const boot = await app.inject({
    url: "/api/v1/bootstrap",
    headers: { host: "127.0.0.1:3111" },
  });
  expect(boot.statusCode, boot.body).toBe(200);
  const headers = {
    host: "127.0.0.1:3111",
    cookie: String(boot.headers["set-cookie"]).split(";")[0]!,
  };
  const profile = (boot.json() as Public.BootstrapView).profiles[0]!;
  async function get(url: string, schema: string) {
    const result = await app.inject({ url, headers });
    const diagnostics =
      result.statusCode === 503 && schema === "SessionProjection"
        ? registry.errors(schema, service.read("getSession", url.split("/")[4]))
        : [];
    expect(result.statusCode, result.body + JSON.stringify(diagnostics)).toBe(
      200,
    );
    expect(registry.errors(schema, result.json()), result.body).toEqual([]);
    return result.json();
  }
  async function post(
    url: string,
    body: unknown,
    schema: string,
    status = 200,
    runEpoch?: string,
    key: string = randomUUID(),
  ) {
    const result = await app.inject({
      method: "POST",
      url,
      payload: JSON.stringify(body),
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": key,
        ...(runEpoch ? { "x-run-epoch": runEpoch } : {}),
      },
    });
    expect(result.statusCode, result.body).toBe(status);
    expect(registry.errors(schema, result.json()), result.body).toEqual([]);
    return result;
  }
  const createBody = {
    profileId: profile.profileId,
    runPurpose: "design_preview",
    locale: "zh-CN",
    contentVersionId: profile.contentVersionId,
  };
  const key = randomUUID();
  const createdResponse = await post(
    "/api/v1/sessions",
    createBody,
    "SessionCreated",
    201,
    undefined,
    key,
  );
  const created = createdResponse.json() as Public.SessionCreated;
  const replay = await post(
    "/api/v1/sessions",
    createBody,
    "SessionCreated",
    201,
    undefined,
    key,
  );
  expect(replay.headers["idempotency-replayed"]).toBe("true");
  expect(replay.json()).toEqual(created);
  const base = `/api/v1/sessions/${created.sessionId}`;
  const projection = () =>
    get(base, "SessionProjection") as Promise<Public.SessionProjection>;
  const command = async (
    suffix: string,
    payload: unknown,
    schema: string,
    status = 200,
    key?: string,
  ) => {
    const current = await projection();
    return post(
      base + suffix,
      {
        expectedStateVersion: current.stateVersion,
        expectedSceneId: current.sceneId,
        payload,
      },
      schema,
      status,
      created.runEpoch,
      key,
    );
  };
  const advance = async (milliseconds: number) => {
    elapsed += milliseconds;
    service.tick(created.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  await command(
    "/start",
    { acknowledgeDesignPreview: true },
    "SessionProjection",
  );
  await advance(30000);
  expect((await projection()).sceneId).toBe("E1");
  return {
    app,
    service,
    headers,
    base,
    created,
    projection,
    command,
    post,
    get,
    advance,
  };
}

describe("real SQLite domain through public HTTP", () => {
  it("completes reporting, immutable upload, advice, WAIT, sealing, evaluation, replay and export", async () => {
    const f = await fixture();
    const current = await f.projection();
    const option = current.taskOptions.find(
      (o) => o.available && o.investigationKind === "satellite_scan",
    )!;
    expect(option).toBeDefined();
    const taskResponse = await f.command(
      "/tasks",
      {
        taskKind: "investigate_and_report",
        targetRole: option.targetRole,
        topicId: option.topicId,
        targetId: option.targetId,
        investigationKind: option.investigationKind,
        sourceReportId: null,
        reasonAnnotation: null,
      },
      "TaskAccepted",
      202,
    );
    const accepted = taskResponse.json() as Public.TaskAccepted;
    await f.advance(11000);
    const task = (await f.get(
      `${f.base}/tasks/${accepted.task.taskId}`,
      "TaskView",
    )) as Public.TaskView;
    expect(task.status).toBe("completed");
    expect(task.reportId).not.toBeNull();
    const report = (await f.get(
      `${f.base}/reports/${task.reportId}`,
      "ReportView",
    )) as Public.ReportView;
    const beforeReceipt = await f.projection();
    await f.post(
      `${f.base}/display-receipts`,
      {
        observedStateVersion: beforeReceipt.stateVersion,
        observedSceneId: beforeReceipt.sceneId,
        payload: {
          displayKind: "report_opened",
          reportId: report.reportId,
          jobId: null,
          operationId: null,
        },
      },
      "ReceiptView",
      200,
      f.created.runEpoch,
    );
    expect((await f.projection()).stateVersion).toBe(
      beforeReceipt.stateVersion,
    );
    await f.command(
      "/uploads",
      {
        items: [
          { reportId: report.reportId, expectedRevision: report.revision },
        ],
      },
      "UploadView",
    );
    const withUpload = await f.projection();
    expect(withUpload.sceneUploads).toHaveLength(1);
    const question = await f.command(
      "/questions",
      {
        questionKind: "explain_basis",
        text: null,
        expectedInboxVersion: withUpload.inboxVersion,
        uploadBatch: [],
      },
      "QuestionAccepted",
      202,
    );
    const jobId = question.json().job.jobId;
    await f.advance(1);
    const advice = await f.get(`${f.base}/advice/${jobId}`, "AdvisorJobView");
    expect(advice.status).toBe("fallback");
    expect(advice.mode).toBe("offline_template");
    expect(advice.result).not.toBeNull();
    const wait = await f.command(
      "/actions",
      {
        actionId: "WAIT",
        waitDurationMs: 15000,
        reason: "等待报告并比较已知限制",
        reasonAnnotation: null,
        basedOnAdviceJobId: null,
        referencedReportIds: [report.reportId],
        cancelPendingInvestigations: false,
      },
      "ActionAccepted",
      202,
    );
    const operationId = wait.json().operation.operationId;
    await f.advance(15000);
    expect(
      (await f.get(`${f.base}/operations/${operationId}`, "OperationView"))
        .status,
    ).toBe("completed");
    expect((await f.projection()).sceneId).toBe("E1");
    await f.get(`${f.base}/provenance?sceneId=E1`, "ProvenanceView");
    const abandon = await f.command(
      "/abandon",
      { reason: "player_exit" },
      "OutcomeView",
    );
    const outcome = abandon.json() as Public.OutcomeView;
    expect(outcome.terminationReason).toBe("abandoned");
    expect(await f.get(`${f.base}/outcome`, "OutcomeView")).toEqual(outcome);
    const evaluation = await f.post(
      `${f.base}/evaluations`,
      {
        sealedHash: outcome.sealedHash,
        evaluationConfigId: "EVALUATION_REFERENCE_V1",
      },
      "EvaluationAccepted",
      202,
      f.created.runEpoch,
    );
    await f.advance(1);
    const evaluated = await f.get(
      `${f.base}/evaluations/${evaluation.json().job.jobId}`,
      "EvaluationJobView",
    );
    expect(evaluated.status).toBe("fallback");
    expect(evaluated.result).not.toBeNull();
    const replay = await f.get(`${f.base}/replay`, "ReplayView");
    expect(replay.sealedHash).toBe(outcome.sealedHash);
    const exported = await f.post(
      `${f.base}/exports`,
      {
        sealedHash: outcome.sealedHash,
        format: "last-mile-review-json",
        includePlayerStatements: true,
      },
      "ExportAccepted",
      202,
      f.created.runEpoch,
    );
    await f.advance(1);
    const artifact = await f.get(
      `${f.base}/exports/${exported.json().export.exportId}`,
      "ExportView",
    );
    expect(artifact.status).toBe("succeeded");
    expect(artifact.artifact.outcome.sealedHash).toBe(outcome.sealedHash);
  });

  it("retries do not spend or mutate twice and stale epoch/version errors are structured", async () => {
    const f = await fixture();
    const p = await f.projection();
    const body = {
      expectedStateVersion: p.stateVersion,
      expectedSceneId: p.sceneId,
      payload: {
        actionId: "WAIT",
        waitDurationMs: 15000,
        reason: "等待更多线索",
        reasonAnnotation: null,
        basedOnAdviceJobId: null,
        referencedReportIds: [],
        cancelPendingInvestigations: false,
      },
    };
    const key = randomUUID();
    const first = await f.post(
      `${f.base}/actions`,
      body,
      "ActionAccepted",
      202,
      f.created.runEpoch,
      key,
    );
    const second = await f.post(
      `${f.base}/actions`,
      body,
      "ActionAccepted",
      202,
      f.created.runEpoch,
      key,
    );
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(second.json()).toEqual(first.json());
    const conflict = await f.app.inject({
      method: "POST",
      url: `${f.base}/actions`,
      headers: {
        ...f.headers,
        "idempotency-key": key,
        "x-run-epoch": f.created.runEpoch,
      },
      payload: { ...body, payload: { ...body.payload, waitDurationMs: 30000 } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    await f.advance(15000);
    for (const [epoch, expectedCode] of [
      [randomUUID(), "RUN_EPOCH_CONFLICT"],
      [f.created.runEpoch, "STATE_VERSION_CONFLICT"],
    ]) {
      const stale = await f.app.inject({
        method: "POST",
        url: `${f.base}/actions`,
        headers: {
          ...f.headers,
          "idempotency-key": randomUUID(),
          "x-run-epoch": epoch,
        },
        payload: body,
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().code).toBe(expectedCode);
      expect(registry.errors("Problem", stale.json())).toEqual([]);
    }
  });

  it("reconnects a real SSE cursor using runEpoch and emits only schema-valid public events", async () => {
    const f = await fixture();
    const p = await f.projection();
    expect(p.lastViewCursor).toMatch(new RegExp(`^${f.created.runEpoch}:`));
    const response = await f.app.inject({
      url: `${f.base}/events?after=${p.lastViewCursor}`,
      headers: f.headers,
      payloadAsStream: true,
    });
    expect(response.statusCode).toBe(200);
    const wirePromise = new Promise<string>((resolve, reject) => {
      let text = "";
      const stream = response.stream();
      const timer = setTimeout(
        () => reject(new Error("No public clock sample after cursor")),
        2000,
      );
      stream.on("data", (chunk) => {
        text += chunk.toString();
        if (text.includes("event: clock.sample")) {
          clearTimeout(timer);
          resolve(text);
        }
      });
      stream.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await f.advance(1000);
    const wire = await wirePromise;
    for (const line of wire
      .split("\n")
      .filter((line) => line.startsWith("data: "))) {
      expect(
        registry.errors("PublicSseEvent", JSON.parse(line.slice(6))),
      ).toEqual([]);
    }
    expect(wire).toContain(`id: ${f.created.runEpoch}:`);
    expect(wire).not.toMatch(
      /privateWorld|caseId|tokenHash|inputManifest|systemPrompt/,
    );
    const denied = await f.app.inject({
      url: `/api/v1/sessions/${randomUUID()}`,
      headers: f.headers,
    });
    expect(denied.statusCode).toBe(404);
  });

  it("reveals stable UUID source relations only after a completed paid trace", async () => {
    const f = await fixture();
    await f.command(
      "/tasks",
      {
        taskKind: "request_report",
        targetRole: "liaison",
        topicId: "gate_status",
      },
      "TaskAccepted",
      202,
    );
    await f.advance(1000);
    const current = await f.projection();
    const source = current.reports.find((r) => r.sourceRole === "liaison")!;
    expect(source).toBeDefined();
    const before = (await f.get(
      `${f.base}/provenance?sceneId=E1`,
      "ProvenanceView",
    )) as Public.ProvenanceView;
    expect(before.edges).toHaveLength(0);
    expect(before.nodes.every((n) => n.kind === "report")).toBe(true);
    const option = current.taskOptions.find(
      (o) =>
        o.investigationKind === "provenance_trace" &&
        o.targetId === `${source.card.definitionId}.trace`,
    )!;
    const balance = current.resources.find(
      (r) => r.channel === option.resourceChannel,
    )!.remaining;
    await f.command(
      "/tasks",
      {
        taskKind: "investigate_and_report",
        targetRole: option.targetRole,
        topicId: option.topicId,
        targetId: option.targetId,
        investigationKind: "provenance_trace",
        sourceReportId: source.reportId,
        reasonAnnotation: null,
      },
      "TaskAccepted",
      202,
    );
    // Accepted work and elapsed investigation are not early source disclosure.
    const pending = (await f.get(
      `${f.base}/provenance?sceneId=E1`,
      "ProvenanceView",
    )) as Public.ProvenanceView;
    expect(pending.edges).toHaveLength(0);
    await f.advance(option.cost.knownDurationMs! + 1000);
    const graph = (await f.get(
      `${f.base}/provenance?sceneId=E1`,
      "ProvenanceView",
    )) as Public.ProvenanceView;
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.nodes.some((n) => n.kind === "verified_source")).toBe(true);
    const repeated = (await f.get(
      `${f.base}/provenance?sceneId=E1`,
      "ProvenanceView",
    )) as Public.ProvenanceView;
    expect(repeated.nodes).toEqual(graph.nodes);
    expect(repeated.edges).toEqual(graph.edges);
    const after = await f.projection();
    expect(
      after.resources.find((r) => r.channel === option.resourceChannel)!
        .remaining,
    ).toBe(balance - 1);
    expect(after.reportQuotas.find((q) => q.role === "liaison")!.used).toBe(2);
  });

  it("executes all three authored route decisions through HTTP and seals actual arrival", async () => {
    const f = await fixture();
    for (const [sceneId, actionId] of [
      ["E1", "E1_MAIN"],
      ["E2", "E2_MAIN"],
      ["E3", "E3_BRIDGE"],
    ] as const) {
      const p = await f.projection();
      expect(p.sceneId).toBe(sceneId);
      expect(
        p.actionOptions.some((a) => a.actionId === actionId && a.available),
      ).toBe(true);
      await f.command(
        "/actions",
        {
          actionId,
          waitDurationMs: null,
          reason: "在当前公开线索下执行路线",
          reasonAnnotation: null,
          basedOnAdviceJobId: null,
          referencedReportIds: [],
          cancelPendingInvestigations: false,
        },
        "ActionAccepted",
        202,
      );
      for (let n = 0; n < 60; n += 1) {
        await f.advance(5000);
        const next = await f.projection();
        if (next.phase !== "resolving") break;
      }
    }
    const outcome = (await f.get(
      `${f.base}/outcome`,
      "OutcomeView",
    )) as Public.OutcomeView;
    expect(outcome.taskSuccess).toBe(true);
    expect(["arrived", "awaiting_transfer"]).toContain(
      outcome.terminationReason,
    );
    expect(outcome.finalLocation.nodeId).toBe("N07");
    expect(outcome.routeIdsTaken).toContain("R00");
    expect(outcome.arrivedAtMissionMs).not.toBeNull();
    expect(outcome.handoffCompletedAtMissionMs).toBeNull();
  });
});
