import { Pcm16Resampler, pcm16LittleEndian } from "./pcm16.js";

class LastMileMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new Pcm16Resampler(sampleRate);
    this.batch = new Int16Array(1600);
    this.length = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type !== "stop" || this.stopped) return;
      this.stopped = true;
      this.flush();
      this.port.postMessage({ type: "flushed" });
    };
  }

  flush() {
    if (!this.length) return;
    const pcm = pcm16LittleEndian(this.batch.subarray(0, this.length));
    this.port.postMessage({ type: "pcm", buffer: pcm }, [pcm]);
    this.length = 0;
  }

  process(inputs, outputs) {
    // Keep the audio graph alive without playing the player's microphone back.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (input) {
      for (const sample of this.resampler.push(input)) {
        this.batch[this.length++] = sample;
        if (this.length === this.batch.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor("last-mile-microphone", LastMileMicrophone);
