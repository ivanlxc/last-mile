import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("single player: briefing → report → upload → advisor → WAIT → sealed review → export", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  const apiFailures: Array<{ path: string; status: number; body: string }> = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/api/v1/") && response.status() >= 400) {
      void response.text().then((body) =>
        apiFailures.push({
          path: new URL(response.url()).pathname,
          status: response.status(),
          body,
        }),
      );
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  const createdResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/v1/sessions",
  );
  await page.getByRole("button", { name: "进入任务简报" }).click();
  const created = await (await createdResponse).json();
  await expect(page.getByText("此页不计时", { exact: false })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("briefing.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "开始护送" }).click();
  await expect(page.getByRole("heading", { name: "现场情报" })).toBeVisible();
  // Actual 30-second R00 travel. No clock or network mocks.
  await expect(
    page.getByRole("button", { name: "路线情况", exact: true }),
  ).toBeEnabled({ timeout: 40000 });
  const seconds = (value: string) => {
    const [minutes, seconds] = value.split(":").map(Number);
    return minutes! * 60 + seconds!;
  };
  const beforeReload = seconds(
    await page.locator(".mission-clock strong").innerText(),
  );
  const resumedResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      new URL(r.url()).pathname === `/api/v1/sessions/${created.sessionId}`,
  );
  await page.reload();
  const resumed = await (await resumedResponse).json();
  expect(resumed.sessionId).toBe(created.sessionId);
  expect(resumed.sceneId).toBe("E1");
  expect(resumed.missionTimeMs).toBeGreaterThanOrEqual(30000);
  expect(resumed.missionDeadlineMs).toBeNull();
  await expect(page.locator(".mission-clock small")).toHaveText(
    "累计用时 · 不限时",
  );
  await expect(
    page.getByRole("heading", { name: "门后的答案", exact: true }),
  ).toBeVisible();
  const afterReload = seconds(
    await page.locator(".mission-clock strong").innerText(),
  );
  expect(afterReload).toBeGreaterThanOrEqual(30);
  // A fresh authoritative sample can correct subsecond display interpolation.
  expect(afterReload).toBeGreaterThanOrEqual(beforeReload - 1);
  const contextReceipt = page.waitForResponse(
    (r) =>
      r.url().endsWith("/display-receipts") &&
      r.request().postDataJSON()?.payload?.displayKind === "context_displayed",
  );
  await page
    .getByRole("button", { name: "资源与信息边界", exact: true })
    .click();
  expect((await contextReceipt).status()).toBe(200);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "路线情况", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^已收到\s*1$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^已收到\s*1$/ }).click();
  const reportReceipt = page.waitForResponse(
    (r) =>
      r.url().endsWith("/display-receipts") &&
      r.request().postDataJSON()?.payload?.displayKind === "report_opened",
  );
  await page.locator(".report-heading").first().click();
  await expect(page.locator(".report-body")).toBeVisible();
  expect((await reportReceipt).status()).toBe(200);
  await page.getByRole("button", { name: /上传这张卡片/ }).click();
  await expect(
    page.getByRole("button", { name: "已正式上传给 AI" }),
  ).toBeDisabled();
  await expect(page.locator(".ai-boundary")).toContainText("1 / 5");
  const questionResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith("/questions") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "依据是什么", exact: true }).click();
  expect((await questionResponse).status()).toBe(202);
  await expect(page.locator(".advice-content")).toBeVisible();
  const evidenceToggle = page.getByRole("button", { name: /查看分析依据/ });
  const claimCount = Number(
    (await evidenceToggle.innerText()).match(/\((\d+)\)/)?.[1],
  );
  await evidenceToggle.click();
  await expect(page.locator(".claim")).toHaveCount(claimCount);
  await page.screenshot({
    path: testInfo.outputPath("report-and-advice.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: /原地等待/ }).click();
  await expect(
    page.getByRole("heading", { name: "留在现场，继续协调" }),
  ).toBeVisible();
  await page
    .getByLabel("此刻，你为什么这样决定？")
    .fill("测试：核对材料范围后继续协调。");
  await page.getByRole("button", { name: "确认行动", exact: true }).click();
  await expect(
    page.getByText("原地协调中", { exact: false }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "结束本局", exact: true }).click();
  await page.getByRole("button", { name: "结束并复盘", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "这次护送，在此暂停。" }),
  ).toBeVisible();
  await expect(page.locator(".dimension")).toHaveCount(4);
  await page.getByRole("button", { name: /决策回放/ }).click();
  await expect(
    page.locator(".timeline-card").filter({ hasText: "原地等待" }),
  ).toHaveCount(1);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出完整复盘", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^LAST_MILE_[\da-f]{8}\.json$/);
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const artifact = JSON.parse(await readFile(downloadedPath!, "utf8"));
  expect(artifact.format).toBe("last-mile-review-json");
  expect(artifact.outcome.terminationReason).toBe("abandoned");
  const waitDecisions = artifact.replayPages
    .flatMap(
      (p: {
        decisions: Array<{ actionId: string; viewedReportIds: string[] }>;
      }) => p.decisions,
    )
    .filter((d: { actionId: string }) => d.actionId === "WAIT");
  expect(waitDecisions).toHaveLength(1);
  expect(waitDecisions[0].viewedReportIds).toHaveLength(1);
  expect(artifact.evaluationJob.result).not.toBeNull();
  await page.screenshot({
    path: testInfo.outputPath("sealed-review.png"),
    fullPage: true,
    animations: "disabled",
  });
  await testInfo.attach("api-errors", {
    body: JSON.stringify(apiFailures, null, 2),
    contentType: "application/json",
  });
  expect(pageErrors).toEqual([]);
  expect(apiFailures).toEqual([]);
});
