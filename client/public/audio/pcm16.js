/** Continuous interpolation keeps fractional sample positions across render blocks. */
export class Pcm16Resampler {
  constructor(inputRate, outputRate = 16000) {
    if (!Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(outputRate) || outputRate <= 0) {
      throw new Error("Invalid audio sample rate");
    }
    this.ratio = inputRate / outputRate;
    this.inputIndex = 0;
    this.outputIndex = 0;
    this.previous = 0;
  }

  push(input) {
    const samples = [];
    for (let index = 0; index < input.length; index++, this.inputIndex++) {
      const current = Number.isFinite(input[index]) ? input[index] : 0;
      while (this.outputIndex * this.ratio <= this.inputIndex) {
        const position = this.outputIndex * this.ratio;
        const fraction = this.inputIndex === 0 ? 1 : position - (this.inputIndex - 1);
        const interpolated = this.previous + (current - this.previous) * fraction;
        const clamped = Math.max(-1, Math.min(1, interpolated));
        samples.push(Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767));
        this.outputIndex++;
      }
      this.previous = current;
    }
    return Int16Array.from(samples);
  }
}

export function pcm16LittleEndian(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index++) view.setInt16(index * 2, samples[index], true);
  return buffer;
}
