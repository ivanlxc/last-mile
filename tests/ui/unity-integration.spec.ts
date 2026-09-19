import { expect, test, type Page } from "@playwright/test";

// These are browser-only protocol fixtures, not a Unity engine or generated build.
// Never write this mock loader into client/public or ship it with the application.
interface FixtureState {
  createCount: number;
  quitCount: number;
  configured: string[];
  states: Array<{
    instanceId: string;
    sessionId: string;
    lifecycle: string;
    phase: string;
    selectedNodeId: string | null;
    viewSequence: number;
  }>;
  canvas: HTMLCanvasElement | null;
  releaseReady(): void;
  emit(message: Record<string, unknown>): void;
}
interface FixtureWindow extends Window {
  __unityFixture: FixtureState;
}
const manifest = {
  schemaVersion: 1,
  loaderUrl: "/unity/TestOnly/fixture.loader.js",
  dataUrl: "/unity/TestOnly/fixture.data",
  frameworkUrl: "/unity/TestOnly/fixture.framework.js",
  codeUrl: "/unity/TestOnly/fixture.wasm",
  companyName: "Browser test fixture",
  productName: "Protocol fixture — not Unity",
  productVersion: "test-only",
};

async function installProtocolFixture(page: Page, autoReady = true) {
  await page.route("**/unity/manifest.json", (route) =>
    route.fulfill({ json: manifest }),
  );
  await page.route("**/unity/TestOnly/fixture.loader.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `(() => {
        let readyEnabled = ${autoReady};
        const fixture = window.__unityFixture = {
          createCount: 0, quitCount: 0, configured: [], states: [], canvas: null,
          emit(message) {
            window.dispatchEvent(new CustomEvent('last-mile-unity', { detail: {
              schemaVersion: 1, instanceId: fixture.configured.at(-1), ...message
            }}));
          },
          releaseReady() { readyEnabled = true; fixture.emit({ type: 'ready' }); }
        };
        window.createUnityInstance = async (canvas, config, onProgress) => {
          fixture.createCount += 1;
          fixture.canvas = canvas;
          onProgress(0.8);
          return {
            SendMessage(objectName, methodName, value) {
              if (objectName !== 'LastMileBridge') throw Error('Unexpected bridge object');
              if (methodName === 'Configure') {
                fixture.configured.push(value);
                if (readyEnabled) fixture.emit({ type: 'ready' });
              } else if (methodName === 'ApplyRenderState') {
                fixture.states.push(JSON.parse(value));
              } else throw Error('Unexpected bridge method');
            },
            async Quit() { fixture.quitCount += 1; }
          };
        };
      })();`,
    }),
  );
}

async function enterBriefing(page: Page) {
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
  const created = await (await creation).json();
  await expect(
    page.getByRole("button", { name: "Start escort", exact: true }),
  ).toBeVisible();
  return created as { sessionId: string };
}

test("test-only Unity bridge gates start, survives briefing transition, and accepts only scoped public location events", async ({
  page,
}) => {
  await installProtocolFixture(page, false);
  const { sessionId } = await enterBriefing(page);
  await page.getByRole("button", { name: "Unity scene", exact: true }).click();
  await expect(page.locator('[data-unity-status="loading"]')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).__unityFixture?.configured
            .length ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  const start = page.getByRole("button", { name: "Start escort", exact: true });
  await expect(start).toBeDisabled();
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).__unityFixture.emit({
      type: "ready",
      instanceId: "stale-runtime-test-only",
    });
  });
  await expect(start).toBeDisabled();
  const briefing = await page.request.get(`/api/v1/sessions/${sessionId}`);
  expect(briefing.ok()).toBe(true);
  expect(await briefing.json()).toMatchObject({
    lifecycle: "created",
    phase: "briefing",
    missionTimeMs: 0,
  });

  await page.evaluate(() =>
    (window as unknown as FixtureWindow).__unityFixture.releaseReady(),
  );
  await expect(page.locator('[data-unity-status="ready"]')).toBeVisible();
  await expect(start).toBeEnabled();
  expect(
    await page.evaluate(() =>
      Boolean(
        (window as unknown as FixtureWindow).__unityFixture.canvas?.isConnected,
      ),
    ),
  ).toBe(true);
  const before = await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).__unityFixture;
    return {
      createCount: fixture.createCount,
      quitCount: fixture.quitCount,
      instanceId: fixture.configured.at(-1),
    };
  });
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/start"),
  );
  await start.click();
  expect((await started).status()).toBe(200);
  await expect(page.locator(".map-first-command")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).__unityFixture.states.at(-1)
            ?.lifecycle,
      ),
    )
    .toBe("active");
  const after = await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).__unityFixture;
    return {
      createCount: fixture.createCount,
      quitCount: fixture.quitCount,
      instanceId: fixture.configured.at(-1),
      sameCanvas: document.querySelector(".unity-canvas") === fixture.canvas,
      connectedCanvas: fixture.canvas?.isConnected,
    };
  });
  expect(after).toEqual({ ...before, sameCanvas: true, connectedCanvas: true });

  await page.evaluate(() => {
    (window as unknown as FixtureWindow).__unityFixture.emit({
      type: "select-location",
      nodeId: "N01",
    });
  });
  await expect(page.locator(".map-selection")).toContainText("West gate");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as FixtureWindow).__unityFixture.states.at(-1)
            ?.selectedNodeId,
      ),
    )
    .toBe("N01");
  await page.getByTestId("open-advisor").click();
  await expect(page.getByTestId("advisor-drawer")).toBeVisible();
  await page
    .getByRole("button", { name: "Close AI advisor", exact: true })
    .click();
  await page.getByRole("button", { name: "2D route map", exact: true }).click();
  await expect(page.locator(".unity-canvas")).toBeHidden();
  await page.evaluate(() =>
    (window as unknown as FixtureWindow).__unityFixture.emit({
      type: "select-location",
      nodeId: "N02",
    }),
  );
  await expect(page.locator(".map-selection")).toContainText("West gate");
  await page.getByRole("button", { name: "Unity scene", exact: true }).click();
  await expect(page.locator(".unity-canvas")).toBeVisible();
  expect(
    await page.evaluate(() => {
      const f = (window as unknown as FixtureWindow).__unityFixture;
      return {
        createCount: f.createCount,
        quitCount: f.quitCount,
        instanceId: f.configured.at(-1),
      };
    }),
  ).toEqual(before);
  await page.evaluate(() => {
    const fixture = (window as unknown as FixtureWindow).__unityFixture;
    fixture.emit({ type: "select-location", nodeId: "private-node-test-only" });
    fixture.emit({
      type: "select-location",
      nodeId: "N02",
      instanceId: "stale-runtime-test-only",
    });
  });
  await expect(page.locator(".map-selection")).toContainText("West gate");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as FixtureWindow).__unityFixture.states.at(-1)
          ?.selectedNodeId,
    ),
  ).toBe("N01");
});

test("a reported Unity failure releases the engine and keeps escort available through the existing map", async ({
  page,
}) => {
  await installProtocolFixture(page);
  await enterBriefing(page);
  await page.getByRole("button", { name: "Unity scene", exact: true }).click();
  await expect(page.locator('[data-unity-status="ready"]')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as FixtureWindow).__unityFixture.emit({
      type: "error",
      message: "Test-only engine failure",
    });
  });
  await expect(page.locator(".unity-canvas")).toHaveCount(0);
  await expect(page.locator(".map-engine-status.error")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as FixtureWindow).__unityFixture.quitCount,
      ),
    )
    .toBe(1);
  await page.getByRole("button", { name: "2D route map", exact: true }).click();
  await expect(page.locator(".map2d")).toBeVisible();
  const start = page.getByRole("button", { name: "Start escort", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.locator(".map-first-command")).toBeVisible();
});

test("an absent Unity build explains setup and does not block starting a mission", async ({
  page,
}) => {
  // Explicit 404 keeps this test valid even on a developer machine with a build.
  await page.route("**/unity/manifest.json", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/problem+json",
      body: JSON.stringify({ code: "RESOURCE_NOT_FOUND", status: 404 }),
    }),
  );
  await page.addInitScript(() =>
    localStorage.setItem("last-mile-map-renderer-v1", "unity"),
  );
  await enterBriefing(page);
  const setup = page.getByRole("button", { name: "Unity setup", exact: true });
  await expect(setup).toBeVisible();
  await expect(page.locator(".unity-canvas")).toHaveCount(0);
  await setup.click();
  await expect(page.getByRole("dialog")).toContainText("Unity");
  await expect(page.getByRole("dialog")).toContainText("pnpm build:unity");
  await expect(page.getByRole("dialog")).toContainText("unity/LastMile");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const start = page.getByRole("button", { name: "Start escort", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.locator(".map-first-command")).toBeVisible();
});
