import { audioEngine } from "../../audio/engine";

type FlightGraph = {
  ctx: AudioContext;
  wind: AudioBufferSourceNode;
  windGain: GainNode;
  windFilter: BiquadFilterNode;
  vario: OscillatorNode;
  varioGain: GainNode;
  releaseHold: () => void;
};

export class HangGlidingAudio {
  #graph: FlightGraph | null = null;

  begin(): void {
    this.stop();
    const bus = audioEngine.bus("effects", 1.2);
    if (!bus) return;
    const { ctx, input } = bus;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -18;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.22;
    limiter.connect(input);

    const windBuffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 1.7), ctx.sampleRate);
    const data = windBuffer.getChannelData(0);
    let pink = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      pink = pink * 0.965 + white * 0.035;
      data[i] = white * 0.42 + pink * 2.1;
    }
    const wind = ctx.createBufferSource();
    wind.buffer = windBuffer;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 980;
    windFilter.Q.value = 0.5;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    wind.connect(windFilter).connect(windGain).connect(limiter);

    // A near-silent sine becomes an airy variometer tone only in rising air.
    const vario = ctx.createOscillator();
    vario.type = "sine";
    vario.frequency.value = 560;
    const varioGain = ctx.createGain();
    varioGain.gain.value = 0;
    vario.connect(varioGain).connect(limiter);
    const now = ctx.currentTime;
    wind.start(now);
    vario.start(now);
    this.#graph = { ctx, wind, windGain, windFilter, vario, varioGain, releaseHold: audioEngine.acquireHold() };
  }

  update(airspeed: number, verticalSpeed: number, lift: number): void {
    const graph = this.#graph;
    if (!graph) return;
    const now = graph.ctx.currentTime;
    const speed = Math.min(1, Math.max(0, (airspeed - 8) / 34));
    graph.windGain.gain.setTargetAtTime(0.035 + speed * 0.105, now, 0.08);
    graph.windFilter.frequency.setTargetAtTime(620 + speed * 1900, now, 0.1);
    const rising = Math.max(0, Math.min(1, verticalSpeed / 4.5 + lift * 0.07));
    graph.vario.frequency.setTargetAtTime(520 + rising * 460, now, 0.07);
    graph.varioGain.gain.setTargetAtTime(rising * 0.018, now, 0.06);
  }

  gate(index: number): void {
    const bus = audioEngine.bus("effects", 1.2);
    if (!bus) return;
    const { ctx, input } = bus;
    const now = ctx.currentTime + 0.01;
    for (let i = 0; i < 2; i++) {
      const oscillator = ctx.createOscillator();
      oscillator.type = "triangle";
      oscillator.frequency.value = (440 + index * 42) * (i === 0 ? 1 : 1.5);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(i === 0 ? 0.11 : 0.07, now + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.46);
      oscillator.connect(gain).connect(input);
      oscillator.start(now + i * 0.055);
      oscillator.stop(now + 0.5);
    }
  }

  finish(success: boolean): void {
    const bus = audioEngine.bus("effects", 1.8);
    if (bus) {
      const { ctx, input } = bus;
      const now = ctx.currentTime + 0.02;
      const notes = success ? [392, 523.25, 659.25] : [330, 277, 220];
      notes.forEach((frequency, index) => {
        const oscillator = ctx.createOscillator();
        oscillator.type = success ? "triangle" : "sine";
        oscillator.frequency.value = frequency;
        const gain = ctx.createGain();
        const at = now + index * 0.13;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.09, at + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.72);
        oscillator.connect(gain).connect(input);
        oscillator.start(at);
        oscillator.stop(at + 0.76);
      });
    }
    this.stop();
  }

  stop(): void {
    const graph = this.#graph;
    this.#graph = null;
    if (!graph) return;
    try { graph.wind.stop(); } catch {}
    try { graph.vario.stop(); } catch {}
    graph.wind.disconnect();
    graph.vario.disconnect();
    graph.windGain.disconnect();
    graph.windFilter.disconnect();
    graph.varioGain.disconnect();
    graph.releaseHold();
  }

  dispose(): void {
    this.stop();
  }
}
