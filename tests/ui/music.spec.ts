import { test as base, expect, type Page } from "@playwright/test";
import type { FastifyInstance } from "fastify";
import { createGameService } from "../../server/core/service.js";
import { createAiService } from "../../server/ai/index.js";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";
import type { SessionProjection } from "../../docs/engineering_v0.5/contracts/public.types.js";

const origin = "http://127.0.0.1:33132";
const settingsKey = "last-mile-audio-v1";
type Harness = {
  advancePlayerTime(milliseconds: number): void;
  projection(sessionId: string): Promise<SessionProjection>;
};

// The real built client and HTTP service run against an isolated, in-memory
// campaign. Routes resolve immediately without advancing the injected clock;
// browser audio time is real. One check advances actual player time independently.
const test = base.extend<{ musicGame: Harness }>({
  musicGame: async ({}, use) => {
    let elapsed = 0;
    const service = await createGameService({
      dbPath: ":memory:",
      recoverOnStartup: false,
      autoTick: false,
      selectCase: () => "A",
      clock: {
        nowMs: () => Date.UTC(2026, 8, 19) + elapsed,
        monotonicMs: () => elapsed,
      },
      agents: createAiService({ env: {} }),
    });
    let app: FastifyInstance | undefined;
    try {
      const config = loadHttpConfig({
        LAST_MILE_ROOT: process.cwd(),
        PORT: "33132",
      });
      app = await createHttpApp({ service, config, closeServiceOnClose: true });
      await app.listen({ host: "127.0.0.1", port: 33132 });
      await use({
        advancePlayerTime: (milliseconds) => {
          elapsed += milliseconds;
        },
        projection: async (sessionId) =>
          (await service.read("getSession", sessionId)) as SessionProjection,
      });
    } finally {
      if (app) await app.close();
      else await service.close();
    }
  },
});
test.use({ baseURL: origin });

type AudioMetrics = {
  starts: Array<{ duration: number; peak: number; when: number; now: number }>;
  microphoneCalls: number;
};

async function observeNativeMusic(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("last-mile-map-renderer-v1", "two");
    localStorage.setItem("last-mile-locale-v1", "en-US");
    const metrics: AudioMetrics = { starts: [], microphoneCalls: 0 };
    const gains: GainNode[] = [];
    Object.assign(window, {
      __musicMetrics: metrics,
      __observedMusicGains: gains,
    });
    const createGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () {
      const gain = createGain.call(this);
      gains.push(gain);
      return gain;
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (
      when = 0,
      offset = 0,
      duration?: number,
    ) {
      if (this.buffer && this.buffer.duration > 50) {
        // Inspect the actual decoded production MP3, without changing samples,
        // gain, device output, playback scheduling, or browser activation.
        const channel = this.buffer.getChannelData(0);
        let peak = 0;
        for (let index = 0; index < channel.length; index += 127)
          peak = Math.max(peak, Math.abs(channel[index]));
        metrics.starts.push({
          duration: this.buffer.duration,
          peak,
          when,
          now: this.context.currentTime,
        });
      }
      return duration === undefined
        ? start.call(this, when, offset)
        : start.call(this, when, offset, duration);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      metrics.microphoneCalls++;
      throw new Error("Music never needs microphone permission");
    };
  });
}

async function audioMetrics(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __musicMetrics: AudioMetrics }).__musicMetrics,
  );
}

async function enterBriefing(page: Page) {
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/sessions",
  );
  await page
    .getByRole("button", { name: "Enter mission briefing", exact: true })
    .click();
  return (await (await creation).json()).sessionId as string;
}

async function expectCue(page: Page, cue: string, duration: number) {
  const control = page.locator(".sound-control");
  await expect(control).toHaveAttribute("data-cue", cue);
  await expect(control).toHaveAttribute("data-status", "playing");
  await expect
    .poll(async () =>
      (await audioMetrics(page)).starts.some(
        (start) =>
          Math.abs(start.duration - duration) < 0.1 && start.peak > 0.01,
      ),
    )
    .toBe(true);
}

