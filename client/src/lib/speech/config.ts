export type SpeechConfig = {
  enabled: boolean;
  language: "en";
  sttModel: string;
  ttsModel: string;
  maxRecordingSeconds: number;
  maxTextLength: number;
};
let pending: Promise<SpeechConfig> | undefined;
export function getSpeechConfig(): Promise<SpeechConfig> {
  return (pending ??= fetch("/api/v1/speech/config", {
    credentials: "same-origin",
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (response) => {
      if (!response.ok)
        throw new Error(
          "Voice is unavailable. You can still type your question.",
        );
      return (await response.json()) as SpeechConfig;
    })
    .catch((error: unknown) => {
      pending = undefined;
      throw error;
    }));
}

export async function speechError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null);
  return new Error(
    body?.error?.message ||
      body?.detail ||
      "Voice is unavailable. Please try again.",
  );
}
