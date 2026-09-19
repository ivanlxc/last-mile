import { test as base, expect } from "@playwright/test";
import type { FastifyInstance } from "fastify";
import { createGameService } from "../../server/core/service.js";
import { createAiService } from "../../server/ai/index.js";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";

const test = base.extend<{ speechGame: string }>({
  speechGame: async ({}, use) => {
    const service = await createGameService({
      dbPath: ":memory:",
      recoverOnStartup: false,
      autoTick: false,
      selectCase: () => "A",
      agents: createAiService({ env: {} }),
    });
    let app: FastifyInstance | undefined;
    try {
      const config = loadHttpConfig({
        LAST_MILE_ROOT: process.cwd(),
        PORT: "33131",
      });
      app = await createHttpApp({ service, config, closeServiceOnClose: true });
      await app.listen({ host: "127.0.0.1", port: 33131 });
      await use("http://127.0.0.1:33131");
    } finally {
      if (app) await app.close();
      else await service.close();
    }
  },
});

const speechConfig = {
  enabled: true,
  language: "en",
  sttModel: "nova-3",
  ttsModel: "aura-2-thalia-en",
  maxRecordingSeconds: 90,
  maxTextLength: 2000,
};

/** A decodable, silent test clip exercises native HTML audio without a provider
 * request, a real microphone, or audible test noise. Production returns MP3. */
function silentWave(seconds = 2) {
  const sampleRate = 16000;
  const dataLength = seconds * sampleRate * 2;
  const audio = Buffer.alloc(44 + dataLength);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(36 + dataLength, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(sampleRate, 24);
  audio.writeUInt32LE(sampleRate * 2, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(dataLength, 40);
  return audio;
}

test("desktop read aloud: API failure, retry, cancellation, native playback, replay and close cleanup", async ({
  page,
  speechGame,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const audios: HTMLAudioElement[] = [];
    const NativeAudio = window.Audio;
    window.Audio = function (src?: string) {
      const audio = new NativeAudio(src);
      audios.push(audio);
      return audio;
    } as unknown as typeof Audio;
    Object.assign(window, { __testSpeechAudios: audios });
  });
  await page.route("**/api/v1/speech/config", (route) =>
    route.fulfill({ json: speechConfig }),
  );
  const submittedTexts: string[] = [];
  let releasePending!: () => void;
  const pending = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  await page.route("**/api/v1/speech/synthesize", async (route) => {
    submittedTexts.push(route.request().postDataJSON().text);
    if (submittedTexts.length === 1) {
      await route.fulfill({
        status: 503,
        json: {
          error: {
            message: "Speech is temporarily unavailable. Please retry.",
          },
        },
      });
    } else {
      if (submittedTexts.length === 2) await pending;
      await route
        .fulfill({ contentType: "audio/wav", body: silentWave() })
        .catch(() => {});
    }
  });

  await page.goto(speechGame);
  await page
    .getByRole("button", { name: "Enter mission briefing", exact: true })
    .click();
  await page.getByRole("button", { name: "Start escort", exact: true }).click();
  await page.getByTestId("open-story").click();
  const story = page.getByRole("dialog");
  const listen = story.getByRole("button", { name: "Listen", exact: true });
  await expect(listen).toBeEnabled();
  const storyText = await story.innerText();

  await listen.click();
  await expect(story.getByRole("status")).toContainText(
    "Speech is temporarily unavailable",
  );
  await expect(listen).toBeEnabled();
  await expect(story).toContainText("Daybreak");

  await listen.click();
  await expect.poll(() => submittedTexts.length).toBe(2);
  await story.getByRole("button", { name: "Stop audio", exact: true }).click();
  releasePending();
  await expect(listen).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __testSpeechAudios: HTMLAudioElement[] })
            .__testSpeechAudios.length,
      ),
    )
    .toBe(0);

  await listen.click();
  await expect(
    story.getByRole("button", { name: "Stop audio", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const audio = (
          window as unknown as { __testSpeechAudios: HTMLAudioElement[] }
        ).__testSpeechAudios.at(-1);
        return !!audio && !audio.paused && audio.readyState >= 2;
      }),
    )
    .toBe(true);
  await expect(
    story.getByRole("button", { name: "Replay", exact: true }),
  ).toBeVisible();
  expect(submittedTexts[2].length).toBeLessThanOrEqual(2000);
  expect(storyText).toContain(submittedTexts[2].split(". ")[0]);

  await story.getByRole("button", { name: "Replay", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __testSpeechAudios: HTMLAudioElement[] })
            .__testSpeechAudios.length,
      ),
    )
    .toBe(2);
  await story.getByRole("button", { name: "Close", exact: true }).click();
  await expect(story).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __testSpeechAudios: HTMLAudioElement[] }
      ).__testSpeechAudios.every(
        (audio) => audio.paused && !audio.getAttribute("src"),
      ),
    ),
  ).toBe(true);
  await expect(page.getByTestId("open-intel")).toBeEnabled();
  expect(pageErrors).toEqual([]);
});
