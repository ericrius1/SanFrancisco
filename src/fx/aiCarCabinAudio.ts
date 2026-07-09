/**
 * Cabin audio for riding shotgun in a self-driving AI training car.
 *
 * Two layers, both procedural (no sample files):
 *   • chill ambient — soft pad chord with slow filter breathing
 *   • electric hum  — A-rooted sine stack (same family as the hoverboard),
 *                     pitched gently with car speed
 *
 * Crossfades in when boarded, out when you hop out. Respects the HUD
 * effects volume / mute via effectsAudioLevel().
 */

import { effectsAudioLevel } from "../core/audioSettings";

const approach = (cur: number, target: number, dt: number, rate: number) =>
  cur + (target - cur) * Math.min(1, dt * rate);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class AiCarCabinAudio {
  #ctx: AudioContext | null = null;
  #master!: GainNode;
  #ambientGain!: GainNode;
  #humGain!: GainNode;
  #humOscs: OscillatorNode[] = [];
  #humFilter!: BiquadFilterNode;
  #masterLevel = 0;
  #presence = 0; // 0..1 boarded crossfade
  #humDetune = 0;
  #active = false;

  constructor() {
    const unlock = () => {
      const ctx = this.#ensure();
      if (ctx && ctx.state === "suspended") void ctx.resume();
      if (ctx && ctx.state === "running") {
        window.removeEventListener("pointerdown", unlock);
        window.removeEventListener("keydown", unlock);
      }
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }

  /** Per frame. Pass null (or active:false) to fade the cabin out. */
  update(dt: number, sig: { active: boolean; speed: number } | null) {
    const ctx = this.#ctx;
    if (!ctx) return;
    this.#active = !!sig?.active;
    const targetMaster = effectsAudioLevel();
    if (targetMaster <= 0.0001 && this.#masterLevel <= 0.001 && this.#presence <= 0.001) {
      if (ctx.state === "running") {
        this.#master.gain.value = 0;
        this.#masterLevel = 0;
        void ctx.suspend();
      }
      return;
    }
    if (ctx.state === "suspended") void ctx.resume();
    if (ctx.state !== "running") return;

    this.#masterLevel = approach(this.#masterLevel, targetMaster, dt, 6);
    this.#master.gain.value = this.#masterLevel;

    const want = this.#active ? 1 : 0;
    this.#presence = approach(this.#presence, want, dt, this.#active ? 2.2 : 3.5);
    const p = this.#presence;
    // ambient sits under everything; hum swells a little with speed
    this.#ambientGain.gain.value = 0.22 * p;
    const norm = clamp01((sig?.speed ?? 0) / 28);
    this.#humDetune = approach(this.#humDetune, norm * 280, dt, 3);
    for (const o of this.#humOscs) o.detune.value = this.#humDetune;
    this.#humFilter.frequency.value = 280 + 220 * norm;
    this.#humGain.gain.value = (0.1 + 0.14 * norm) * p;
  }

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    if (typeof AudioContext === "undefined") return null;
    const ctx = new AudioContext();
    this.#ctx = ctx;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -18;
    limiter.knee.value = 22;
    limiter.ratio.value = 5;
    limiter.attack.value = 0.008;
    limiter.release.value = 0.35;
    limiter.connect(ctx.destination);

    this.#master = ctx.createGain();
    this.#master.gain.value = 0;
    this.#master.connect(limiter);

    this.#ambientGain = ctx.createGain();
    this.#ambientGain.gain.value = 0;
    this.#ambientGain.connect(this.#master);
    this.#buildAmbient(ctx, this.#ambientGain);

    this.#humGain = ctx.createGain();
    this.#humGain.gain.value = 0;
    this.#humGain.connect(this.#master);
    this.#buildHum(ctx, this.#humGain);

    return ctx;
  }

  /** Soft chill pad: Cmaj7-ish open voicing under a breathing lowpass. */
  #buildAmbient(ctx: AudioContext, dest: AudioNode) {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 520;
    filter.Q.value = 0.7;
    filter.connect(dest);
    this.#lfo(ctx, 0.08, 90, filter.frequency);

    // C3 · E3 · G3 · B3 · soft high fifth — warm, unhurried
    const partials: [OscillatorType, number, number][] = [
      ["sine", 130.81, 0.55],
      ["triangle", 164.81, 0.28],
      ["sine", 196.0, 0.32],
      ["sine", 246.94, 0.18],
      ["sine", 392.0, 0.07]
    ];
    for (const [type, f, g] of partials) {
      const o = this.#osc(ctx, type, f, g, filter);
      this.#lfo(ctx, 0.11 + f * 0.00005, 3.5, o.detune);
    }
  }

  /** Subtle electric drivetrain hum — A-rooted stack, quieter than the board. */
  #buildHum(ctx: AudioContext, dest: AudioNode) {
    this.#humFilter = ctx.createBiquadFilter();
    this.#humFilter.type = "lowpass";
    this.#humFilter.frequency.value = 280;
    this.#humFilter.Q.value = 0.85;
    this.#humFilter.connect(dest);
    this.#lfo(ctx, 0.31, 35, this.#humFilter.frequency);

    const stack: [OscillatorType, number, number][] = [
      ["sine", 55, 1.0],
      ["sine", 82.41, 0.45],
      ["triangle", 110, 0.22],
      ["sine", 164.81, 0.1]
    ];
    for (const [type, f, g] of stack) {
      const o = this.#osc(ctx, type, f, g, this.#humFilter);
      this.#lfo(ctx, 0.19, 3, o.detune);
      this.#humOscs.push(o);
    }
  }

  #osc(ctx: AudioContext, type: OscillatorType, freq: number, gain: number, dest: AudioNode): OscillatorNode {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = gain;
    o.connect(g);
    g.connect(dest);
    o.start();
    return o;
  }

  #lfo(ctx: AudioContext, rate: number, depth: number, param: AudioParam) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = rate;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g);
    g.connect(param);
    o.start();
  }
}
