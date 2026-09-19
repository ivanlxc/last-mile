import { test as base, expect, type Page } from "@playwright/test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import WebSocket from "ws";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";
import { loadSpeechConfig } from "../../server/http/speech.js";
import { createGameService } from "../../server/core/service.js";
import { createAiService } from "../../server/ai/index.js";

const origin = "http://127.0.0.1:33130";
const firstSentence = "Which report is reliable?";
const lastSentence = "Compare the sources.";

/** Test fiction only: this provider never contacts Deepgram or transcribes a person. */
class FictionalSpeechProvider extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  frames: Buffer[] = [];
  closed = false;
  flushed = false;
  constructor() {
    super();
    queueMicrotask(() => {
      if (this.closed) return;
      this.readyState = WebSocket.OPEN;
      this.emit("open");
    });
  }
  private result(text: string, final: boolean, start: number) {
    this.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "Results",
          channel: { alternatives: [{ transcript: text }] },
          is_final: final,
          speech_final: final,
          start,
          duration: 1,
        }),
      ),
      false,
    );
  }
  send(data: string | Buffer) {
    if (Buffer.isBuffer(data)) {
      this.frames.push(data);
      if (this.frames.length === 1) this.result("Which report", false, 0);
      if (this.frames.length === 3) {
        this.result(firstSentence, true, 0);
        this.result("Compare", false, 1);
      }
    } else if (JSON.parse(data).type === "CloseStream") {
      this.flushed = true;
      // Deliver the last phrase after Stop, exercising the browser's drain phase.
      setTimeout(() => {
        if (this.closed) return;
        this.result(lastSentence, true, 1);
        this.closed = true;
        this.readyState = WebSocket.CLOSED;
        this.emit("close", 1000);
      }, 25);
    }
  }
  terminate() {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006);
  }
}

type Harness = {
  providers: FictionalSpeechProvider[];
  disable(): void;
};
const test = base.extend<{ speechHarness: Harness }>({
  speechHarness: async ({}, use) => {
    const config = loadHttpConfig({
      LAST_MILE_ROOT: process.cwd(),
      PORT: "33130",
    });
    const speech = loadSpeechConfig({
      DEEPGRAM_API_KEY: "fictional-ui-test-key",
    });
    const service = await createGameService({
      dbPath: ":memory:",
      autoTick: false,
      recoverOnStartup: false,
      clock: {
        nowMs: () => Date.UTC(2026, 8, 19),
        monotonicMs: () => 0,
      },
      agents: createAiService({ env: {} }),
      selectCase: () => "A",
    });
    const providers: FictionalSpeechProvider[] = [];
    const app = await createHttpApp({
      service,
      config,
      closeServiceOnClose: true,
      speech: {
        config: speech,
        connect: () => {
          const provider = new FictionalSpeechProvider();
          providers.push(provider);
          return provider as unknown as WebSocket;
        },
        fetch: async () => {
          throw new Error("TTS is outside this synthetic STT fixture");
        },
      },
    });
    await app.listen({ host: "127.0.0.1", port: 33130 });
    try {
      await use({
        providers,
        disable: () => {
          speech.enabled = false;
        },
      });
    } finally {
      await app.close();
    }
  },
});

