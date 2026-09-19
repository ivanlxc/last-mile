import type { P } from "./api";
import type { MusicCue } from "./music-cues";

export const AUDIO_STORAGE_KEY = "last-mile-audio-v1";
export type AudioPreferences = {
  enabled: boolean;
  music: number;
  ambience: number;
};
export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = {
  enabled: true,
  music: 0.55,
  ambience: 0.32,
};

/** Public chapter/lifecycle only. Audio never interprets route or outcome quality. */
export function musicCueFor(
  state: Pick<P.SessionProjection, "lifecycle" | "sceneId"> | null,
): MusicCue {
  if (state?.lifecycle === "sealed") return "ending";
  if (state?.lifecycle === "active") {
    if (["E1", "E2", "E3"].includes(state.sceneId ?? ""))
      return state.sceneId as "E1" | "E2" | "E3";
  }
  return "opening";
}

export function parseAudioPreferences(raw: string | null): AudioPreferences {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object")
      return { ...DEFAULT_AUDIO_PREFERENCES };
    const input = value as Record<string, unknown>;
    const volume = (key: "music" | "ambience") =>
      typeof input[key] === "number" && Number.isFinite(input[key])
        ? Math.max(0, Math.min(1, input[key]))
        : DEFAULT_AUDIO_PREFERENCES[key];
    return {
      enabled: typeof input.enabled === "boolean" ? input.enabled : true,
      music: volume("music"),
      ambience: volume("ambience"),
    };
  } catch {
    return { ...DEFAULT_AUDIO_PREFERENCES };
  }
}
