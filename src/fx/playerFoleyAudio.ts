/**
 * Surface-aware on-foot foley.
 *
 * Heel/body/toe layers are synthesized per footfall so there is no repeating
 * sample. A separate filtered stereo bed fades in only while sprinting over the
 * map's grass surface class, giving foliage a continuous shoulder-height rustle
 * beneath the discrete steps.
 */

import type { GameplaySfxBus, GameplaySfxVoiceBus } from "../audio/gameplaySfxBus";

export type PlayerFoleySignals = {
  active: boolean;
  grounded: boolean;
  swimming: boolean;
  /** Horizontal metres per second. */
  speed: number;
  /** Player animation's stable walk-cycle phase. */
  stridePhase: number;
  /** surface.bin: 0 urban, 1 grass, 2 sand, 3 water, 4 road. */
  surfaceType: number;
  running: boolean;
  indoor: boolean;
};

type FootSurface = "stone" | "grass" | "sand";

const TAU = Math.PI * 2;
const STEP_PHASE = Math.PI;
const approach = (current: number, target: number, dt: number, rate: number) =>
  current + (target - current) * Math.min(1, dt * rate);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const classifySurface = (surfaceType: number): FootSurface =>
  surfaceType === 1 ? "grass" : surfaceType === 2 ? "sand" : "stone";

export class PlayerFoleyAudio {
  #bus: GameplaySfxBus;
  #lastPhase = 0;
  #phaseReady = false;
  #airborneFor = 0;
  #foot = 0;
  #stepEvents = 0;
  #lastSurface: FootSurface = "stone";
  #rustleSource: AudioBufferSourceNode | null = null;
  #rustleGain: GainNode | null = null;
  #rustleFilter: BiquadFilterNode | null = null;
  #rustleDrift: OscillatorNode | null = null;
  #rustleNodes: AudioNode[] = [];
  #rustleLevel = 0;

  constructor(bus: GameplaySfxBus) {
    this.#bus = bus;
  }

  get debugState() {
    return {
      ...this.#bus.debugState,
      stepEvents: this.#stepEvents,
      foot: this.#foot === 0 ? "left" : "right",
      surface: this.#lastSurface,
      rustle: +this.#rustleLevel.toFixed(3)
    };
  }

