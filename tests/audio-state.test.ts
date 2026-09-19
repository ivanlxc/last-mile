import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIO_PREFERENCES,
  musicCueFor,
  parseAudioPreferences,
} from "../client/src/lib/audio-state";

describe("public chapter soundtrack selection", () => {
  it("uses the opening through briefing and prologue travel", () => {
    expect(musicCueFor(null)).toBe("opening");
    expect(musicCueFor({ lifecycle: "created", sceneId: "E1" })).toBe(
      "opening",
    );
    expect(musicCueFor({ lifecycle: "active", sceneId: null })).toBe("opening");
  });
  it("follows public scenes and prioritizes ending over the last chapter", () => {
    for (const sceneId of ["E1", "E2", "E3"] as const) {
      expect(musicCueFor({ lifecycle: "active", sceneId })).toBe(sceneId);
      expect(musicCueFor({ lifecycle: "sealed", sceneId })).toBe("ending");
    }
    expect(musicCueFor({ lifecycle: "sealed", sceneId: null })).toBe("ending");
  });
});

describe("saved sound settings", () => {
  it("preserves explicit mute and silent individual channels", () => {
    expect(
      parseAudioPreferences('{"enabled":false,"music":0,"ambience":0.14}'),
    ).toEqual({ enabled: false, music: 0, ambience: 0.14 });
  });
  it("recovers corrupt storage and clamps unsafe volume inputs", () => {
    for (const raw of [null, "oops", "null", "42", "[]", "{}"])
      expect(parseAudioPreferences(raw)).toEqual(DEFAULT_AUDIO_PREFERENCES);
    expect(
      parseAudioPreferences('{"enabled":"false","music":8,"ambience":-1}'),
    ).toEqual({ enabled: true, music: 1, ambience: 0 });
    expect(parseAudioPreferences('{"music":"0.1","ambience":null}')).toEqual(
      DEFAULT_AUDIO_PREFERENCES,
    );
  });
});
