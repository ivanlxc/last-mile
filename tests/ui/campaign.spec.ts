import {
  test as base,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { FastifyInstance } from "fastify";
import {
  createGameService,
  type GameService,
} from "../../server/core/service.js";
import { createAiService } from "../../server/ai/index.js";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";
import type * as Public from "../../docs/engineering_v0.5/contracts/public.types.js";

interface CampaignHarness {
  url: string;
  advance(milliseconds: number): Promise<void>;
  projection(sessionId: string): Public.SessionProjection;
}

// This is a separate production-build UI test. Only this Node fixture owns the
// injected clock; every player interaction still uses the actual browser/API.
// No time-control route, browser clock override or network mock exists.
const test = base.extend<{ campaign: CampaignHarness }>({
  campaign: async ({}, use) => {
    let elapsed = 0;
    const service: GameService = createGameService({
      dbPath: ":memory:",
      recoverOnStartup: false,
      autoTick: false,
      selectCase: () => "A",
      clock: {
        nowMs: () => Date.UTC(2026, 8, 16, 12) + elapsed,
        monotonicMs: () => elapsed,
      },
      agents: createAiService({ env: {} }),
    });
    let app: FastifyInstance | undefined;
    try {
      const config = loadHttpConfig({
        LAST_MILE_ROOT: process.cwd(),
        PORT: "33119",
      });
      app = await createHttpApp({ service, config, closeServiceOnClose: true });
      await app.listen({ host: "127.0.0.1", port: 33119 });
      await use({
        url: "http://127.0.0.1:33119",
        advance: async (milliseconds) => {
          if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0)
            throw new Error("Positive test-clock advance required");
          elapsed += milliseconds;
          service.tick();
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
        projection: (sessionId) =>
          service.read("getSession", sessionId) as Public.SessionProjection,
      });
    } finally {
      if (app) await app.close();
      else service.close();
    }
  },
});

async function closeModal(page: Page) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}
async function assertNoHorizontalOverflow(page: Page) {
  const size = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(size.document, JSON.stringify(size)).toBeLessThanOrEqual(
    size.viewport + 1,
  );
  expect(size.body, JSON.stringify(size)).toBeLessThanOrEqual(
    size.viewport + 1,
  );
}

