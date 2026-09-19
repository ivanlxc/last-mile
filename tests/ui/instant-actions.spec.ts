import { test as base, expect, type Page } from "@playwright/test";
import type { FastifyInstance } from "fastify";
import { createGameService } from "../../server/core/service.js";
import { createAiService } from "../../server/ai/index.js";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";
import type * as P from "../../docs/engineering_v0.5/contracts/public.types.js";
import { openIntel } from "./layout-helpers";

const origin = "http://127.0.0.1:33135";
type Harness = {
  projection(sessionId: string): Promise<P.SessionProjection>;
  outcome(sessionId: string): Promise<P.OutcomeView>;
};

// The real built client and service use a clock that never advances. There is
// deliberately no tick/advance helper: authored seconds cannot elapse here.
const test = base.extend<{ instantGame: Harness }>({
  instantGame: async ({}, use) => {
    const service = await createGameService({
      dbPath: ":memory:",
      recoverOnStartup: false,
      autoTick: false,
      selectCase: () => "A",
      clock: {
        nowMs: () => Date.UTC(2026, 8, 19),
        monotonicMs: () => 0,
      },
      agents: createAiService({ env: {} }),
    });
    let app: FastifyInstance | undefined;
    try {
      const config = loadHttpConfig({
        LAST_MILE_ROOT: process.cwd(),
        PORT: "33135",
      });
      app = await createHttpApp({ service, config, closeServiceOnClose: true });
      await app.listen({ host: "127.0.0.1", port: 33135 });
      await use({
        projection: async (sessionId) =>
          (await service.read("getSession", sessionId)) as P.SessionProjection,
        outcome: async (sessionId) =>
          (await service.read("getOutcome", sessionId)) as P.OutcomeView,
      });
    } finally {
      if (app) await app.close();
      else await service.close();
    }
  },
});
test.use({ baseURL: origin });

async function start(page: Page, harness: Harness) {
  await page.addInitScript(() => {
    localStorage.setItem("last-mile-locale-v1", "en-US");
    localStorage.setItem("last-mile-map-renderer-v1", "two");
  });
  await page.goto("/");
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/sessions",
  );
  await page
    .getByRole("button", { name: "Enter mission briefing", exact: true })
    .click();
  const created = (await (await creation).json()) as P.SessionCreated;
  const started = page.waitForResponse((response) =>
    response.url().endsWith("/start"),
  );
  await page.getByRole("button", { name: "Start escort", exact: true }).click();
  expect((await started).status()).toBe(200);
  const projection = () => harness.projection(created.sessionId);
  expect(await projection()).toMatchObject({
    actionTiming: "instant",
    sceneId: "E1",
    phase: "scene",
    playerElapsedMs: 0,
    missionTimeMs: 30000,
    activeOperation: null,
    activeTasks: [],
    location: { nodeId: "N01" },
  });
  await expect(page.locator('[data-action-id="E1_MAIN"]')).toBeEnabled();
  return { sessionId: created.sessionId, projection };
}

async function openSatellite(
  page: Page,
  projection: () => Promise<P.SessionProjection>,
) {
  await openIntel(page);
  await page
    .getByRole("button", { name: "Investigate and contact", exact: true })
    .click();
  const option = (await projection()).taskOptions.find(
    (candidate) =>
      candidate.available && candidate.investigationKind === "satellite_scan",
  )!;
  expect(option).toBeDefined();
  await page
    .getByTestId("intel-drawer")
    .locator(".investigation-card")
    .filter({ hasText: option.label })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return option;
}

