import {
  openIntel,
  openAdvisor,
  openMission,
  closeMission,
} from "./layout-helpers";
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
  projection(sessionId: string): Promise<Public.SessionProjection>;
}
// This is a separate production-build UI test. Only this Node fixture owns the
// injected clock; every player interaction still uses the actual browser/API.
// No time-control route, browser clock override or network mock exists.
const test = base.extend<{
  campaign: CampaignHarness;
}>({
  campaign: async ({}, use) => {
    let elapsed = 0;
    const service: GameService = await createGameService({
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
        PORT: "33120",
      });
      app = await createHttpApp({ service, config, closeServiceOnClose: true });
      await app.listen({ host: "127.0.0.1", port: 33120 });
      await use({
        url: "http://127.0.0.1:33120",
        advance: async (milliseconds) => {
          if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0)
            throw new Error("Positive test-clock advance required");
          elapsed += milliseconds;
          await service.tick();
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
        projection: async (sessionId) =>
          (await service.read(
            "getSession",
            sessionId,
          )) as Public.SessionProjection,
      });
    } finally {
      if (app) await app.close();
      else await service.close();
    }
  },
});
async function english(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  // The Chinese language selector is deliberately written in its own language.
  const text = (await page.locator("body").innerText()).replaceAll("中文", "");
  expect(
    text.match(/[\u3400-\u9fff]+/g),
    "Untranslated authored text in English view",
  ).toBeNull();
  const inaccessibleLabels = await page
    .locator("[aria-label], [title], [placeholder]")
    .evaluateAll((elements) =>
      elements
        .filter((e) => e.getClientRects().length > 0)
        .flatMap((e) =>
          ["aria-label", "title", "placeholder"].map(
            (a) => e.getAttribute(a) ?? "",
          ),
        )
        .map((text) => text.replaceAll("中文", ""))
        .filter((text) => /[\u3400-\u9fff]/.test(text)),
    );
  expect(
    inaccessibleLabels,
    "Untranslated visible accessibility labels",
  ).toEqual([]);
}
async function fit(page: Page) {
  const widths = await page.evaluate(() => ({
    viewport: innerWidth,
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.body).toBeLessThanOrEqual(widths.viewport + 1);
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
}
async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({
    path: info.outputPath(name + ".png"),
    fullPage: true,
    animations: "disabled",
  });
}
async function close(page: Page) {
  await page.locator("dialog .modal-header button").click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}
test("language choice: English by default, Chinese and English persist after reload", async ({
  page,
  campaign,
}, info) => {
  await page.goto(campaign.url);
  await expect(page.locator(".hero-cta")).toBeEnabled();
  await english(page);
  await shot(page, info, "01-English-title");
  await page.setViewportSize({ width: 390, height: 844 });
  await fit(page);
  await english(page);
  await shot(page, info, "02-English-title-mobile");
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(
    page.getByRole("button", { name: "进入任务简报", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(
    page.getByRole("button", { name: "进入任务简报", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.reload();
  await expect(page.locator(".hero-cta")).toBeEnabled();
  await english(page);
  await fit(page);
});
test("English complete campaign: translated evidence, modals, sources, advisor and sealed review", async ({
  page,
  campaign,
}, info) => {
  const errors: string[] = [];
  const badResponses: Array<{
    url: string;
    status: number;
  }> = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.url().includes("/api/v1/") && r.status() >= 400)
      badResponses.push({ url: r.url(), status: r.status() });
  });
  await page.goto(campaign.url);
  await expect(page.locator(".hero-cta")).toBeEnabled();
  await english(page);
  await page.locator(".landing-nav .text-button").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await english(page);
  await close(page);
  const createdResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith("/api/v1/sessions"),
  );
  await page.locator(".hero-cta").click();
  const createResponse = await createdResponse;
  expect(createResponse.request().postDataJSON().locale).toBe("en-US");
  const created = (await createResponse.json()) as Public.SessionCreated;
  const sid = created.sessionId;
  const projection = async () => await campaign.projection(sid);
  await expect(page.locator(".brief-footer .primary")).toBeEnabled();
  await english(page);
  await fit(page);
  await shot(page, info, "03-English-briefing");
  await page.locator(".brief-footer .primary").click();
  await campaign.advance(30000);
  await expect(page.locator(".scene-location")).toContainText("N01");
  await openAdvisor(page);
  await expect(page.locator(".advice-content")).toBeVisible();
  await english(page);
  await page.reload();
  await expect(page.locator(".scene-location")).toContainText("N01");
  expect((await projection()).locale).toBe("en-US");
  await english(page);
  const contextReceipt = page.waitForResponse(
    (r) =>
      r.url().endsWith("/display-receipts") &&
      r.request().postDataJSON()?.payload?.displayKind === "context_displayed",
  );
  await openMission(page);
  await page.locator(".resource-context").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await english(page);
  expect((await contextReceipt).status()).toBe(200);
  await shot(page, info, "04-English-resource-boundaries");
  await close(page);
  await closeMission(page);
  await page.getByTestId("open-story").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await english(page);
  await close(page);
  await openIntel(page);
  const satellite = (await projection()).taskOptions.find(
    (o) => o.investigationKind === "satellite_scan" && o.available,
  )!;
  await page
    .locator(".investigation-card")
    .filter({ hasText: satellite.label })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await english(page);
  const accepted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/tasks"),
  );
  await page.locator("dialog .decision-submit .primary").click();
  expect((await accepted).status()).toBe(202);
  await campaign.advance(satellite.cost.knownDurationMs! + 1000);
  await expect(
    page.locator(".intel-panel .tab-bar button").nth(1),
  ).toContainText("1");
  await page.locator(".intel-panel .tab-bar button").nth(1).click();
  await page.locator(".report-heading").first().click();
  await expect(page.locator(".report-body")).toBeVisible();
  await english(page);
  await page.locator(".upload-button").click();
  await expect(page.locator(".upload-button")).toBeDisabled();
  await openAdvisor(page);
  await expect(page.locator(".ai-boundary")).toContainText("1 / 5");
  await page.locator(".quick-questions button").first().click();
  await openAdvisor(page);
  await expect(page.locator(".advice-content")).toBeVisible();
  await page.locator(".evidence-toggle").click();
  await english(page);
  await shot(page, info, "05-English-evidence-and-advisor");
  async function route(actionId: string, nextScene: Public.SceneId | null) {
    const option = (await projection()).actionOptions.find(
      (a) => a.actionId === actionId && a.available,
    )!;
    await page
      .locator(".route-choice")
      .filter({ hasText: option.label })
      .click();
    await expect(page.locator(".decision-inline")).toBeVisible();
    await english(page);
    const accepted = page.waitForResponse(
      (r) => r.url().endsWith("/actions") && r.request().method() === "POST",
    );
    await page.locator(".decision-inline .decision-submit .primary").click();
    expect((await accepted).status()).toBe(202);
    for (let n = 0; n < 60; n++) {
      await campaign.advance(5000);
      const p = await projection();
      if (
        p.lifecycle === "sealed" ||
        (p.phase === "scene" && p.sceneId === nextScene)
      )
        break;
    }
  }
  await route("E1_MAIN", "E2");
  await expect(page.locator(".scene-location")).toContainText("N02");
  await openIntel(page);
  await page.locator(".intel-panel .tab-bar button").first().click();
  await english(page);
  await shot(page, info, "06-English-market");
  await page.locator(".role-switch button").nth(1).click();
  const report = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/tasks"),
  );
  await page.locator(".brief-topics button").last().click();
  expect((await report).status()).toBe(202);
  await campaign.advance(1000);
  await expect(
    page.locator(".intel-panel .tab-bar button").nth(1),
  ).toContainText("1");
  const trace = (await projection()).taskOptions.find(
    (o) => o.targetId === "market_broadcast.trace",
  )!;
  await page
    .locator(".investigation-card")
    .filter({ hasText: trace.label })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await english(page);
  await page.locator("#trace-source").selectOption({ index: 1 });
  const traced = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/tasks"),
  );
  await page.locator("dialog .decision-submit .primary").click();
  expect((await traced).status()).toBe(202);
  await campaign.advance(trace.cost.knownDurationMs! + 1000);
  await expect(
    page.locator(".intel-panel .tab-bar button").nth(1),
  ).toContainText("2");
  await page.locator(".intel-panel .section-heading .icon-button").click();
  await expect(page.locator(".provenance-relations p")).not.toHaveCount(0);
  await english(page);
  await shot(page, info, "07-English-provenance");
  await close(page);
  await route("E2_BYPASS", "E3");
  await expect(page.locator(".scene-location")).toContainText("N05");
  await english(page);
  await shot(page, info, "08-English-bridge");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "2D route map", exact: true }).click();
  await expect(page.locator(".map2d")).toBeVisible();
  await fit(page);
  await english(page);
  await shot(page, info, "09-English-mobile-2D");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await route("E3_BRIDGE", null);
  await expect(page.locator(".dimension")).toHaveCount(4);
  await english(page);
  await shot(page, info, "10-English-review");
  await page.locator(".review-toolbar .tab-bar button").nth(1).click();
  await expect(page.locator(".timeline-card")).not.toHaveCount(0);
  await english(page);
  const downloadPromise = page.waitForEvent("download");
  await page.locator(".review-toolbar > .secondary").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^LAST_MILE_[\da-f]{8}\.json$/);
  await info.attach("clock-and-language-scope", {
    body: "Production build + actual browser/API + SQLite; test-process clock, case A. English authored visible text, data, accessibility labels and offline AI checked. Player-supplied text is never auto-translated.",
    contentType: "text/plain",
  });
  expect(errors).toEqual([]);
  expect(badResponses).toEqual([]);
});