test.use({
  baseURL: origin,
  launchOptions: {
    executablePath:
      process.env.PLAYWRIGHT_CHROME_PATH ??
      (existsSync(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      )
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
    // Generated Chromium media only. No physical microphone or camera is accessed.
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

type MicMetrics = {
  calls: number;
  denyNext: boolean;
  streams: MediaStream[];
  modules: string[];
};
async function installMicMetrics(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("last-mile-map-renderer-v1", "two");
    const metrics = {
      calls: 0,
      denyNext: false,
      streams: [] as MediaStream[],
      modules: [] as string[],
    };
    Object.defineProperty(window, "__syntheticSpeechMic", { value: metrics });
    const addModule = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (url, options) {
      metrics.modules.push(String(url));
      return addModule.call(this, url, options);
    };
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      metrics.calls++;
      if (metrics.denyNext) {
        metrics.denyNext = false;
        throw new DOMException(
          "Synthetic permission denial",
          "NotAllowedError",
        );
      }
      const stream = await original(constraints);
      metrics.streams.push(stream);
      return stream;
    };
  });
}
async function microphoneMetrics(page: Page) {
  return page.evaluate(() => {
    const metrics = (window as unknown as { __syntheticSpeechMic: MicMetrics })
      .__syntheticSpeechMic;
    return {
      calls: metrics.calls,
      live: metrics.streams
        .flatMap((stream) => stream.getTracks())
        .filter((track) => track.readyState === "live").length,
    };
  });
}
async function enterAdvisor(page: Page) {
  await installMicMetrics(page);
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
  await creation;
  await page.getByRole("button", { name: "Start escort", exact: true }).click();
  await page.getByTestId("open-advisor").click();
  const advisor = page.getByTestId("advisor-drawer");
  await expect(advisor).toBeVisible();
  await expect(page.locator(".route-choice").first()).toBeEnabled();
  return {
    advisor,
    draft: advisor.getByRole("textbox", {
      name: "Ask the AI advisor",
      exact: true,
    }),
    voice: advisor.getByRole("button", { name: "Voice input", exact: true }),
    send: advisor.getByRole("button", { name: "Send to AI", exact: true }),
  };
}

test("real AudioWorklet PCM becomes a reviewed draft; only explicit Send posts a question", async ({
  page,
  speechHarness,
}, info) => {
  const errors: string[] = [];
  const questions: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/questions")
    )
      questions.push(request.postData() ?? "");
  });
  const { advisor, draft, voice, send } = await enterAdvisor(page);
  expect(await microphoneMetrics(page)).toEqual({ calls: 0, live: 0 });
  await page.getByTestId("sound-settings").click();
  await expect(
    page.getByRole("button", { name: "Mute sound", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("sound-settings").click();
  expect(await microphoneMetrics(page)).toEqual({ calls: 0, live: 0 });
  await draft.fill("My question: ");
  await expect(voice).toBeEnabled();
  await voice.click();
  await expect(advisor.locator(".voice-live")).toContainText(firstSentence);
  await expect(advisor.locator(".voice-live em")).toHaveText("Compare");
  await expect(draft).toHaveValue("My question: ");
  await expect(send).toBeDisabled();
  expect(questions).toHaveLength(0);
  expect(await microphoneMetrics(page)).toEqual({ calls: 1, live: 1 });
  await expect(page.locator(".sound-control")).toHaveAttribute(
    "data-ducked",
    "true",
  );
  await advisor
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(draft).toHaveValue(
    `My question: ${firstSentence} ${lastSentence}`,
  );
  await expect(send).toBeEnabled();
  expect(await microphoneMetrics(page)).toEqual({ calls: 1, live: 0 });
  await expect(page.locator(".sound-control")).toHaveAttribute(
    "data-ducked",
    "false",
  );
  await page.getByTestId("sound-settings").click();
  await page.getByRole("button", { name: "Mute sound", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enable sound", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("sound-settings").click();
  expect(questions).toHaveLength(0);
  expect(speechHarness.providers[0].flushed).toBe(true);
  expect(speechHarness.providers[0].frames.length).toBeGreaterThanOrEqual(3);
  expect(speechHarness.providers[0].frames[0].length).toBe(3200);
  expect(
    speechHarness.providers[0].frames.every(
      (frame) => frame.length % 2 === 0 && frame.length <= 3200,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __syntheticSpeechMic: MicMetrics })
          .__syntheticSpeechMic.modules,
    ),
  ).toEqual(["/audio/capture.worklet.js"]);
  await page.screenshot({
    path: info.outputPath("reviewed-voice-draft.png"),
    fullPage: true,
  });
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/questions"),
  );
  await send.click();
  expect((await posted).status()).toBe(202);
  expect(questions).toHaveLength(1);
  expect(JSON.parse(questions[0]).payload.text).toBe(
    `My question: ${firstSentence} ${lastSentence}`,
  );
  expect(errors).toEqual([]);
});

