import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import publicMap from "../../client/src/lib/map-data.json" with { type: "json" };
import type { SessionProjection } from "../../docs/engineering_v0.5/contracts/public.types";

// The authored public coordinate system has south-positive Z. Unity reflects Z
// on import; project the real hotspot into the default perspective camera.
// Pointer input still goes through Unity's Physics.Raycast and Web bridge.
function overviewPoint(
  point: readonly number[],
  bounds: { width: number; height: number },
) {
  const yaw = (-17 * Math.PI) / 180;
  const pitch = (49 * Math.PI) / 180;
  const aspect = bounds.width / bounds.height;
  const distance = Math.min(79, 43 * Math.max(1, 1.45 / Math.max(aspect, 0.6)));
  const relative = [point[0], point[1] + 0.35 - 1, -point[2]];
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [
    Math.sin(yaw) * Math.sin(pitch),
    Math.cos(pitch),
    Math.cos(yaw) * Math.sin(pitch),
  ];
  const forward = [
    Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  ];
  const dot = (axis: number[]) =>
    axis.reduce(
      (sum, component, index) => sum + component * relative[index],
      0,
    );
  const depth = distance + dot(forward);
  const scale = bounds.height / (2 * depth * Math.tan((43 * Math.PI) / 360));
  return {
    x: bounds.width / 2 + dot(right) * scale,
    y: bounds.height / 2 - dot(up) * scale,
  };
}

