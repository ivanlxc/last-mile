import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvisorOutput } from "../docs/engineering_v0.5/contracts/agent-derived.types";
import {
  advisorReadout,
  splitSpeechText,
} from "../client/src/lib/speech/readout";
import { SpeechPlayer } from "../client/src/lib/speech/playback";
import {
  getSpeechActivity,
  setSpeechActivity,
} from "../client/src/lib/speech/activity";

const config = {
  enabled: true,
  language: "en" as const,
  sttModel: "nova-3",
  ttsModel: "aura-2-thalia-en",
  maxRecordingSeconds: 90,
  maxTextLength: 2000,
};
async function drain() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

describe("spoken evidence keeps its qualifications", () => {
  it("splits long text without dropping the final uncertainty or cutting ordinary words", () => {
    const text = `${"The bridge is visible. ".repeat(110)}This does not establish crossing permission.`;
    const chunks = splitSpeechText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
    expect(chunks.at(-1)).toContain(
      "This does not establish crossing permission.",
    );
  });
  it("includes stale warning, conditions, uncertainties, claim kinds, and source attribution", () => {
    const output: AdvisorOutput = {
      sessionId: "session-1",
      inputHash: "input-1",
      summary: "A crossing may be possible.",
      recommendation: {
        actionId: "cross",
        rationale: "The agency described a procedure.",
        claimRefs: ["c1"],
        conditions: ["Confirm current permission."],
      },
      uncertainties: ["The far bank has not been observed."],
      claims: [
        {
          claimId: "c1",
          kind: "inference",
          text: "The report does not guarantee access.",
          citations: [{ kind: "evidence", refId: "e1", revision: 1 }],
        },
      ],
      investigationSuggestions: [
        {
          channel: "localAgency",
          publicTargetId: "agency",
          claimRefs: ["c1"],
          questionToResolve: "Is permission current?",
        },
      ],
      changeSummary: "An agency report was added.",
    };
    const text = advisorReadout(output, {
      current: false,
      offline: true,
      actionLabel: "Main bridge",
      sourceTitle: () => "Agency contact",
    });
    expect(text).toContain("Earlier analysis.");
    expect(text).toContain("Offline evidence review.");
    expect(text).toContain("Confirm current permission.");
    expect(text).toContain("The far bank has not been observed.");
    expect(text).toContain("Inference: The report does not guarantee access.");
    expect(text).toContain("Sources: Agency contact.");
    expect(text).toContain("Is permission current?");
  });
});

class FakeAudio {
  src = "";
  currentTime = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  play = vi.fn(async () => {});
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  remove = vi.fn();
}

