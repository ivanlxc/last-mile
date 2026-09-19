export type SpeechActivity = { recording: boolean; playing: boolean };
let activity: SpeechActivity = { recording: false, playing: false };
const listeners = new Set<() => void>();

export const getSpeechActivity = () => activity;
export function subscribeSpeechActivity(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setSpeechActivity(change: Partial<SpeechActivity>) {
  if (
    Object.entries(change).every(
      ([key, value]) => activity[key as keyof SpeechActivity] === value,
    )
  )
    return;
  activity = { ...activity, ...change };
  listeners.forEach((listener) => listener());
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("last-mile-speech-activity", { detail: activity }),
    );
  }
}
