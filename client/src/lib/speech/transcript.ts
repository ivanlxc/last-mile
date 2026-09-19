export type TranscriptMessage = {
  type: "transcript";
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  segmentId?: string;
};

/** Final segments are additive; interim hypotheses replace one another. */
export class TranscriptBuffer {
  private finals: string[] = [];
  private finalIds = new Set<string>();
  private interim = "";

  accept(message: TranscriptMessage) {
    const text = message.text.trim();
    if (message.isFinal) {
      if (
        text &&
        (!message.segmentId || !this.finalIds.has(message.segmentId))
      ) {
        this.finals.push(text);
        if (message.segmentId) this.finalIds.add(message.segmentId);
      }
      this.interim = "";
    } else {
      this.interim = text;
    }
    return this.snapshot();
  }

  snapshot() {
    return { confirmed: this.finals.join(" "), interim: this.interim };
  }
}

export function appendTranscript(
  draft: string,
  transcript: string,
  limit = 2000,
) {
  const joined = [draft.trimEnd(), transcript.trim()].filter(Boolean).join(" ");
  return { text: joined.slice(0, limit), truncated: joined.length > limit };
}
