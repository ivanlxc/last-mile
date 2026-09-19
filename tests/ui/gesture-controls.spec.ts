import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";

// Chrome's generated test pattern is a synthetic camera, never a real device.
test.use({
  launchOptions: {
    executablePath:
      process.env.PLAYWRIGHT_CHROME_PATH ??
      (existsSync(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      )
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

async function openUnity(page: Page) {
  test.skip(
    !existsSync("client/public/unity/manifest.json"),
    "Run pnpm build:unity first.",
  );
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    const streams: MediaStream[] = [];
    const metrics = { calls: 0, streams };
    Object.defineProperty(window, "__cameraTest", { value: metrics });
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      metrics.calls++;
      const stream = await original(constraints);
      streams.push(stream);
      return stream;
    };
  });
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
  await page.getByRole("button", { name: "Unity scene", exact: true }).click();
  await expect(page.locator('[data-unity-status="ready"]')).toBeVisible({
    timeout: 100000,
  });
  return sessionId as string;
}
async function cameraMetrics(page: Page) {
  return page.evaluate(() => {
    const m = (
      window as unknown as {
        __cameraTest: { calls: number; streams: MediaStream[] };
      }
    ).__cameraTest;
    return {
      calls: m.calls,
      live: m.streams
        .flatMap((s) => s.getTracks())
        .filter((t) => t.readyState === "live").length,
    };
  });
}
async function mapDifference(page: Page, before: Buffer, after: Buffer) {
  // An element screenshot includes the DOM camera preview above its rectangle.
  // Compare only terrain, excluding that panel and the Unity HUD.
  return page.evaluate(
    async ({ before, after }) => {
      async function pixels(encoded: string) {
        const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(
          new Blob([bytes], { type: "image/png" }),
        );
        const target = document.createElement("canvas");
        target.width = bitmap.width;
        target.height = bitmap.height;
        const context = target.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return context.getImageData(
          40,
          60,
          target.width - 380,
          target.height - 130,
        ).data;
      }
      const a = await pixels(before),
        b = await pixels(after);
      if (a.length !== b.length)
        throw Error("Viewport changed during camera comparison");
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
    { before: before.toString("base64"), after: after.toString("base64") },
  );
}

test("real MediaPipe Worker and real Unity coexist; camera stays opt-in and is released on Escape and map switch", async ({
  page,
}, info) => {
  test.setTimeout(150000);
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
  await openUnity(page);
  expect(await cameraMetrics(page)).toEqual({ calls: 0, live: 0 });
  await page
    .getByRole("button", { name: "Gestures · try it", exact: true })
    .click();
  expect(await cameraMetrics(page)).toEqual({ calls: 0, live: 0 });
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  await expect(page.locator(".gesture-controls")).toHaveAttribute(
    "data-gesture-state",
    "running",
    { timeout: 35000 },
  );
  await expect(page.locator(".gesture-metrics")).toContainText(/[1-9]\d* Hz/, {
    timeout: 10000,
  });
  expect(await cameraMetrics(page)).toEqual({ calls: 1, live: 1 });
  await page.screenshot({
    path: info.outputPath("gesture-real-model.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Start escort", exact: true }).click();
  await expect(page.locator(".gesture-controls")).toHaveAttribute(
    "data-gesture-state",
    "running",
  );
  const clock = await page.locator(".mission-clock strong").innerText();
  await expect(page.locator(".mission-clock strong")).not.toHaveText(clock);
  await page.keyboard.press("Escape");
  await expect(page.locator(".gesture-controls")).toHaveAttribute(
    "data-gesture-state",
    "idle",
  );
  expect(await cameraMetrics(page)).toEqual({ calls: 1, live: 0 });
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  await expect(page.locator(".gesture-controls")).toHaveAttribute(
    "data-gesture-state",
    "running",
    { timeout: 35000 },
  );
  await page.getByRole("button", { name: "2D route map", exact: true }).click();
  await expect(page.locator(".gesture-controls")).toHaveCount(0);
  expect(await cameraMetrics(page)).toEqual({ calls: 2, live: 0 });
  expect(errors).toEqual([]);
  expect(
    requests.filter(
      (url) => /^https?:/.test(url) && new URL(url).hostname !== "127.0.0.1",
    ),
  ).toEqual([]);
  expect(
    requests.some((url) => url.includes("hand_landmarker-float16-v1.task")),
  ).toBe(true);
  expect(
    requests.some((url) => url.includes("vision_wasm_module_internal.wasm")),
  ).toBe(true);
});

test("camera denial is recoverable and does not disable Unity or starting the escort", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Test-only denied camera", "NotAllowedError");
    };
  });
  await openUnity(page);
  await page
    .getByRole("button", { name: "Gestures · try it", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  await expect(page.locator(".gesture-error")).toContainText(
    "Camera permission was not granted",
  );
  await expect(page.locator(".gesture-controls")).toHaveAttribute(
    "data-gesture-state",
    "idle",
  );
  await expect(page.locator('[data-unity-status="ready"]')).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start escort", exact: true }),
  ).toBeEnabled();
  expect(await cameraMetrics(page)).toEqual({ calls: 1, live: 0 });
  expect(errors).toEqual([]);
});

