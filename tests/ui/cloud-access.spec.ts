import {
  test,
  expect,
  type BrowserContext,
  type Route,
} from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";
import { createStore } from "../../server/core/store.js";
import { createGameService } from "../../server/core/service.js";
import { createAiService } from "../../server/ai/index.js";

/** Browser UI + real Fastify injection. HTTPS is intercepted locally, not a platform/TLS acceptance test. */
test("bilingual invitation, secure visitor cookie and owned mission history", async ({
  browser,
}) => {
  const origin = "https://last-mile.test";
  const invite = "browser-test-invitation";
  const config = loadHttpConfig({
    LAST_MILE_ROOT: process.cwd(),
    LAST_MILE_MODE: "cloud",
    DATABASE_URL: "postgres://example.invalid/test",
    LAST_MILE_PUBLIC_ORIGIN: origin,
    LAST_MILE_INVITE_CODE: invite,
    LAST_MILE_COOKIE_SECRET: "browser-cookie-signing".repeat(3),
  });
  const store = await createStore({ dbPath: ":memory:" });
  const service = await createGameService({
    store,
    cloud: config.limits,
    agents: createAiService({ env: {} }),
    autoTick: false,
  });
  const app = await createHttpApp({ store, service, config });
  const contexts: BrowserContext[] = [];
  mkdirSync(".local-artifacts/cloud-ui", { recursive: true });
  async function context(viewport = { width: 1440, height: 1000 }) {
    const ctx = await browser.newContext({ viewport });
    contexts.push(ctx);
    await ctx.route(origin + "/**", async (route: Route) => {
      const request = route.request(),
        url = new URL(request.url());
      // This test covers invitation/history UI. SSE reconnection and authorization have HTTP tests.
      if (url.pathname.endsWith("/events")) {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: "retry: 60000\n\n",
        });
        return;
      }
      const response = await app.inject({
        method: request.method() as "GET" | "POST",
        url: url.pathname + url.search,
        headers: { ...request.headers(), host: url.host },
        ...(request.postData() ? { payload: request.postData()! } : {}),
      });
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers))
        if (
          value !== undefined &&
          key !== "content-length" &&
          key !== "transfer-encoding"
        )
          headers[key] = Array.isArray(value)
            ? value.join("\n")
            : String(value);
      await route.fulfill({
        status: response.statusCode,
        headers,
        body: response.rawPayload,
      });
    });
    return ctx;
  }
  try {
    const a = await context(),
      page = await a.newPage();
    await page.goto(origin);
    await expect(
      page.getByLabel("Invitation code", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "中文", exact: true }).click();
    await expect(page.getByLabel("邀请口令", { exact: true })).toBeVisible();
    await page.screenshot({
      path: ".local-artifacts/cloud-ui/01-invitation-zh.png",
      animations: "disabled",
      fullPage: true,
    });
    await page.getByRole("button", { name: "English", exact: true }).click();
    await page
      .getByLabel("Invitation code", { exact: true })
      .fill("wrong-code");
    await page
      .getByRole("button", { name: "Enter playtest", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("not accepted");
    await page.getByLabel("Invitation code", { exact: true }).fill(invite);
    await page
      .getByRole("button", { name: "Enter playtest", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Enter mission briefing" }),
    ).toBeEnabled();
    const credential = (await a.cookies()).find(
      (c) => c.name === config.cookieName,
    )!;
    expect(credential.secure).toBe(true);
    expect(credential.httpOnly).toBe(true);
    expect(credential.sameSite).toBe("Strict");
    await page.getByRole("button", { name: "Enter mission briefing" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("last-mile-session-v1")),
      )
      .not.toBeNull();
    const sid = (await page.evaluate(() =>
      localStorage.getItem("last-mile-session-v1"),
    ))!;
    const closed = await page.evaluate(async (sessionId) => {
      const current = await (
        await fetch(`/api/v1/sessions/${sessionId}`)
      ).json();
      const response = await fetch(`/api/v1/sessions/${sessionId}/abandon`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          "X-Run-Epoch": current.runEpoch,
        },
        body: JSON.stringify({
          expectedStateVersion: current.stateVersion,
          expectedSceneId: current.sceneId,
          payload: { reason: "player_exit" },
        }),
      });
      return response.status;
    }, sid);
    expect(closed).toBe(200);
    await page.evaluate(() => localStorage.removeItem("last-mile-session-v1"));
    await page.goto(origin);
    await page
      .getByRole("button", { name: "My missions", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: /Review mission/ }),
    ).toBeVisible();
    await page.screenshot({
      path: ".local-artifacts/cloud-ui/02-owned-history.png",
      animations: "disabled",
      fullPage: true,
    });
    await page.getByRole("link", { name: /Review mission/ }).click();
    await expect(
      page.getByRole("button", { name: "Export full review", exact: true }),
    ).toBeVisible();

    const b = await context({ width: 390, height: 844 }),
      other = await b.newPage();
    await other.goto(origin);
    await expect(
      other.getByLabel("Invitation code", { exact: true }),
    ).toBeVisible();
    expect(
      await other.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await other.screenshot({
      path: ".local-artifacts/cloud-ui/03-invitation-mobile-en.png",
      animations: "disabled",
      fullPage: true,
    });
    await other.getByLabel("Invitation code", { exact: true }).fill(invite);
    await other
      .getByRole("button", { name: "Enter playtest", exact: true })
      .click();
    await other
      .getByRole("button", { name: "My missions", exact: true })
      .click();
    await expect(
      other.getByText("No missions yet.", { exact: true }),
    ).toBeVisible();
    const denied = await other.evaluate(
      async (id) => (await fetch(`/api/v1/sessions/${id}`)).status,
      sid,
    );
    expect(denied).toBe(404);
    expect(
      (await b.cookies()).find((c) => c.name === config.cookieName)!.value,
    ).not.toBe(credential.value);
  } finally {
    for (const ctx of contexts) await ctx.close();
    await app.close();
    await service.close();
  }
});