test("closing the advisor stops synthetic microphone capture, drains finals, and preserves the draft", async ({
  page,
  speechHarness,
}) => {
  let questions = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/questions")
    )
      questions++;
  });
  const { advisor, draft, voice } = await enterAdvisor(page);
  await voice.click();
  await expect(advisor.locator(".voice-live")).toContainText(firstSentence);
  await page
    .getByRole("button", { name: "Close AI advisor", exact: true })
    .click();
  await expect(advisor).toBeHidden();
  await expect.poll(async () => (await microphoneMetrics(page)).live).toBe(0);
  await expect.poll(() => speechHarness.providers[0].closed).toBe(true);
  await page.getByTestId("open-advisor").click();
  await expect(draft).toHaveValue(`${firstSentence} ${lastSentence}`);
  await expect(voice).toBeEnabled();
  expect(questions).toBe(0);
});

test("a denied permission leaves typing usable and a second synthetic microphone attempt succeeds", async ({
  page,
  speechHarness,
}) => {
  const { advisor, draft, voice, send } = await enterAdvisor(page);
  await page.evaluate(() => {
    (
      window as unknown as { __syntheticSpeechMic: MicMetrics }
    ).__syntheticSpeechMic.denyNext = true;
  });
  await voice.click();
  await expect(
    advisor.locator(".advisor-composer").getByRole("status"),
  ).toContainText("Microphone access was not allowed");
  expect(await microphoneMetrics(page)).toEqual({ calls: 1, live: 0 });
  expect(speechHarness.providers).toHaveLength(0);
  await draft.fill("A typed question still works.");
  await expect(send).toBeEnabled();
  await voice.click();
  await expect(advisor.locator(".voice-live")).toContainText(firstSentence);
  await advisor
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(draft).toHaveValue(
    `A typed question still works. ${firstSentence} ${lastSentence}`,
  );
  expect(await microphoneMetrics(page)).toEqual({ calls: 2, live: 0 });
});

test("an unconfigured speech service keeps text questions available without requesting microphone permission", async ({
  page,
  speechHarness,
}) => {
  speechHarness.disable();
  const { advisor, draft, voice, send } = await enterAdvisor(page);
  await expect(voice).toBeDisabled();
  await expect(advisor).toContainText(
    "Voice is not configured. You can still type.",
  );
  await draft.fill("Check which sources are missing.");
  await expect(send).toBeEnabled();
  expect(await microphoneMetrics(page)).toEqual({ calls: 0, live: 0 });
  expect(speechHarness.providers).toHaveLength(0);
});

test("reopening the advisor recovers a temporary speech configuration failure without reloading the game", async ({
  page,
  speechHarness,
}) => {
  let unavailable = true;
  let attempts = 0;
  await page.route(`${origin}/api/v1/speech/config`, async (route) => {
    attempts++;
    if (unavailable)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "Synthetic temporary outage" },
        }),
      });
    else await route.continue();
  });
  const { advisor, voice, draft } = await enterAdvisor(page);
  await expect(
    advisor.locator(".advisor-composer").getByRole("status"),
  ).toContainText("Voice is unavailable");
  await expect(voice).toBeDisabled();
  await draft.fill("Keep this draft through reconnection.");
  expect(attempts).toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Close AI advisor", exact: true })
    .click();
  unavailable = false;
  await page.getByTestId("open-advisor").click();
  await expect(voice).toBeEnabled();
  await expect(draft).toHaveValue("Keep this draft through reconnection.");
  expect(attempts).toBeGreaterThan(1);
  expect(await microphoneMetrics(page)).toEqual({ calls: 0, live: 0 });
});
