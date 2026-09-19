/** Test-only types for the browser's unbundled AudioWorklet module. */
declare module "*/audio/pcm16.js" {
  export class Pcm16Resampler {
    constructor(inputRate: number, outputRate?: number);
    push(input: Float32Array): Int16Array;
  }
  export function pcm16LittleEndian(samples: Int16Array): ArrayBuffer;
}
