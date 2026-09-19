export type MusicCue = "opening" | "E1" | "E2" | "E3" | "ending";

export interface MusicCueDefinition {
  url: string;
  title: string;
  /** End of the composed phrase plus two seconds of its release tail. */
  loopEndSeconds: number;
  /** Overlap the ending phrase with the next source's opening. */
  crossfadeSeconds: number;
}

// Exact copies of the approved masters. Sources and playback boundaries are
// documented in docs/music-system.md; historical auditions remain unchanged.
export const MUSIC_CUES: Record<MusicCue, MusicCueDefinition> = {
  opening: {
    url: "/audio/music/opening.mp3",
    title: "Last Light",
    loopEndSeconds: 62,
    crossfadeSeconds: 6,
  },
  E1: {
    url: "/audio/music/west-gate.mp3",
    title: "Weight of Passage",
    loopEndSeconds: 53.42857142857143,
    crossfadeSeconds: 6,
  },
  E2: {
    url: "/audio/music/market.mp3",
    title: "Unsettled Accounts",
    loopEndSeconds: 66,
    crossfadeSeconds: 6,
  },
  E3: {
    url: "/audio/music/bridge.mp3",
    title: "The Weight Across the Water",
    loopEndSeconds: 70.57142857142857,
    crossfadeSeconds: 6,
  },
  ending: {
    url: "/audio/music/ending.mp3",
    title: "A Place to Rest",
    loopEndSeconds: 66,
    crossfadeSeconds: 6,
  },
};
