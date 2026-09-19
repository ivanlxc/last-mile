import { expect, test, type Page } from "@playwright/test";

async function briefing(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem("last-mile-map-renderer-v1", "two"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "English", exact: true }).click();
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/sessions",
  );
  await page
    .getByRole("button", { name: "Enter mission briefing", exact: true })
    .click();
  const { sessionId } = await (await creation).json();
  await expect(page.locator(".map2d")).toBeVisible();
  return {
    projection: async () =>
      (await page.request.get(`/api/v1/sessions/${sessionId}`)).json(),
  };
}

async function expectEndpointsVisible(page: Page) {
  // Container resize and the responsive map fit settle on the next animation
  // frame; verify the final visible geometry rather than a transient frame.
  await expect
    .poll(async () => {
      const viewport = (await page.locator(".map-viewport").boundingBox())!;
      const clipped: string[] = [];
      for (const id of ["N00", "N01", "N02", "N04", "N05", "N07"]) {
        const dot = (await page
          .locator(`[data-node-id="${id}"] .satellite-node-dot`)
          .boundingBox())!;
        if (
          dot.x <= viewport.x ||
          dot.y <= viewport.y ||
          dot.x + dot.width >= viewport.x + viewport.width ||
          dot.y + dot.height >= viewport.y + viewport.height
        )
          clipped.push(id);
      }
      return clipped;
    })
    .toEqual([]);
}

