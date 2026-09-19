export class Pcm16Resampler {
  constructor(inputRate: number, outputRate?: number);
  push(input: Float32Array): Int16Array;
}
export function pcm16LittleEndian(samples: Int16Array): ArrayBuffer;
