import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const macChrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath =
  process.env.PLAYWRIGHT_CHROME_PATH ??
  (existsSync(macChrome) ? macChrome : undefined);

export default defineConfig({
  testDir: "./tests/ui",
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  expect: { timeout: 10000 },
  reporter: [["list"]],
  outputDir: "test-results/ui",
  use: {
    baseURL: "http://127.0.0.1:5173",
    browserName: "chromium",
    launchOptions: { executablePath },
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    acceptDownloads: true,
  },
});