test("approved production music follows a complete campaign and survives map/drawer changes", async ({
  page,
  musicGame,
}, info) => {
  await observeNativeMusic(page);
  const errors: string[] = [];
  const fetched: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/audio/music/") && response.ok()) fetched.push(path);
  });
  await page.goto("/");
  await expect(page.getByTestId("sound-settings")).toBeVisible();
  await expect(page.locator(".sound-control")).toHaveAttribute(
    "data-cue",
    "opening",
  );
  expect((await audioMetrics(page)).starts).toHaveLength(0);
  const sessionId = await enterBriefing(page);
  await expectCue(page, "opening", 67);
  await page.getByRole("button", { name: "Start escort", exact: true }).click();
  expect(await musicGame.projection(sessionId)).toMatchObject({
    actionTiming: "instant",
    sceneId: "E1",
    phase: "scene",
    missionTimeMs: 30000,
    playerElapsedMs: 0,
    activeOperation: null,
  });
  await expectCue(page, "E1", 59.428571);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("sound-settings").click();
  await expect(
    page.getByRole("group", { name: "Sound settings", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("game-sound-settings-1280.png"),
    fullPage: true,
  });
  await page.getByTestId("sound-settings").click();
  await page.setViewportSize({ width: 1440, height: 1000 });

  const beforeUi = (await audioMetrics(page)).starts.length;
  await page.getByTestId("open-intel").click();
  await page.keyboard.press("Escape");
  await page.getByTestId("open-advisor").click();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "3D terrain model", exact: true })
    .click();
  await expect(page.locator(".map3d canvas")).toBeVisible();
  await page.getByRole("button", { name: "2D route map", exact: true }).click();
  const beforeClock = await musicGame.projection(sessionId);
  musicGame.advancePlayerTime(1000);
  const refreshedClock = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/api/v1/sessions/${sessionId}`,
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  const afterClock = (await (await refreshedClock).json()) as SessionProjection;
  expect(afterClock.missionTimeMs).toBe(beforeClock.missionTimeMs);
  expect(afterClock.playerElapsedMs).toBe(1000);
  // The same-scene player clock update also keeps the musical phrase.
  await expectCue(page, "E1", 59.428571);
  expect((await audioMetrics(page)).starts).toHaveLength(beforeUi);

  async function route(actionId: string, nextScene: string | null) {
    const option = (await musicGame.projection(sessionId)).actionOptions.find(
      (action) => action.actionId === actionId && action.available,
    );
    expect(option).toBeDefined();
    await page
      .locator(".route-choice")
      .filter({ hasText: option!.label })
      .click();
    const accepted = page.waitForResponse(
      (response) =>
        response.url().endsWith("/actions") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Confirm action", exact: true })
      .click();
    const response = await accepted;
    expect(response.status()).toBe(202);
    expect((await response.json()).operation.status).toBe("completed");
    const projection = await musicGame.projection(sessionId);
    expect(projection.activeOperation).toBeNull();
    expect(projection.activeTasks).toEqual([]);
    expect(projection.playerElapsedMs).toBe(1000);
    if (nextScene)
      expect(projection).toMatchObject({ phase: "scene", sceneId: nextScene });
    else expect(projection.lifecycle).toBe("sealed");
  }
  await route("E1_MAIN", "E2");
  await expectCue(page, "E2", 72);
  await route("E2_MAIN", "E3");
  await expectCue(page, "E3", 76.571428);
  await route("E3_BRIDGE", null);
  await expectCue(page, "ending", 73);
  expect(fetched.sort()).toEqual([
    "/audio/music/bridge.mp3",
    "/audio/music/ending.mp3",
    "/audio/music/market.mp3",
    "/audio/music/opening.mp3",
    "/audio/music/west-gate.mp3",
  ]);
  expect((await audioMetrics(page)).microphoneCalls).toBe(0);
  await page.getByTestId("sound-settings").click();
  await expect(
    page.getByRole("slider", { name: "Music volume", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("ending-sound-settings.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("sound preferences persist independently, and mute survives reload until explicitly enabled", async ({
  page,
  musicGame,
}, info) => {
  void musicGame;
  await observeNativeMusic(page);
  await page.goto("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("sound-settings").click();
  await expectCue(page, "opening", 67);
  const group = page.getByRole("group", {
    name: "Sound settings",
    exact: true,
  });
  const music = group.getByRole("slider", {
    name: "Music volume",
    exact: true,
  });
  const ambience = group.getByRole("slider", {
    name: "Ambience volume",
    exact: true,
  });
  await page.screenshot({
    path: info.outputPath("landing-sound-settings-1280.png"),
    fullPage: true,
  });
  await music.focus();
  await music.press("Home");
  for (let index = 0; index < 27; index++) await music.press("ArrowRight");
  await ambience.focus();
  await ambience.press("Home");
  for (let index = 0; index < 14; index++) await ambience.press("ArrowRight");
  await group.getByRole("button", { name: "Mute sound", exact: true }).click();
  await expect(page.locator(".sound-control")).toHaveAttribute(
    "data-status",
    "off",
  );
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      settingsKey,
    ),
  ).toEqual({ enabled: false, music: 0.27, ambience: 0.14 });
  await page.reload();
  await page.getByTestId("sound-settings").click();
  await expect(page.locator(".sound-control")).toHaveAttribute(
    "data-status",
    "off",
  );
  await expect(music).toHaveValue("27");
  await expect(ambience).toHaveValue("14");
  expect((await audioMetrics(page)).starts).toHaveLength(0);
  await group
    .getByRole("button", { name: "Enable sound", exact: true })
    .click();
  await expectCue(page, "opening", 67);
  await expect(
    group.getByRole("button", { name: "Mute sound", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect((await audioMetrics(page)).microphoneCalls).toBe(0);
});

test("unmuting resumes native audio while the initial music download is still pending", async ({
  page,
  musicGame,
}) => {
  void musicGame;
  await observeNativeMusic(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/audio/music/opening.mp3", async (route) => {
    requests++;
    await pending;
    await route.continue().catch(() => {});
  });
  const contextState = () =>
    page.evaluate(
      () =>
        (window as unknown as { __observedMusicGains: GainNode[] })
          .__observedMusicGains[0]?.context.state ?? "not-created",
    );
  try {
    await page.goto("/");
    await expect(page.getByTestId("sound-settings")).toBeVisible();
    expect(await contextState()).toBe("not-created");
    expect(requests).toBe(0);
    await page.getByTestId("sound-settings").click();
    await expect.poll(() => requests).toBe(1);
    await expect.poll(contextState).toBe("running");
    await page.getByRole("button", { name: "Mute sound", exact: true }).click();
    await expect.poll(contextState).toBe("suspended");
    await expect(page.locator(".sound-control")).toHaveAttribute(
      "data-status",
      "off",
    );
    await page
      .getByRole("button", { name: "Enable sound", exact: true })
      .click();
    await expect.poll(contextState).toBe("running");
    await expect(page.locator(".sound-control")).toHaveAttribute(
      "data-status",
      "loading",
    );
    expect((await audioMetrics(page)).starts).toHaveLength(0);
    expect(requests).toBe(1);
    release();
    await expectCue(page, "opening", 67);
    await expect.poll(contextState).toBe("running");
    expect(requests).toBe(1);
    expect((await audioMetrics(page)).microphoneCalls).toBe(0);
  } finally {
    release();
  }
});

test("a second trusted gesture retries native resume before an earlier resume promise settles", async ({
  page,
  musicGame,
}) => {
  void musicGame;
  await observeNativeMusic(page);
  await page.addInitScript(() => {
    const resume = AudioContext.prototype.resume;
    const attempts: boolean[] = [];
    Object.assign(window, { __nativeResumeAttempts: attempts });
    AudioContext.prototype.resume = function () {
      attempts.push(navigator.userActivation.isActive);
      // Model an embedded browser leaving the first resume unresolved. Later
      // calls exercise the native method with a fresh actual browser gesture.
      if (attempts.length === 1) return new Promise<void>(() => {});
      return resume.call(this);
    };
  });
  const fetched: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/audio/music/"))
      fetched.push(request.url());
  });
  const resumeAttempts = () =>
    page.evaluate(
      () =>
        (window as unknown as { __nativeResumeAttempts: boolean[] })
          .__nativeResumeAttempts,
    );
  await page.goto("/");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect.poll(resumeAttempts).toEqual([true]);
  expect(fetched).toHaveLength(0);
  expect((await audioMetrics(page)).starts).toHaveLength(0);
  await page.getByTestId("sound-settings").click();
  await expect(page.locator(".sound-control")).toHaveAttribute(
    "data-status",
    "playing",
    { timeout: 4000 },
  );
  await expectCue(page, "opening", 67);
  expect(await resumeAttempts()).toEqual([true, true]);
  expect(fetched).toHaveLength(1);
  expect((await audioMetrics(page)).microphoneCalls).toBe(0);
});

// Synthetic spoken content only; production music is decoded and played as-is.
function silentSpeechWave(seconds = 6) {
  const rate = 16000,
    length = seconds * rate * 2;
  const wave = Buffer.alloc(44 + length);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(36 + length, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(rate, 24);
  wave.writeUInt32LE(rate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(length, 40);
  return wave;
}

test("a failed music download can retry, and spoken clues duck music without restarting it", async ({
  page,
  musicGame,
}) => {
  await observeNativeMusic(page);
  let attempts = 0;
  await page.route("**/audio/music/opening.mp3", async (route) => {
    attempts++;
    if (attempts === 1)
      await route.fulfill({ status: 503, body: "Synthetic music outage" });
    else await route.continue();
  });
  await page.route("**/api/v1/speech/config", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        language: "en",
        sttModel: "nova-3",
        ttsModel: "aura-2-draco-en",
        maxRecordingSeconds: 90,
        maxTextLength: 2000,
      },
    }),
  );
  await page.route("**/api/v1/speech/synthesize", (route) =>
    route.fulfill({
      contentType: "audio/wav",
      body: silentSpeechWave(),
    }),
  );
  await page.goto("/");
  await page.getByTestId("sound-settings").click();
  await expect(page.locator(".sound-control")).toHaveAttribute(
    "data-status",
    "error",
  );
  await page
    .getByRole("group", { name: "Sound settings", exact: true })
    .getByRole("button", { name: /Retry/i })
    .click();
  await expectCue(page, "opening", 67);
  expect(attempts).toBe(2);
  await page.getByTestId("sound-settings").click();
  const sessionId = await enterBriefing(page);
  await page.getByRole("button", { name: "Start escort", exact: true }).click();
  await expectCue(page, "E1", 59.428571);
  expect(await musicGame.projection(sessionId)).toMatchObject({
    sceneId: "E1",
    playerElapsedMs: 0,
    activeOperation: null,
  });
  const beforeSpeech = (await audioMetrics(page)).starts.length;
  // Find the settled native music bus, then observe its actual AudioParam as
  // speech starts/stops; the data attribute alone would not prove attenuation.
  const musicBusIndex = () =>
    page.evaluate(() =>
      (
        window as unknown as { __observedMusicGains: GainNode[] }
      ).__observedMusicGains.findIndex(
        (gain) => Math.abs(gain.gain.value - 0.55) < 0.005,
      ),
    );
  await expect.poll(musicBusIndex).toBeGreaterThanOrEqual(0);
  const musicBus = await musicBusIndex();
  const musicBusValue = () =>
    page.evaluate(
      (index) =>
        (window as unknown as { __observedMusicGains: GainNode[] })
          .__observedMusicGains[index].gain.value,
      musicBus,
    );
  await page.getByTestId("open-story").click();
  const story = page.getByRole("dialog");
  await story.getByRole("button", { name: "Listen", exact: true }).click();
  await expect(story.getByRole("status")).toContainText("Playing");
  await expect(page.locator(".sound-control")).toHaveAttribute(
    "data-ducked",
    "true",
  );
  await expect.poll(musicBusValue).toBeCloseTo(0.55 * 0.15, 2);
  await story.getByRole("button", { name: "Stop audio", exact: true }).click();
  await expect(page.locator(".sound-control")).toHaveAttribute(
    "data-ducked",
    "false",
  );
  await expect.poll(musicBusValue).toBeCloseTo(0.55, 2);
  expect((await audioMetrics(page)).starts).toHaveLength(beforeSpeech);
  // A synthetic visibility transition drives the real listener and native
  // AudioContext. Browser playback time itself is never mocked or advanced.
  const contextState = () =>
    page.evaluate(
      (index) =>
        (window as unknown as { __observedMusicGains: GainNode[] })
          .__observedMusicGains[index].context.state,
      musicBus,
    );
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(contextState).toBe("suspended");
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(contextState).toBe("running");
  await expect.poll(musicBusValue).toBeCloseTo(0.55, 2);
  expect((await audioMetrics(page)).starts).toHaveLength(beforeSpeech);
  expect((await audioMetrics(page)).microphoneCalls).toBe(0);
});
