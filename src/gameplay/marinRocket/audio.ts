import { audioEngine } from "../../audio/engine";
import type { RocketFlightTelemetry } from "../../vehicles/plane";

type RocketGraph = {
  ctx: AudioContext;
  low: OscillatorNode;
  high: OscillatorNode;
  noise: AudioBufferSourceNode;
  lowGain: GainNode;
  highGain: GainNode;
  noiseGain: GainNode;
  filter: BiquadFilterNode;
  releaseHold: () => void;
};

export class MarinRocketAudio {
  #graph: RocketGraph | null = null;

  begin(): void {
    this.stop();
    const bus = audioEngine.bus("effects", 3);
    if (!bus) return;
    const { ctx, input } = bus;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -20;
    limiter.ratio.value = 7;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.24;
    limiter.connect(input);

    const low = ctx.createOscillator();
    low.type = "sawtooth";
    low.frequency.value = 38;
    const high = ctx.createOscillator();
    high.type = "triangle";
    high.frequency.value = 76;
    const lowGain = ctx.createGain();
    const highGain = ctx.createGain();
    lowGain.gain.value = 0;
    highGain.gain.value = 0;
    low.connect(lowGain).connect(limiter);
    high.connect(highGain).connect(limiter);

    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 1.4), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      brown = brown * 0.98 + (Math.random() * 2 - 1) * 0.06;
      data[i] = brown;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 540;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    noise.connect(filter).connect(noiseGain).connect(limiter);
    low.start();
    high.start();
    noise.start();
    this.#graph = {
      ctx,
      low,
      high,
      noise,
      lowGain,
      highGain,
      noiseGain,
      filter,
      releaseHold: audioEngine.acquireHold()
    };
  }

  update(telemetry: Readonly<RocketFlightTelemetry>): void {
    const graph = this.#graph;
    if (!graph) return;
    const now = graph.ctx.currentTime;
    const thrust = Math.min(1, telemetry.throttle + (telemetry.boost ? 0.22 : 0));
    const vacuum = telemetry.spaceFactor;
    graph.low.frequency.setTargetAtTime(34 + thrust * 32 + telemetry.speed * 0.012, now, 0.08);
    graph.high.frequency.setTargetAtTime(72 + thrust * 68 + telemetry.speed * 0.025, now, 0.08);
    graph.lowGain.gain.setTargetAtTime(0.045 + thrust * 0.07, now, 0.08);
    graph.highGain.gain.setTargetAtTime(0.015 + thrust * 0.035, now, 0.08);
    graph.noiseGain.gain.setTargetAtTime((0.035 + thrust * 0.07) * (1 - vacuum * 0.82), now, 0.1);
    graph.filter.frequency.setTargetAtTime(420 + thrust * 1_450, now, 0.1);
  }

  milestone(index: number): void {
    const bus = audioEngine.bus("effects", 1.1);
    if (!bus) return;
    const { ctx, input } = bus;
    const now = ctx.currentTime + 0.01;
    [1, 1.5, 2].forEach((ratio, i) => {
      const tone = ctx.createOscillator();
      tone.type = "sine";
      tone.frequency.value = (310 + index * 55) * ratio;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now + i * 0.045);
      gain.gain.exponentialRampToValueAtTime(0.055 / (i + 1), now + i * 0.045 + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.62);
      tone.connect(gain).connect(input);
      tone.start(now + i * 0.045);
      tone.stop(now + 0.66);
    });
  }

  stop(): void {
    const graph = this.#graph;
    this.#graph = null;
    if (!graph) return;
    try { graph.low.stop(); } catch {}
    try { graph.high.stop(); } catch {}
    try { graph.noise.stop(); } catch {}
    graph.low.disconnect();
    graph.high.disconnect();
    graph.noise.disconnect();
    graph.lowGain.disconnect();
    graph.highGain.disconnect();
    graph.noiseGain.disconnect();
    graph.filter.disconnect();
    graph.releaseHold();
  }

  dispose(): void {
    this.stop();
  }
}

