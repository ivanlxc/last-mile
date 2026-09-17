import { test, expect } from "@playwright/test";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";
import { createStore } from "../../server/core/store.js";
import { createGameService } from "../../server/core/service.js";
import { createAiService } from "../../server/ai/index.js";

// Real sockets are required: Playwright request interception can omit browser
// Fetch Metadata headers. Loopback HTTP is a trustworthy browser context; this
// regression covers public navigation only, not production TLS or login cookies.
test("a cross-site link reaches the public invitation page with actual browser fetch metadata", async ({
  page,
}) => {
  const config = loadHttpConfig({
    LAST_MILE_ROOT: process.cwd(),
    LAST_MILE_MODE: "cloud",
    DATABASE_URL: "postgres://unused.invalid/test",
    LAST_MILE_PUBLIC_ORIGIN: "https://last-mile.test",
    LAST_MILE_INVITE_CODE: "navigation-test-invite",
    LAST_MILE_COOKIE_SECRET: "navigation-test-secret".repeat(3),
  });
  const hosts = new Set<string>();
  const origins = new Set<string>();
  config.allowedHosts = hosts;
  config.allowedOrigins = origins;
  const store = await createStore({ dbPath: ":memory:" });
  const service = await createGameService({
    store,
    cloud: config.limits,
    agents: createAiService({ env: {} }),
    autoTick: false,
  });
  const app = await createHttpApp({ store, service, config });
  const navigation: IncomingHttpHeaders[] = [];
  app.server.on("request", (request) => {
    if (request.url === "/") navigation.push(request.headers);
  });
  let target = "";
  const source = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><a href="${target}">Open LAST MILE</a>`);
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const targetHost = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    hosts.add(targetHost);
    target = `http://${targetHost}/`;
    origins.add(new URL(target).origin);
    await new Promise<void>((resolve, reject) => {
      source.once("error", reject);
      source.listen(0, "127.0.0.1", resolve);
    });
    const sourceUrl = `http://localhost:${(source.address() as AddressInfo).port}/`;
    await page.goto(sourceUrl);
    await page.getByRole("link", { name: "Open LAST MILE" }).click();
    await expect(page).toHaveURL(target);
    await expect(
      page.getByLabel("Invitation code", { exact: true }),
    ).toBeVisible();
    expect(navigation).toHaveLength(1);
    expect(navigation[0]).toMatchObject({
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    });
    expect(await store.all("SELECT * FROM cloud_players")).toHaveLength(0);
  } finally {
    await page.close();
    if (source.listening) {
      source.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        source.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await app.close();
    await service.close();
  }
});