test("production UI: authored A campaign, confirmed investigation, source disclosure and 390px fallback", async ({
  page,
  campaign,
}, info) => {
  const errors: string[] = [];
  const failures: Array<{ path: string; status: number }> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/api/v1/") && response.status() >= 400)
      failures.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
  });
  await page.goto(campaign.url);
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  const createdResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/v1/sessions",
  );
  await page.getByRole("button", { name: "进入任务简报" }).click();
  const created = (await (
    await createdResponse
  ).json()) as Public.SessionCreated;
  const sessionId = created.sessionId;
  const projection = () => campaign.projection(sessionId);
  await page.getByRole("button", { name: "开始护送" }).click();
  await expect(page.getByRole("heading", { name: "现场情报" })).toBeVisible();
  await campaign.advance(30000);
  await expect(
    page.getByRole("heading", { name: "门后的答案", exact: true }),
  ).toBeVisible();
  expect(projection().location.nodeId).toBe("N01");
  await screenshot(page, info, "01-E1-west-gate");

  const receipt = page.waitForResponse(
    (r) =>
      r.url().endsWith("/display-receipts") &&
      r.request().postDataJSON()?.payload?.displayKind === "context_displayed",
  );
  await page
    .getByRole("button", { name: "资源与信息边界", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "此刻的资源、成本与信息边界" }),
  ).toBeVisible();
  expect((await receipt).status()).toBe(200);
  await closeModal(page);

  // A confirmation modal must not spend resources until its explicit submit.
  const satellite = projection().taskOptions.find(
    (o) => o.investigationKind === "satellite_scan" && o.available,
  )!;
  const initialSatellite = projection().resources.find(
    (r) => r.channel === "satellite",
  )!.remaining;
  await page
    .locator(".investigation-card")
    .filter({ hasText: satellite.label })
    .click();
  await expect(
    page.getByRole("heading", { name: satellite.label, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("这个渠道能回答什么", { exact: true }),
  ).toBeVisible();
  expect(
    projection().resources.find((r) => r.channel === "satellite")!.remaining,
  ).toBe(initialSatellite);
  await page.getByLabel("我已考虑这个渠道的观察限制", { exact: true }).check();
  await page
    .getByLabel("我已比较这次调查与行进的时间成本", { exact: true })
    .check();
  const taskResponse = page.waitForResponse(
    (r) => r.url().endsWith("/tasks") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "发起调查", exact: true }).click();
  expect((await taskResponse).status()).toBe(202);
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await campaign.advance(satellite.cost.knownDurationMs! + 1000);
  await expect(
    page.getByRole("button", { name: /^已收到\s*1$/ }),
  ).toBeVisible();
  expect(
    projection().resources.find((r) => r.channel === "satellite")!.remaining,
  ).toBe(initialSatellite - 1);

  async function route(actionId: string, nextScene: Public.SceneId | null) {
    const option = projection().actionOptions.find(
      (a) => a.actionId === actionId && a.available,
    )!;
    expect(option).toBeDefined();
    await page
      .locator(".route-choice")
      .filter({ hasText: option.label })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const accepted = page.waitForResponse(
      (r) => r.url().endsWith("/actions") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "确认行动", exact: true }).click();
    expect((await accepted).status()).toBe(202);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    for (let n = 0; n < 60; n += 1) {
      await campaign.advance(5000);
      const p = projection();
      if (
        p.lifecycle === "sealed" ||
        (p.phase === "scene" && p.sceneId === nextScene)
      )
        break;
    }
    if (nextScene) expect(projection().sceneId).toBe(nextScene);
    else expect(projection().lifecycle).toBe("sealed");
  }

  await route("E1_MAIN", "E2");
  await expect(
    page.getByRole("heading", { name: "回声的重量", exact: true }),
  ).toBeVisible();
  expect(projection().location.nodeId).toBe("N02");
  await screenshot(page, info, "02-E2-market");
  await page
    .locator(".role-switch button")
    .filter({ hasText: "萨米拉" })
    .click();
  const broadcast = page.waitForResponse(
    (r) => r.url().endsWith("/tasks") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "消息与来源", exact: true }).click();
  expect((await broadcast).status()).toBe(202);
  await campaign.advance(1000);
  await expect(
    page.getByRole("button", { name: /^已收到\s*1$/ }),
  ).toBeVisible();

  // The same UI must show no inferred source edges before a paid trace.
  const beforeGraph = page.waitForResponse((r) =>
    r.url().includes("/provenance?sceneId=E2"),
  );
  await page.getByRole("button", { name: "来源关系图", exact: true }).click();
  const beforeGraphData = (await (
    await beforeGraph
  ).json()) as Public.ProvenanceView;
  expect(beforeGraphData.edges).toHaveLength(0);
  await expect(
    page.getByRole("img", { name: "本关公开消息来源关系" }),
  ).toBeVisible();
  await screenshot(page, info, "03-sources-before-trace");
  await closeModal(page);

  const traceOption = projection().taskOptions.find(
    (o) =>
      o.investigationKind === "provenance_trace" &&
      o.targetId === "market_broadcast.trace",
  )!;
  expect(traceOption).toBeDefined();
  await page
    .locator(".investigation-card")
    .filter({ hasText: traceOption.label })
    .click();
  await expect(
    page.getByRole("button", { name: "发起调查", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("追溯哪份报告", { exact: true })
    .selectOption({ label: "地方广播摘录" });
  await page
    .getByLabel("你想解决的具体问题", { exact: false })
    .selectOption("source_chain");
  const traceResponse = page.waitForResponse(
    (r) => r.url().endsWith("/tasks") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "发起调查", exact: true }).click();
  expect((await traceResponse).status()).toBe(202);
  await campaign.advance(traceOption.cost.knownDurationMs! + 1000);
  await expect(
    page.getByRole("button", { name: /^已收到\s*2$/ }),
  ).toBeVisible();
  const afterGraph = page.waitForResponse((r) =>
    r.url().includes("/provenance?sceneId=E2"),
  );
  await page.getByRole("button", { name: "来源关系图", exact: true }).click();
  const graphResponse = await afterGraph;
  expect(graphResponse.status(), await graphResponse.text()).toBe(200);
  const graph = (await graphResponse.json()) as Public.ProvenanceView;
  expect(graph.edges.length).toBeGreaterThan(0);
  expect(graph.edges.every((e) => e.status === "verified")).toBe(true);
  await expect(page.locator(".provenance-relations")).toContainText("已核实");
  await screenshot(page, info, "04-sources-after-trace");
  await closeModal(page);

  await route("E2_BYPASS", "E3");
  await expect(page.locator(".scene-location")).toContainText("N05");
  expect(projection().location.nodeId).toBe("N05");
  await screenshot(page, info, "05-E3-west-bank");
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "二维路线图", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "公开路线图与车队当前位置" }),
  ).toBeVisible();
  await expect(
    page.getByText("路线示意 · 非实时侦察", { exact: true }),
  ).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await screenshot(page, info, "06-mobile-390-2D-fallback");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await route("E3_BRIDGE", null);
  await expect(
    page.getByRole("heading", { name: "已抵达，最后一程。", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".dimension")).toHaveCount(4);
  const outcomeResponse = await page.request.get(
    `${campaign.url}/api/v1/sessions/${sessionId}/outcome`,
  );
  expect(outcomeResponse.status()).toBe(200);
  const outcome = (await outcomeResponse.json()) as Public.OutcomeView;
  expect(outcome.taskSuccess).toBe(true);
  expect(outcome.finalLocation.nodeId).toBe("N07");
  expect(outcome.handoffCompletedAtMissionMs).toBeNull();
  expect(outcome.pendingTasks.manifest).not.toBe("pending");
  expect(outcome.pendingTasks.inspection).not.toBe("pending");
  await screenshot(page, info, "07-arrival-AAR");
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page);
  await screenshot(page, info, "08-mobile-390-AAR");
  await info.attach("test-clock-notice", {
    body: "Production build + real browser + real API + SQLite. Node-only injected clock; authored A case. This test does not establish real-time duration. functional.spec.ts separately verifies actual 30-second entry.",
    contentType: "text/plain",
  });
  expect(errors).toEqual([]);
  expect(failures).toEqual([]);
});
