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

export type RocketAudioTargets = {
  lowFrequency: number;
  bodyFrequency: number;
  lowGain: number;
  bodyGain: number;
  noiseGain: number;
  filterFrequency: number;
};

export function rocketAudioTargets(
  telemetry: Readonly<RocketFlightTelemetry>
): RocketAudioTargets {
  const thrust = Math.min(1, telemetry.throttle + (telemetry.boost ? 0.18 : 0));
  const vacuum = telemetry.spaceFactor;
  const speedTone = Math.min(1, telemetry.speed / 5_200);
  return {
    lowFrequency: 25 + thrust * 11 + speedTone * 4,
    bodyFrequency: 50 + thrust * 15 + speedTone * 5,
    lowGain: 0.062 + thrust * 0.052,
    bodyGain: 0.006 + thrust * 0.008,
    noiseGain: (0.008 + thrust * 0.018) * (1 - vacuum * 0.94),
    filterFrequency: 180 + thrust * 260
  };
}

export class MarinRocketAudio {
  #graph: RocketGraph | null = null;

  begin(): void {
    this.stop();
    const bus = audioEngine.bus("effects", 3);
    if (!bus) return;
    const { ctx, input } = bus;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -16;
    limiter.ratio.value = 3;
    limiter.attack.value = 0.02;
    limiter.release.value = 0.32;
    limiter.connect(input);

    const low = ctx.createOscillator();
    low.type = "sine";
    low.frequency.value = 28;
    const high = ctx.createOscillator();
    high.type = "sine";
    high.frequency.value = 56;
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
    filter.frequency.value = 220;
    filter.Q.value = 0.68;
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
    const targets = rocketAudioTargets(telemetry);
    graph.low.frequency.setTargetAtTime(targets.lowFrequency, now, 0.16);
    graph.high.frequency.setTargetAtTime(targets.bodyFrequency, now, 0.18);
    graph.lowGain.gain.setTargetAtTime(targets.lowGain, now, 0.14);
    graph.highGain.gain.setTargetAtTime(targets.bodyGain, now, 0.18);
    graph.noiseGain.gain.setTargetAtTime(targets.noiseGain, now, 0.2);
    graph.filter.frequency.setTargetAtTime(targets.filterFrequency, now, 0.2);
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