// This smoke test runs the generated engine, with no network or bridge fixtures.
// Keep the ordinary browser suite usable before a developer installs Unity.
test("real Unity Web build renders Blender art, selects, moves the convoy and releases the canvas", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  test.skip(
    !existsSync("client/public/unity/manifest.json"),
    "Run pnpm build:unity to generate the actual Unity Web build first.",
  );
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  // Observe genuine engine callbacks. Nothing is dispatched or substituted.
  await page.addInitScript(() => {
    const observed: unknown[] = [];
    Object.defineProperty(window, "__observedUnityCallbacks", {
      value: observed,
    });
    window.addEventListener("last-mile-unity", (event) => {
      observed.push((event as CustomEvent).detail);
    });
  });
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
  const { sessionId } = (await (await creation).json()) as {
    sessionId: string;
  };
  await expect(page.locator(".map-engine-status")).toContainText(
    "Unity scene available",
  );
  await page.getByRole("button", { name: "Unity scene", exact: true }).click();
  try {
    await expect(page.locator('[data-unity-status="ready"]')).toBeVisible({
      timeout: 100000,
    });
  } catch (error) {
    await testInfo.attach("real-unity-startup-diagnostics", {
      body: JSON.stringify(
        {
          pageErrors,
          consoleErrors,
          status: await page.locator(".map-engine-status").innerText(),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    throw error;
  }
  const canvas = page.locator("canvas.unity-canvas");
  await expect(canvas).toBeVisible();
  const originalCanvas = await canvas.elementHandle();
  expect(originalCanvas).not.toBeNull();
  const size = await canvas.evaluate((element) => ({
    width: (element as HTMLCanvasElement).width,
    height: (element as HTMLCanvasElement).height,
  }));
  expect(size.width).toBeGreaterThan(100);
  expect(size.height).toBeGreaterThan(100);
  await canvas.screenshot({ path: testInfo.outputPath("unity-briefing.png") });

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const westGate = publicMap.nodes.find((node) => node.nodeId === "N01")!;
  await canvas.click({
    position: overviewPoint(westGate.position, bounds!),
    delay: 120,
  });
  await expect(page.locator(".map-selection")).toContainText("West gate");
  const callbackTypes = await page.evaluate(
    () =>
      (
        window as unknown as {
          __observedUnityCallbacks: Array<{ type: string; nodeId?: string }>;
        }
      ).__observedUnityCallbacks,
  );
  expect(callbackTypes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "ready" }),
      expect.objectContaining({ type: "select-location", nodeId: "N01" }),
    ]),
  );
  const start = page.getByRole("button", { name: "Start escort", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(
    page.getByRole("heading", { name: "Field intelligence", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-unity-status="ready"]')).toBeVisible();
  expect(
    await originalCanvas!.evaluate(
      (element) =>
        element.isConnected &&
        document.querySelector(".unity-canvas") === element,
    ),
  ).toBe(true);
  const projection = async () =>
    (await (
      await page.request.get(`/api/v1/sessions/${sessionId}`)
    ).json()) as SessionProjection;
  const initial = await projection();
  expect(initial.lifecycle).toBe("active");
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/v1/sessions/${sessionId}`);
      return (await response.json()).missionTimeMs as number;
    })
    .toBeGreaterThan(initial.missionTimeMs + 1000);
  const clock = await page.locator(".mission-clock strong").innerText();
  await expect(page.locator(".mission-clock strong")).not.toHaveText(clock);

  await page.getByRole("button", { name: "Expand map", exact: true }).click();
  await expect(page.locator(".tactical-map.expanded")).toBeVisible();
  await canvas.screenshot({
    path: testInfo.outputPath("unity-expanded-scene.png"),
  });

  // Follow the authored convoy with genuine canvas keyboard input. Record two
  // rendered frames while the unmodified server advances along R00. The scene
  // has no animated water/vegetation, and the crop excludes the engine HUD, so
  // substantial pixel movement cannot be supplied by a clock label alone.
  await canvas.click({ position: { x: 20, y: 20 }, delay: 120 });
  await canvas.press("f");
  await expect
    .poll(async () => (await projection()).location.progressPermille)
    .toBeGreaterThan(150);
  const before = await projection();
  expect(before.location.routeId).toBe("R00");
  const beforeFrame = await canvas.screenshot({
    path: testInfo.outputPath("unity-convoy-moving-before.png"),
  });
  await expect
    .poll(async () => (await projection()).location.progressPermille)
    .toBeGreaterThan(before.location.progressPermille + 180);
  const after = await projection();
  expect(after.location.routeId).toBe("R00");
  const afterFrame = await canvas.screenshot({
    path: testInfo.outputPath("unity-convoy-moving-after.png"),
  });
  const compareFrames = (beforeFrame: Buffer, afterFrame: Buffer) =>
    page.evaluate(
      async ({ before, after }) => {
        async function pixels(encoded: string) {
          const bytes = Uint8Array.from(atob(encoded), (value) =>
            value.charCodeAt(0),
          );
          const bitmap = await createImageBitmap(
            new Blob([bytes], { type: "image/png" }),
          );
          const target = document.createElement("canvas");
          target.width = bitmap.width;
          target.height = bitmap.height;
          const context = target.getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          return context.getImageData(0, 50, target.width, target.height - 100)
            .data;
        }
        const a = await pixels(before);
        const b = await pixels(after);
        if (a.length !== b.length)
          throw new Error(
            "The Unity viewport resized during the motion check.",
          );
        let changed = 0;
        for (let i = 0; i < a.length; i += 4)
          if (
            Math.abs(a[i] - b[i]) +
              Math.abs(a[i + 1] - b[i + 1]) +
              Math.abs(a[i + 2] - b[i + 2]) >
            45
          )
            changed++;
        return changed / (a.length / 4);
      },
      {
        before: beforeFrame.toString("base64"),
        after: afterFrame.toString("base64"),
      },
    );
  const changedPixelFraction = await compareFrames(beforeFrame, afterFrame);
  const motionEvidencePath = testInfo.outputPath("unity-motion-evidence.json");
  await writeFile(
    motionEvidencePath,
    JSON.stringify(
      {
        before: {
          location: before.location,
          missionTimeMs: before.missionTimeMs,
        },
        after: { location: after.location, missionTimeMs: after.missionTimeMs },
        changedPixelFraction,
        pageErrors,
        consoleErrors,
      },
      null,
      2,
    ),
  );
  await testInfo.attach("real-unity-motion-evidence", {
    path: motionEvidencePath,
    contentType: "application/json",
  });
  expect(changedPixelFraction).toBeGreaterThan(0.01);

  // The simulation reaches its first decision point after the real 30-second
  // drive. Time continues there, but the convoy and follow camera must settle
  // and stop until the player commits another route.
  await expect
    .poll(async () => (await projection()).location, { timeout: 35000 })
    .toEqual({ nodeId: "N01", routeId: null, progressPermille: 0 });
  const arrival = await projection();
  await expect
    .poll(async () => (await projection()).missionTimeMs)
    .toBeGreaterThan(arrival.missionTimeMs + 2000);
  const stoppedBefore = await projection();
  const stoppedBeforeFrame = await canvas.screenshot({
    path: testInfo.outputPath("unity-convoy-stopped-before.png"),
  });
  await expect
    .poll(async () => (await projection()).missionTimeMs)
    .toBeGreaterThan(stoppedBefore.missionTimeMs + 2000);
  const stoppedAfter = await projection();
  const stoppedAfterFrame = await canvas.screenshot({
    path: testInfo.outputPath("unity-convoy-stopped-after.png"),
  });
  const stoppedChangedPixelFraction = await compareFrames(
    stoppedBeforeFrame,
    stoppedAfterFrame,
  );
  const stopEvidencePath = testInfo.outputPath("unity-stop-evidence.json");
  await writeFile(
    stopEvidencePath,
    JSON.stringify(
      {
        before: {
          location: stoppedBefore.location,
          missionTimeMs: stoppedBefore.missionTimeMs,
        },
        after: {
          location: stoppedAfter.location,
          missionTimeMs: stoppedAfter.missionTimeMs,
        },
        changedPixelFraction: stoppedChangedPixelFraction,
      },
      null,
      2,
    ),
  );
  await testInfo.attach("real-unity-stop-evidence", {
    path: stopEvidencePath,
    contentType: "application/json",
  });
  expect(stoppedAfter.location).toEqual(stoppedBefore.location);
  expect(stoppedAfter.location).toEqual({
    nodeId: "N01",
    routeId: null,
    progressPermille: 0,
  });
  expect(stoppedChangedPixelFraction).toBeLessThan(0.005);
  await canvas.press("Home");
  await page.getByRole("button", { name: "Collapse map", exact: true }).click();

  // Use real keyboard events after focusing the Unity canvas, rather than fill(),
  // which would miss Unity accidentally capturing every page keystroke.
  await canvas.click({ position: { x: 20, y: 20 }, delay: 120 });
  const question = page.getByRole("textbox", {
    name: "Ask the AI advisor",
    exact: true,
  });
  await question.click();
  await question.pressSequentially("Check the available evidence.");
  await expect(question).toHaveValue("Check the available evidence.");
  await page.screenshot({
    path: testInfo.outputPath("unity-active-game.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "2D route map", exact: true }).click();
  await expect(page.locator("canvas.unity-canvas")).toHaveCount(0);
  await expect(page.locator(".map2d")).toBeVisible();
  expect(await originalCanvas!.evaluate((element) => element.isConnected)).toBe(
    false,
  );

  await testInfo.attach("real-unity-console-errors", {
    body: JSON.stringify(consoleErrors, null, 2),
    contentType: "application/json",
  });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