test("satellite map preserves public geometry, desktop navigation, keyboard selection and the moving convoy", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { projection } = await briefing(page);
  const map = page.locator(".satellite-map");
  await expect(map).toHaveAttribute("data-imagery", "ready");
  await expect(page.locator(".satellite-imagery")).toHaveAttribute(
    "href",
    "/assets/valley-satellite-v1.webp",
  );
  await expect(page.locator(".satellite-route")).toHaveCount(13);
  await expect(page.locator(".satellite-node")).toHaveCount(11);
  await expect(page.locator(".satellite-node.current")).toHaveCount(0);
  await expect(page.locator('[data-node-id="N01"]')).toHaveAttribute(
    "transform",
    /^translate\(416 672\)/,
  );
  await expect(page.locator('[data-node-id="N05"]')).toHaveAttribute(
    "transform",
    /^translate\(864 480\)/,
  );
  await expect(page.locator('[data-route-id="R06"]')).toHaveAttribute(
    "points",
    /^864,480 .* 992,480$/,
  );
  await expect(page.locator(".satellite-convoy")).toHaveAttribute(
    "transform",
    "translate(256 800)",
  );
  await expectEndpointsVisible(page);
  await page.screenshot({
    path: info.outputPath("satellite-briefing.png"),
    fullPage: true,
  });

  const before = await projection();
  const clinic = page.locator('[data-node-id="N03"]');
  await clinic.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".map-selection-title")).toContainText("N03");
  const gate = page.locator('[data-node-id="N01"]');
  await gate.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".map-selection-title")).toContainText("N01");
  await expect(gate).toHaveAttribute("aria-pressed", "true");
  const after = await projection();
  expect(after.location).toEqual(before.location);
  expect(after.reports).toEqual(before.reports);
  expect(after.resources).toEqual(before.resources);
  expect(after.missionTimeMs).toBe(0);
  await page
    .getByRole("button", { name: "Close location details", exact: true })
    .click();

  await page.getByRole("button", { name: "Start escort", exact: true }).click();
  await expect(page.locator(".map-first-command")).toBeVisible();
  await expect(map).toHaveAttribute("data-imagery", "ready");
  await expect(
    page.getByText("Satellite-style terrain · not live imagery", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('[data-route-id="R00"]')).toHaveClass(/current/);
  const convoyAtStart = await page
    .locator(".satellite-convoy")
    .getAttribute("transform");
  await expect
    .poll(() => page.locator(".satellite-convoy").getAttribute("transform"))
    .not.toBe(convoyAtStart);
  await expectEndpointsVisible(page);
  await page.screenshot({
    path: info.outputPath("satellite-stage.png"),
    fullPage: true,
  });

  const world = page.locator(".satellite-world");
  await page
    .getByRole("button", { name: "Zoom in on map", exact: true })
    .click();
  await expect(world).toHaveAttribute("data-zoom", "1.4000");
  const viewport = (await page.locator(".map-viewport").boundingBox())!;
  const pointer = {
    x: Math.round(viewport.x + viewport.width * 0.42),
    y: Math.round(viewport.y + viewport.height * 0.58),
  };
  const pointUnderPointer = () =>
    world.evaluate((element, point) => {
      const matrix = (element as SVGGraphicsElement).getScreenCTM()!;
      const p = new DOMPoint(point.x, point.y).matrixTransform(
        matrix.inverse(),
      );
      return { x: p.x, y: p.y };
    }, pointer);
  const beforeWheel = await pointUnderPointer();
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.wheel(0, -250);
  await expect
    .poll(async () => Number(await world.getAttribute("data-zoom")))
    .toBeGreaterThan(1.9);
  const afterWheel = await pointUnderPointer();
  expect(afterWheel.x).toBeCloseTo(beforeWheel.x, 1);
  expect(afterWheel.y).toBeCloseTo(beforeWheel.y, 1);
  const beforeDrag = await world.getAttribute("transform");
  await page.mouse.down();
  await page.mouse.move(pointer.x + 95, pointer.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect(world).not.toHaveAttribute("transform", beforeDrag!);
  await expect(page.locator(".map-selection")).toHaveCount(0);
  expect(await world.locator(":scope > .satellite-imagery").count()).toBe(1);
  expect(await world.locator(":scope > .satellite-convoy").count()).toBe(1);

  const retainedView = await world.getAttribute("transform");
  await page
    .getByRole("button", { name: "3D terrain model", exact: true })
    .click();
  await expect(map).toBeHidden();
  await page.getByRole("button", { name: "2D route map", exact: true }).click();
  await expect(map).toBeVisible();
  await expect(world).toHaveAttribute("transform", retainedView!);
  await page
    .getByRole("button", { name: "Reset map view", exact: true })
    .click();
  await expect(world).toHaveAttribute("data-zoom", "1.0000");
  await expect(
    page.getByRole("button", { name: "Zoom out of map", exact: true }),
  ).toBeDisabled();
  await expectEndpointsVisible(page);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expectEndpointsVisible(page);
  await expect
    .poll(async () => {
      const image = (await page.locator(".satellite-imagery").boundingBox())!;
      const bounds = (await page.locator(".map-viewport").boundingBox())!;
      return image.width / bounds.width;
    })
    .toBeGreaterThan(0.83);
  await page.screenshot({
    path: info.outputPath("satellite-stage-1280.png"),
    fullPage: true,
  });
  await page.getByTestId("open-intel").click();
  await expect
    .poll(async () => {
      const image = (await page.locator(".satellite-imagery").boundingBox())!;
      const bounds = (await page.locator(".map-viewport").boundingBox())!;
      return image.width / bounds.width;
    })
    .toBeGreaterThanOrEqual(0.99);
  await expectEndpointsVisible(page);
  await page.screenshot({
    path: info.outputPath("satellite-intel-1280.png"),
    fullPage: true,
  });
  await page.getByTestId("open-mission").click();
  await page
    .getByRole("button", { name: "End this session", exact: true })
    .click();
  const frozenView = await world.getAttribute("transform");
  await expect(
    page.getByRole("button", { name: "Zoom in on map", exact: true }),
  ).toBeDisabled();
  await expect(world).toHaveAttribute("transform", frozenView!);
  await page
    .getByRole("button", { name: "End and review", exact: true })
    .click();
  await expect(page.locator(".ending-map .satellite-map")).toHaveAttribute(
    "data-imagery",
    "ready",
  );
  await expect(page.locator(".ending-map .map2d")).toHaveAttribute(
    "role",
    "img",
  );
  await expect(
    page.locator(".ending-map button, .ending-map [tabindex]"),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("satellite-debrief.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("unavailable terrain imagery retains readable routes and selectable public locations", async ({
  page,
}, info) => {
  await page.route("**/assets/valley-satellite-v1.webp", (route) =>
    route.fulfill({ status: 404 }),
  );
  await briefing(page);
  await expect(page.locator(".satellite-map")).toHaveAttribute(
    "data-imagery",
    "error",
  );
  await expect(
    page.getByText(
      "Terrain image unavailable · public routes remain available",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator(".satellite-route")).toHaveCount(13);
  await expect(page.locator(".satellite-node")).toHaveCount(11);
  await page.locator('[data-node-id="N05"]').click();
  await expect(page.locator(".map-selection-title")).toContainText("N05");
  await page
    .getByRole("button", { name: "Zoom in on map", exact: true })
    .click();
  await expect(page.locator(".satellite-world")).toHaveAttribute(
    "data-zoom",
    "1.4000",
  );
  await page.screenshot({
    path: info.outputPath("satellite-image-fallback.png"),
    fullPage: true,
  });
});