test("instant campaign delivers briefs and investigations, resolves routes and finishes without advancing the clock", async ({
  page,
  instantGame,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { sessionId, projection } = await start(page, instantGame);
  await openIntel(page);
  const briefResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/tasks") &&
      response.request().method() === "POST",
  );
  await page.locator(".brief-topics button").first().click();
  const brief = (await (await briefResponse).json()) as P.TaskAccepted;
  expect(brief.task.status).toBe("completed");
  expect(brief.task.reportId).not.toBeNull();
  await expect(
    page.locator(`[data-report-id="${brief.task.reportId}"]`),
  ).toHaveClass(/expanded/);
  await expect(page.locator(".report-delivery-status")).toBeVisible();
  expect(await projection()).toMatchObject({
    playerElapsedMs: 0,
    activeTasks: [],
    sceneUploads: [],
  });
  const before = await projection();
  const satellite = await openSatellite(page, projection);
  const remaining = before.resources.find(
    (resource) => resource.channel === "satellite",
  )!.remaining;
  expect((await projection()).resources).toEqual(before.resources);
  const taskResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/tasks") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start investigation", exact: true })
    .click();
  const response = await taskResponse;
  expect(response.status()).toBe(202);
  const task = response.json() as Promise<P.TaskAccepted>;
  const reportId = (await task).task.reportId;
  expect((await task).task.status).toBe("completed");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(`[data-report-id="${reportId}"]`)).toHaveClass(
    /expanded/,
  );
  const delivered = await projection();
  expect(
    delivered.resources.find((resource) => resource.channel === "satellite")!
      .remaining,
  ).toBe(remaining - 1);
  expect(delivered.missionTimeMs).toBe(
    before.missionTimeMs + satellite.cost.knownDurationMs!,
  );
  expect(delivered).toMatchObject({
    playerElapsedMs: 0,
    activeTasks: [],
    sceneUploads: [],
  });
  expect(delivered.unuploadedReportIds).toContain(reportId);
  await page.screenshot({
    path: info.outputPath("instant-investigation-delivered.png"),
  });

  async function action(actionId: string, nextScene: P.SceneId | null) {
    const previous = await projection();
    await page.locator(`[data-action-id="${actionId}"]`).click();
    const accepted = page.waitForResponse(
      (response) =>
        response.url().endsWith("/actions") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Confirm action", exact: true })
      .click();
    const response = await accepted;
    expect(response.status()).toBe(202);
    expect(((await response.json()) as P.ActionAccepted).operation.status).toBe(
      "completed",
    );
    const current = await projection();
    expect(current.playerElapsedMs).toBe(0);
    expect(current.missionTimeMs).toBeGreaterThan(previous.missionTimeMs);
    expect(current.activeTasks).toEqual([]);
    expect(current.activeOperation).toBeNull();
    if (nextScene) {
      expect(current).toMatchObject({
        lifecycle: "active",
        phase: "scene",
        sceneId: nextScene,
      });
      await expect(page.locator(".route-choice").first()).toBeEnabled();
    } else expect(current.lifecycle).toBe("sealed");
    await expect(page.locator(".decision-inline")).not.toBeVisible();
  }
  await action("WAIT", "E1");
  await action("E1_MAIN", "E2");
  await action("E2_BYPASS", "E3");
  await action("E3_BRIDGE", null);
  const outcome = await instantGame.outcome(sessionId);
  expect(outcome.playerElapsedMs).toBe(0);
  expect(outcome.sealedAtMissionMs).toBeGreaterThan(300000);
  expect(outcome.taskSuccess).toBe(true);
  await expect(page.locator(".ending-stats")).toBeVisible();
  await page.screenshot({
    path: info.outputPath("instant-campaign-ending.png"),
  });
  expect(errors).toEqual([]);
});

test("a failed investigation keeps its confirmation and error visible, then retries without a duplicate resource charge", async ({
  page,
  instantGame,
}) => {
  const { projection } = await start(page, instantGame);
  await openSatellite(page, projection);
  const before = await projection();
  const taskPattern = "**/api/v1/sessions/*/tasks";
  // Fault injection only in this error-path test; the successful retry and
  // entire campaign above use the real HTTP service and command transaction.
  await page.route(taskPattern, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "SERVICE_UNAVAILABLE",
        detail: "Test connection interrupted. Please retry.",
      }),
    });
  });
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Start investigation", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Start investigation", exact: true }),
  ).toBeEnabled();
  expect((await projection()).resources).toEqual(before.resources);
  expect((await projection()).reports).toEqual(before.reports);
  await page.unroute(taskPattern);
  await dialog
    .getByRole("button", { name: "Start investigation", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".report-card.expanded")).toHaveCount(1);
  const after = await projection();
  expect(
    after.resources.find((resource) => resource.channel === "satellite")!.spent,
  ).toBe(1);
  expect(after.reports).toHaveLength(1);
  expect(after.activeTasks).toEqual([]);
  expect(after.playerElapsedMs).toBe(0);
  expect(after.sceneUploads).toEqual([]);
});