  update(dt: number, signals: PlayerFoleySignals | null): void {
    const locomoting = Boolean(
      signals?.active &&
      !signals.swimming &&
      signals.speed > 0.42
    );
    const moving = locomoting && Boolean(signals?.grounded);
    const surface = classifySurface(signals?.surfaceType ?? 0);
    this.#lastSurface = surface;

    if (locomoting && signals) {
      const phase = signals.stridePhase;
      if (!signals.grounded) {
        // Terrain contact can flicker for a frame on steep grass. Preserve the
        // visible-foot phase through that tiny gap, but re-prime after a real
        // jump so landing audio is not doubled by a stale footfall.
        this.#airborneFor += dt;
        if (this.#phaseReady) this.#lastPhase = phase;
        if (this.#airborneFor > 0.14) this.#phaseReady = false;
      } else if (!this.#phaseReady) {
        this.#airborneFor = 0;
        this.#lastPhase = phase;
        this.#phaseReady = true;
      } else {
        this.#airborneFor = 0;
        this.#emitCrossedSteps(this.#lastPhase, phase, signals, surface);
        this.#lastPhase = phase;
      }
    } else {
      this.#phaseReady = false;
      this.#airborneFor = 0;
    }

    const sprintingGrass = Boolean(
      moving && signals?.running && surface === "grass" && signals.speed > 5.8
    );
    const runAmount = sprintingGrass && signals
      ? clamp01((signals.speed - 5.4) / 7.2)
      : 0;
    const rustleTarget = sprintingGrass ? 0.045 + runAmount * 0.095 : 0;
    this.#rustleLevel = approach(
      this.#rustleLevel,
      rustleTarget,
      dt,
      rustleTarget > this.#rustleLevel ? 7.5 : 4.2
    );

    if (this.#rustleLevel > 0.0005) {
      const io = this.#bus.voiceBus(0.2);
      if (io) {
        this.#ensureRustle(io);
        if (this.#rustleGain && this.#rustleFilter) {
          const now = io.ctx.currentTime;
          this.#rustleGain.gain.setTargetAtTime(this.#rustleLevel, now, 0.045);
          this.#rustleFilter.frequency.setTargetAtTime(1050 + runAmount * 1050, now, 0.08);
        }
      }
    } else if (this.#rustleGain) {
      const ctx = this.#rustleGain.context;
      this.#rustleGain.gain.setTargetAtTime(0, ctx.currentTime, 0.055);
    }

    this.#bus.update(dt, this.#rustleLevel > 0.001);
  }

  dispose(): void {
    try {
      this.#rustleSource?.stop();
      this.#rustleDrift?.stop();
      for (const node of this.#rustleNodes) node.disconnect();
    } catch {
      // Audio nodes may already be released during HMR teardown.
    }
    this.#rustleSource = null;
    this.#rustleGain = null;
    this.#rustleFilter = null;
    this.#rustleDrift = null;
    this.#rustleNodes.length = 0;
  }

  #emitCrossedSteps(
    previous: number,
    next: number,
    signals: PlayerFoleySignals,
    surface: FootSurface
  ): void {
    // Player stride phase is monotonically increasing. Guard HMR/teleport jumps
    // so a discontinuity cannot dump a queue of stale footsteps at once.
    const delta = next - previous;
    if (delta < 0 || delta > TAU * 1.5) return;
    const firstBoundary = Math.floor(previous / STEP_PHASE) + 1;
    const lastBoundary = Math.floor(next / STEP_PHASE);
    const count = Math.min(2, Math.max(0, lastBoundary - firstBoundary + 1));
    for (let i = 0; i < count; i++) this.#step(signals, surface);
  }

  #step(signals: PlayerFoleySignals, surface: FootSurface): void {
    const foot = this.#foot;
    this.#foot = 1 - this.#foot;
    this.#stepEvents++;
    const io = this.#bus.voiceBus(surface === "sand" ? 0.42 : 0.28);
    if (!io || io.ctx.state !== "running") return;
    const ctx = io.ctx;
    const now = ctx.currentTime;
    const runAmount = clamp01((signals.speed - 4.2) / 7.5);
    const intensity = 0.72 + runAmount * 0.38;
    const variation = 0.88 + Math.random() * 0.24;
    const pan = (foot === 0 ? -1 : 1) * (0.055 + Math.random() * 0.035);

    const out = ctx.createGain();
    out.gain.value = intensity * variation;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    out.connect(panner).connect(io.dry);

    const roomSend = ctx.createGain();
    roomSend.gain.value = signals.indoor ? 0.22 : surface === "stone" ? 0.055 : 0.025;
    panner.connect(roomSend).connect(io.room);

    if (surface === "stone") this.#stoneStep(io, out, now, runAmount);
    else if (surface === "grass") this.#grassStep(io, out, now, runAmount);
    else this.#sandStep(io, out, now, runAmount);

    window.setTimeout(() => {
      try {
        out.disconnect();
        panner.disconnect();
        roomSend.disconnect();
      } catch {
        /* voice already collected */
      }
    }, 650);
  }

