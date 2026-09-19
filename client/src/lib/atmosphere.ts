/** Presentation audio only: no hidden world state or gameplay decisions. */
export class Atmosphere {
  private readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly engine: OscillatorNode;
  private readonly engineGain: GainNode;
  private readonly wind: AudioBufferSourceNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly ownsContext: boolean;
  private closed = false;

  constructor(context?: AudioContext) {
    this.ownsContext = !context;
    this.context = context ?? new AudioContext({ latencyHint: "playback" });
    const ctx = this.context;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // A quiet, filtered noise bed avoids downloading an ambient loop and has
    // no abrupt seam. It is intentionally independent of route conditions.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    let previous = 0;
    for (let i = 0; i < samples.length; i++) {
      previous = (previous + Math.random() * 0.035 - 0.0175) / 1.015;
      samples[i] = previous;
    }
    this.wind = ctx.createBufferSource();
    this.wind.buffer = buffer;
    this.wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windFilter.frequency.value = 1100;
    this.wind.connect(this.windFilter).connect(this.master);
    this.wind.start();

    this.engine = ctx.createOscillator();
    this.engine.type = "triangle";
    this.engine.frequency.value = 48;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.035;
    this.engine.connect(this.engineGain).connect(this.master);
    this.engine.start();
  }

  async resume() {
    if (!this.closed) await this.context.resume();
  }

  update(
    sceneId: string | null,
    moving: boolean,
    ducked: boolean,
    hidden: boolean,
    volume = 0.32,
  ) {
    if (this.closed) return;
    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(
      hidden ? 0 : Math.max(0, Math.min(1, volume)) * (ducked ? 0.11 : 1),
      now,
      0.18,
    );
    this.engine.frequency.setTargetAtTime(moving ? 73 : 48, now, 0.65);
    this.engineGain.gain.setTargetAtTime(moving ? 0.065 : 0.035, now, 0.45);
    this.windFilter.frequency.setTargetAtTime(
      sceneId === "E3" ? 1550 : sceneId === "E2" ? 740 : 1100,
      now,
      1.4,
    );
  }

  radioCue() {
    if (this.closed || this.context.state !== "running") return;
    const ctx = this.context;
    const tone = ctx.createOscillator();
    const volume = ctx.createGain();
    const now = ctx.currentTime;
    tone.type = "sine";
    tone.frequency.setValueAtTime(640, now);
    tone.frequency.setValueAtTime(480, now + 0.09);
    volume.gain.setValueAtTime(0, now);
    volume.gain.linearRampToValueAtTime(0.07, now + 0.012);
    volume.gain.setValueAtTime(0.07, now + 0.12);
    volume.gain.linearRampToValueAtTime(0, now + 0.2);
    tone.connect(volume).connect(this.master);
    tone.start(now);
    tone.stop(now + 0.22);
    tone.onended = () => {
      tone.disconnect();
      volume.disconnect();
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.wind.stop();
    this.engine.stop();
    this.wind.disconnect();
    this.engine.disconnect();
    this.engineGain.disconnect();
    this.windFilter.disconnect();
    this.master.disconnect();
    if (this.ownsContext) void this.context.close().catch(() => {});
  }
}