test("single-hand landmarks switch modes and drive actual Unity pan, orbit and zoom", async ({
  page,
}, info) => {
  // Only the recognizer output is synthetic. Interpreter, camera bridge and
  // rendered Unity are real; this does not measure recognition on a live hand.
  function hand(x = 0.5, y = 0.5, pinched = false) {
    const p = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
    p[0].y = y + 0.15;
    p[9].y = y - 0.05;
    p[5].y = y - 0.04;
    p[13].y = y - 0.03;
    p[4] = { x: x - 0.02, y: y - 0.15, z: 0 };
    p[8] = { x: x + (pinched ? -0.005 : 0.12), y: y - 0.15, z: 0 };
    return { landmarks: p };
  }
  function victory() {
    const xy = [
      [0.5, 0.75],
      [0.43, 0.69],
      [0.38, 0.64],
      [0.35, 0.61],
      [0.33, 0.58],
      [0.43, 0.58],
      [0.4, 0.4],
      [0.39, 0.3],
      [0.38, 0.2],
      [0.5, 0.56],
      [0.52, 0.38],
      [0.53, 0.27],
      [0.54, 0.17],
      [0.57, 0.58],
      [0.6, 0.48],
      [0.59, 0.57],
      [0.56, 0.65],
      [0.64, 0.64],
      [0.68, 0.55],
      [0.67, 0.64],
      [0.62, 0.69],
    ];
    return { landmarks: xy.map(([x, y]) => ({ x, y, z: 0 })) };
  }
  await page.route("**/handLandmarker.worker.ts?*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
      const channel=new BroadcastChannel('last-mile-test-gesture');
      let hands=${JSON.stringify([hand()])};
      channel.onmessage=event=>hands=event.data;
      onmessage=({data:r})=>{
        if(r.type==='initialize') return postMessage({type:'ready'});
        r.bitmap.close();
        postMessage({type:'frame',frameId:r.frameId,frame:{hands,timestampMs:r.timestampMs,aspect:r.aspect,inferenceMs:1}});
      };`,
    }),
  );
  const sessionId = await openUnity(page);
  await page
    .getByRole("button", { name: "Gestures · try it", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  const controls = page.locator(".gesture-controls");
  const status = page.locator(".gesture-status");
  await expect(controls).toHaveAttribute("data-gesture-state", "running");
  await expect(status).toHaveAttribute("data-gesture-mode", "idle");
  const fixture = (hands: ReturnType<typeof hand>[]) =>
    page.evaluate((data) => {
      const channel = new BroadcastChannel("last-mile-test-gesture");
      channel.postMessage(data);
      channel.close();
    }, hands);
  const canvas = page.locator("canvas.unity-canvas");
  const before = await canvas.screenshot({
    path: info.outputPath("gesture-before.png"),
  });
  await fixture([hand(0.5, 0.5, true)]);
  await expect(status).toHaveAttribute("data-gesture-mode", "pan");
  for (let i = 1; i <= 8; i++) {
    await fixture([hand(0.5 - i * 0.015, 0.5, true)]);
    await page.waitForTimeout(90);
  }
  const pan = await canvas.screenshot({
    path: info.outputPath("gesture-pan.png"),
  });
  const panChange = await mapDifference(page, before, pan);
  expect(panChange).toBeGreaterThan(0.01);

  // Both mode transitions are completed with one V hand, without clicking UI.
  await fixture([hand()]);
  await expect(status).toHaveAttribute("data-gesture-mode", "idle");
  await fixture([victory()]);
  await expect(controls).toHaveAttribute("data-control-mode", "orbit");
  await expect(
    page.getByRole("button", { name: "Rotate", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(1600);
  await expect(controls).toHaveAttribute("data-control-mode", "orbit");
  await fixture([hand()]);
  await expect(status).toHaveAttribute("data-gesture-mode", "idle");
  await fixture([hand(0.5, 0.5, true)]);
  await expect(status).toHaveAttribute("data-gesture-mode", "orbit");
  for (let i = 1; i <= 8; i++) {
    await fixture([hand(0.5 - i * 0.015, 0.5 - i * 0.008, true)]);
    await page.waitForTimeout(90);
  }
  const orbit = await canvas.screenshot({
    path: info.outputPath("gesture-orbit.png"),
  });
  const orbitChange = await mapDifference(page, pan, orbit);
  expect(orbitChange).toBeGreaterThan(0.01);

  await fixture([hand()]);
  await expect(status).toHaveAttribute("data-gesture-mode", "idle");
  await fixture([victory()]);
  await expect(controls).toHaveAttribute("data-control-mode", "zoom");
  await fixture([hand()]);
  await expect(status).toHaveAttribute("data-gesture-mode", "idle");
  await fixture([hand(0.5, 0.5, true)]);
  await expect(status).toHaveAttribute("data-gesture-mode", "zoom");
  for (let i = 1; i <= 8; i++) {
    await fixture([hand(0.5, 0.5 - i * 0.02, true)]);
    await page.waitForTimeout(90);
  }
  const zoom = await canvas.screenshot({
    path: info.outputPath("gesture-zoom.png"),
  });
  const zoomChange = await mapDifference(page, orbit, zoom);
  expect(zoomChange).toBeGreaterThan(0.01);

  // Two hands can never become a control gesture in this iteration.
  await fixture([hand(0.35, 0.34, true), hand(0.65, 0.34, true)]);
  await expect(status).toContainText("Show only one hand");
  await expect(status).toHaveAttribute("data-gesture-mode", "release");
  await page.waitForTimeout(250);
  const stopped = await canvas.screenshot();
  await fixture([hand(0.5, 0.34, true)]);
  await page.waitForTimeout(500);
  await expect(status).toHaveAttribute("data-gesture-mode", "release");
  const stopChange = await mapDifference(
    page,
    stopped,
    await canvas.screenshot(),
  );
  expect(stopChange).toBeLessThan(0.001);
  await expect(controls).toHaveAttribute("data-control-mode", "zoom");

  // Buttons are a fallback and also require a fresh open-hand release.
  await page.getByRole("button", { name: "Pan", exact: true }).click();
  await page.waitForTimeout(850);
  await expect(controls).toHaveAttribute("data-control-mode", "pan");
  await expect(status).toHaveAttribute("data-gesture-mode", "release");
  expect(
    await mapDifference(page, stopped, await canvas.screenshot()),
  ).toBeLessThan(0.001);
  const projection = await (
    await page.request.get(`/api/v1/sessions/${sessionId}`)
  ).json();
  expect(projection).toMatchObject({
    lifecycle: "created",
    phase: "briefing",
    missionTimeMs: 0,
    location: { nodeId: "N00", routeId: null, progressPermille: 0 },
  });
  await info.attach("single-hand-input-evidence", {
    body: JSON.stringify(
      {
        kind: "synthetic single-hand landmarks with real Unity",
        missionTimeMs: projection.missionTimeMs,
        location: projection.location,
        panChange,
        orbitChange,
        zoomChange,
        stopChange,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});