describe("shared speech playback ownership", () => {
  let player: SpeechPlayer;
  let audios: FakeAudio[];
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  let revokeUrl: ReturnType<typeof vi.fn<(url: string) => void>>;
  let nextPlayError: Error | undefined;
  let hangNextPlay: boolean;
  beforeEach(() => {
    audios = [];
    nextPlayError = undefined;
    hangNextPlay = false;
    fetcher = vi.fn(
      async () =>
        ({
          ok: true,
          blob: async () => new Blob(["mp3"], { type: "audio/mpeg" }),
        }) as Response,
    );
    revokeUrl = vi.fn();
    player = new SpeechPlayer({
      fetch: fetcher,
      config: async () => config,
      audio: () => {
        const audio = new FakeAudio();
        if (nextPlayError) {
          audio.play.mockRejectedValueOnce(nextPlayError);
          nextPlayError = undefined;
        }
        if (hangNextPlay) {
          audio.play.mockImplementationOnce(() => new Promise(() => {}));
          hangNextPlay = false;
        }
        audios.push(audio);
        return audio as unknown as HTMLAudioElement;
      },
      createUrl: () => `blob:audio-${audios.length}`,
      revokeUrl,
    });
  });
  afterEach(() => {
    player.dispose();
    setSpeechActivity({ recording: false, playing: false });
    vi.useRealTimers();
  });

  it("fires completion only after every chunk ends and revokes every object URL", async () => {
    const onComplete = vi.fn();
    const text = "Check the observation scope. ".repeat(150);
    const playing = player.play("report:1", text, onComplete);
    await drain();
    expect(audios).toHaveLength(1);
    expect(onComplete).not.toHaveBeenCalled();
    audios[0].onended?.();
    await drain();
    expect(audios).toHaveLength(2);
    expect(onComplete).not.toHaveBeenCalled();
    audios[1].onended?.();
    await drain();
    expect(audios).toHaveLength(3);
    expect(onComplete).not.toHaveBeenCalled();
    audios[2].onended?.();
    await playing;
    expect(onComplete).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledTimes(3);
    expect(player.snapshot().status).toBe("ended");
    expect(getSpeechActivity().playing).toBe(false);
  });

  it("replacement stops the old voice and never counts it as completed", async () => {
    const oldComplete = vi.fn();
    const first = player.play("report:1", "First report.", oldComplete);
    await drain();
    const secondComplete = vi.fn();
    const second = player.play("advice:1", "New advice.", secondComplete);
    await drain();
    expect(audios[0].pause).toHaveBeenCalledOnce();
    expect(audios[0].onended).toBeNull();
    expect(revokeUrl).toHaveBeenCalledWith("blob:audio-1");
    audios[1].onended?.();
    await Promise.all([first, second]);
    expect(oldComplete).not.toHaveBeenCalled();
    expect(secondComplete).toHaveBeenCalledOnce();
  });

  it("microphone start aborts pending synthesis and discards late audio", async () => {
    let resolve!: (response: Response) => void;
    fetcher.mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const onComplete = vi.fn();
    const playing = player.play("report:1", "Report text.", onComplete);
    await drain();
    const signal = fetcher.mock.calls[0][1]?.signal;
    setSpeechActivity({ recording: true });
    expect(signal?.aborted).toBe(true);
    resolve(new Response(new Blob(["late mp3"])));
    await playing;
    expect(audios).toHaveLength(0);
    expect(onComplete).not.toHaveBeenCalled();
    expect(player.snapshot().status).toBe("idle");
  });

  it("refuses read aloud during recording and preserves text access on API failure", async () => {
    setSpeechActivity({ recording: true });
    await player.play("report:1", "Report text.");
    expect(fetcher).not.toHaveBeenCalled();
    expect(player.snapshot().error).toContain("Stop recording");
    setSpeechActivity({ recording: false });
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "Voice is temporarily unavailable." },
        }),
        { status: 503 },
      ),
    );
    const onComplete = vi.fn();
    await player.play("report:1", "Report text.", onComplete);
    expect(player.snapshot().error).toBe("Voice is temporarily unavailable.");
    expect(getSpeechActivity().playing).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("resumes a blocked first and later part synchronously without refetching or dropping qualifications", async () => {
    nextPlayError = new DOMException("Gesture required", "NotAllowedError");
    const onComplete = vi.fn();
    const playing = player.play(
      "report:1",
      "Check the observation scope. ".repeat(100),
      onComplete,
    );
    await drain();
    expect(player.snapshot().status).toBe("blocked");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(revokeUrl).not.toHaveBeenCalled();
    player.resume("report:1");
    expect(audios[0].play).toHaveBeenCalledTimes(2); // Same click stack.
    await drain();
    expect(player.snapshot().status).toBe("playing");
    audios[0].currentTime = 1.5;
    audios[0].ontimeupdate?.();
    expect(player.snapshot().seconds).toBe(1);
    nextPlayError = new DOMException(
      "Another gesture required",
      "NotAllowedError",
    );
    audios[0].onended?.();
    await drain();
    expect(player.snapshot()).toMatchObject({
      status: "blocked",
      part: 2,
      parts: 2,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(revokeUrl).toHaveBeenCalledTimes(1);
    audios[1].currentTime = 0.75;
    player.resume("report:1");
    expect(audios[1].play).toHaveBeenCalledTimes(2);
    expect(audios[1].currentTime).toBe(0.75);
    await drain();
    audios[1].onended?.();
    await playing;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(revokeUrl).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("recovers a forever-pending play promise after ten seconds without losing the downloaded audio", async () => {
    vi.useFakeTimers();
    hangNextPlay = true;
    const playing = player.play("report:1", "Review the observation scope.");
    await drain();
    expect(player.snapshot().status).toBe("loading");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(player.snapshot().status).toBe("blocked");
    expect(audios[0].pause).toHaveBeenCalledOnce();
    expect(revokeUrl).not.toHaveBeenCalled();
    player.resume("report:1");
    expect(audios[0].play).toHaveBeenCalledTimes(2);
    await drain();
    expect(player.snapshot().status).toBe("playing");
    audios[0].onended?.();
    await playing;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("microphone start releases a blocked voice and prevents any later resume", async () => {
    nextPlayError = new DOMException("Gesture required", "NotAllowedError");
    const onComplete = vi.fn();
    const playing = player.play("report:1", "Full report text.", onComplete);
    await drain();
    expect(player.snapshot().status).toBe("blocked");
    setSpeechActivity({ recording: true });
    await playing;
    player.resume("report:1");
    expect(audios[0].play).toHaveBeenCalledOnce();
    expect(audios[0].remove).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
