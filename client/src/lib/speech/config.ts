export type SpeechConfig = {
  enabled: boolean;
  language: "en";
  sttModel: string;
  ttsModel: string;
  maxRecordingSeconds: number;
  maxTextLength: number;
};
let pending: Promise<SpeechConfig> | undefined;
let cached: { value: SpeechConfig; expiresAt: number } | undefined;
export function getSpeechConfig({
  force = false,
}: { force?: boolean } = {}): Promise<SpeechConfig> {
  // Coalesce simultaneous controls, but never retain a disabled service for the
  // lifetime of the page. Explicit retry/focus can refresh immediately.
  if (pending) return pending;
  if (!force && cached && cached.expiresAt > Date.now())
    return Promise.resolve(cached.value);
  const request = fetch("/api/v1/speech/config", {
    credentials: "same-origin",
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (response) => {
      if (!response.ok)
        throw new Error(
          "Voice is unavailable. You can still type your question.",
        );
      const value = (await response.json()) as SpeechConfig;
      cached = {
        value,
        expiresAt: Date.now() + (value.enabled ? 30_000 : 5_000),
      };
      return value;
    })
    .catch((error: unknown) => {
      cached = undefined;
      throw error;
    })
    .finally(() => {
      if (pending === request) pending = undefined;
    });
  pending = request;
  return request;
}

export async function speechError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null);
  return new Error(
    body?.error?.message ||
      body?.detail ||
      "Voice is unavailable. Please try again.",
  );
}
