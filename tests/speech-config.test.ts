import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = {
  enabled: true,
  language: "en",
  sttModel: "nova-3",
  ttsModel: "aura-2-thalia-en",
  maxRecordingSeconds: 90,
  maxTextLength: 2000,
};
describe("speech configuration recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("refreshes disabled config explicitly and expires enabled snapshots without polling", async () => {
    let enabled = false;
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...config, enabled }),
    }));
    vi.stubGlobal("fetch", fetcher);
    const { getSpeechConfig } = await import("../client/src/lib/speech/config");
    expect((await getSpeechConfig()).enabled).toBe(false);
    enabled = true;
    expect((await getSpeechConfig()).enabled).toBe(false);
    expect((await getSpeechConfig({ force: true })).enabled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(fetcher).toHaveBeenCalledTimes(2); // No interval/polling.
    await getSpeechConfig();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent retries and recovers from network failure", async () => {
    let resolve!: (value: unknown) => void;
    const fetcher = vi.fn(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { getSpeechConfig } = await import("../client/src/lib/speech/config");
    const first = getSpeechConfig({ force: true });
    const second = getSpeechConfig({ force: true });
    expect(first).toBe(second);
    resolve({ ok: false });
    await expect(first).rejects.toThrow("Voice is unavailable");
    const third = getSpeechConfig({ force: true });
    resolve({ ok: true, json: async () => config });
    expect((await third).enabled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