  #stoneStep(io: GameplaySfxVoiceBus, out: AudioNode, now: number, runAmount: number): void {
    const { ctx } = io;
    this.#noiseBurst(io, out, now, {
      peak: 0.17 + runAmount * 0.05,
      attack: 0.004,
      decay: 0.085,
      highpass: 410,
      lowpass: 2500 + Math.random() * 900,
      band: 760 + Math.random() * 430,
      q: 0.75
    });
    this.#noiseBurst(io, out, now + 0.006, {
      peak: 0.055 + runAmount * 0.025,
      attack: 0.001,
      decay: 0.035,
      highpass: 1900,
      lowpass: 6200,
      band: 3000 + Math.random() * 800,
      q: 0.5
    });
    this.#heel(ctx, out, now, 105 + Math.random() * 18, 61, 0.105, 0.085 + runAmount * 0.025);
  }

  #grassStep(io: GameplaySfxVoiceBus, out: AudioNode, now: number, runAmount: number): void {
    this.#noiseBurst(io, out, now, {
      peak: 0.16 + runAmount * 0.055,
      attack: 0.007,
      decay: 0.145 + Math.random() * 0.045,
      highpass: 180,
      lowpass: 2450 + runAmount * 550,
      band: 650 + Math.random() * 420,
      q: 0.52
    });
    // A delayed leaf-brush answers the heel, especially at sprint cadence.
    this.#noiseBurst(io, out, now + 0.025, {
      peak: 0.055 + runAmount * 0.055,
      attack: 0.012,
      decay: 0.19,
      highpass: 780,
      lowpass: 4300,
      band: 1700 + Math.random() * 650,
      q: 0.7
    });
    this.#heel(io.ctx, out, now, 86 + Math.random() * 12, 50, 0.12, 0.055 + runAmount * 0.018);
  }

  #sandStep(io: GameplaySfxVoiceBus, out: AudioNode, now: number, runAmount: number): void {
    this.#noiseBurst(io, out, now, {
      peak: 0.15 + runAmount * 0.04,
      attack: 0.012,
      decay: 0.23 + Math.random() * 0.055,
      highpass: 95,
      lowpass: 1450 + runAmount * 300,
      band: 380 + Math.random() * 250,
      q: 0.42
    });
    this.#heel(io.ctx, out, now + 0.006, 74 + Math.random() * 10, 44, 0.15, 0.042);
  }

  #noiseBurst(
    io: GameplaySfxVoiceBus,
    out: AudioNode,
    start: number,
    recipe: {
      peak: number;
      attack: number;
      decay: number;
      highpass: number;
      lowpass: number;
      band: number;
      q: number;
    }
  ): void {
    const { ctx } = io;
    const source = ctx.createBufferSource();
    source.buffer = io.noise;
    source.playbackRate.value = 0.91 + Math.random() * 0.19;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = recipe.highpass;
    hp.Q.value = 0.35;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = recipe.band;
    bp.Q.value = recipe.q;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = recipe.lowpass;
    lp.Q.value = 0.32;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(recipe.peak, start + recipe.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + recipe.decay);

    source.connect(hp).connect(bp).connect(lp).connect(gain).connect(out);
    source.start(start, Math.random() * Math.max(0.05, io.noise.duration - 0.35));
    source.stop(start + recipe.decay + 0.04);
  }

  #heel(
    ctx: AudioContext,
    out: AudioNode,
    start: number,
    fromHz: number,
    toHz: number,
    decay: number,
    peak: number
  ): void {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(fromHz, start);
    osc.frequency.exponentialRampToValueAtTime(toHz, start + decay);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + decay);
    osc.connect(gain).connect(out);
    osc.start(start);
    osc.stop(start + decay + 0.02);
  }

  #ensureRustle(io: GameplaySfxVoiceBus): void {
    if (this.#rustleSource) return;
    const { ctx } = io;
    const source = ctx.createBufferSource();
    source.buffer = io.noise;
    source.loop = true;
    source.loopEnd = io.noise.duration;
    source.playbackRate.value = 0.84;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 260;
    hp.Q.value = 0.35;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1350;
    bp.Q.value = 0.55;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3600;
    lp.Q.value = 0.25;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = ctx.createStereoPanner();

    // Subtle irregular side-to-side leaf motion keeps the bed alive without a
    // conspicuous tremolo. The stereo noise itself is already decorrelated.
    const drift = ctx.createOscillator();
    drift.type = "sine";
    drift.frequency.value = 0.61;
    const driftDepth = ctx.createGain();
    driftDepth.gain.value = 0.18;
    drift.connect(driftDepth).connect(pan.pan);

    source.connect(hp).connect(bp).connect(lp).connect(gain).connect(pan).connect(io.dry);
    const send = ctx.createGain();
    send.gain.value = 0.035;
    pan.connect(send).connect(io.room);
    source.start(0, Math.random() * io.noise.duration);
    drift.start();

    this.#rustleSource = source;
    this.#rustleGain = gain;
    this.#rustleFilter = bp;
    this.#rustleDrift = drift;
    this.#rustleNodes = [source, hp, bp, lp, gain, pan, drift, driftDepth, send];
  }
}
