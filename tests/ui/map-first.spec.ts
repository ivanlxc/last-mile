import { test, expect } from "@playwright/test";

test("desktop map-first layout keeps map and drafts, opens one drawer, and reviews before committing", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() =>
    localStorage.setItem("last-mile-map-renderer-v1", "two"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "English", exact: true }).click();
  const creation = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/v1/sessions",
  );
  await page
    .getByRole("button", { name: "Enter mission briefing", exact: true })
    .click();
  const { sessionId } = await (await creation).json();
  const projection = async () =>
    (await page.request.get(`/api/v1/sessions/${sessionId}`)).json();
  await page.getByRole("button", { name: "Start escort", exact: true }).click();
  await expect(page.locator(".map-first-command")).toBeVisible();
  const intel = page.getByTestId("intel-drawer"),
    advisor = page.getByTestId("advisor-drawer");
  await expect(intel).toBeHidden();
  await expect(advisor).toBeHidden();
  await expect(page.locator(".mission-clock")).toBeHidden();
  await expect(page.locator(".map2d")).toBeVisible();
  const defaultWidth = (await page.locator(".map-viewport").boundingBox())!
    .width;
  expect(defaultWidth).toBeGreaterThan(1200);
  await page.screenshot({
    path: info.outputPath("map-first-default.png"),
    fullPage: true,
  });

  await page.getByTestId("open-advisor").click();
  await expect(advisor).toBeVisible();
  await expect(intel).toBeHidden();
  await advisor
    .getByRole("textbox", { name: "Ask the AI advisor", exact: true })
    .fill("Compare the source limitations before we move.");
  await page.getByTestId("open-intel").click();
  await expect(intel).toBeVisible();
  await expect(advisor).toBeHidden();
  const splitWidth = (await page.locator(".map-viewport").boundingBox())!.width;
  expect(splitWidth).toBeGreaterThan(800);
  expect(splitWidth).toBeLessThan(defaultWidth);
  await page.keyboard.press("Escape");
  await expect(intel).toBeHidden();
  await expect(page.getByTestId("open-intel")).toBeFocused();
  await page.getByTestId("open-advisor").click();
  await expect(
    advisor.getByRole("textbox", { name: "Ask the AI advisor", exact: true }),
  ).toHaveValue("Compare the source limitations before we move.");
  await page
    .getByRole("button", { name: "Close AI advisor", exact: true })
    .click();

  await page
    .getByRole("button", { name: "3D terrain model", exact: true })
    .click();
  await expect(page.locator(".map3d canvas")).toBeVisible();
  await expect(page.locator(".map3d .map-loading")).toHaveCount(0, {
    timeout: 30000,
  });
  const originalCanvas = await page.locator(".map3d canvas").elementHandle();
  await page.getByTestId("open-intel").click();
  await page.screenshot({
    path: info.outputPath("map-first-terrain-intel.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "2D route map", exact: true }).click();
  await expect(page.locator(".map3d canvas")).toBeHidden();
  await page
    .getByRole("button", { name: "3D terrain model", exact: true })
    .click();
  await expect(page.locator(".map3d canvas")).toBeVisible();
  expect(
    await originalCanvas!.evaluate(
      (el) => el.isConnected && document.querySelector(".map3d canvas") === el,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Close intelligence", exact: true })
    .click();
  await page.getByTestId("open-mission").click();
  await expect(page.locator(".mission-clock small")).toContainText("no limit");
  await page.keyboard.press("Escape");
  await expect(page.locator(".mission-clock")).toBeHidden();

  await expect(page.locator(".route-choice").first()).toBeEnabled({
    timeout: 40000,
  });
  const before = await projection();
  await page.locator(".route-choice").first().click();
  await expect(page.locator(".decision-inline")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const preview = await projection();
  expect(preview.location).toEqual(before.location);
  expect(preview.activeOperation).toBeNull();
  await page.screenshot({
    path: info.outputPath("map-first-decision.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.locator(".decision-inline")).toHaveCount(0);
  await expect(page.locator(".route-choice").first()).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("open-intel").click();
  await expect(intel).toBeVisible();
  await expect(page.locator(".map3d canvas")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sound settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("open-story")).toBeVisible();
  const windowMap = (await page.locator(".map-viewport").boundingBox())!;
  expect(windowMap.height).toBeGreaterThan(350);
  expect(windowMap.width).toBeGreaterThan(800);
  const drawerBounds = (await intel.boundingBox())!;
  expect(windowMap.x).toBeGreaterThanOrEqual(
    drawerBounds.x + drawerBounds.width,
  );
  const width = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
  await page.screenshot({
    path: info.outputPath("map-first-desktop-1280.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
