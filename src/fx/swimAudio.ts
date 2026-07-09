/**
 * Procedural swimming audio — no sample files. While the player is in the
 * water: a soft filtered-noise bed (surface lap / submerged hush) plus short
 * stroke splash bursts timed to the front-crawl cadence. Entry fires a one-shot
 * plunge. Everything lives on one AudioContext and respects effectsAudioLevel().
 */

import { effectsAudioLevel } from "../core/audioSettings";

export type SwimSignals = {
  swimming: boolean;
  /** Horizontal speed (m/s). */
  speed: number;
  /** Vertical speed (m/s), signed — dive / surface. */
  vspeed: number;
};

const approach = (cur: number, target: number, dt: number, rate: number) =>
  cur + (target - cur) * Math.min(1, dt * rate);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Matches poseSwim stride advance (`#strideT += dt * 3.4`). */
const STROKE_RATE = 3.4;
/** One arm pull per π of stride phase (arms are π out of phase). */
const STROKE_PHASE = Math.PI;

export class SwimAudio {
  #ctx: AudioContext | null = null;
  #master!: GainNode;
  #ambGain!: GainNode;
  #ambFilter!: BiquadFilterNode;
  #strokeBus!: GainNode;
  #noise!: AudioBuffer;
  #masterLevel = 0;
  #presence = 0;
  #ambLevel = 0;
  #strokePhase = 0;
  #wasSwimming = false;
  #entryCooldown = 0;

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

  /** Per frame. Pass null (paused / frozen) to fade everything out. */
  update(dt: number, sig: SwimSignals | null) {
    const ctx = this.#ctx;
    if (!ctx) return;

    const swimming = !!sig?.swimming;
    const targetMaster = effectsAudioLevel();
    if (targetMaster <= 0.0001 && this.#masterLevel <= 0.001 && this.#presence <= 0.001) {
      if (ctx.state === "running") {
        this.#master.gain.value = 0;
        this.#masterLevel = 0;
        this.#ambGain.gain.value = 0;
        void ctx.suspend();
      }
      this.#wasSwimming = swimming;
      return;
    }
    if (ctx.state === "suspended") void ctx.resume();
    if (ctx.state !== "running") return;

    this.#masterLevel = approach(this.#masterLevel, targetMaster, dt, 6);
    this.#master.gain.value = this.#masterLevel;

    const want = swimming ? 1 : 0;
    this.#presence = approach(this.#presence, want, dt, swimming ? 3.5 : 5);
    this.#entryCooldown = Math.max(0, this.#entryCooldown - dt);

    // plunge on the rising edge of swimming
    if (swimming && !this.#wasSwimming && this.#entryCooldown <= 0) {
      this.#plunge(ctx, Math.max(0.35, Math.min(1.2, Math.abs(sig?.vspeed ?? 0) * 0.18 + 0.55)));
      this.#entryCooldown = 0.45;
      this.#strokePhase = 0;
    }
    this.#wasSwimming = swimming;

    if (!sig || this.#presence < 0.001) {
      this.#ambGain.gain.value = 0;
      this.#ambLevel = 0;
      return;
    }

    const speed = sig.speed;
    const move = clamp01(speed / 3.2);
    // idle bob is quieter; stroking opens the bed and brightens it a touch
    const ambTarget = (0.045 + 0.09 * move) * this.#presence;
    this.#ambLevel = approach(this.#ambLevel, ambTarget, dt, 4);
    this.#ambGain.gain.value = this.#ambLevel;
    this.#ambFilter.frequency.value = 420 + 380 * move;

    // stroke splashes only while actually paddling
    if (swimming && move > 0.12) {
      const rate = STROKE_RATE * (0.75 + move * 0.55);
      this.#strokePhase += dt * rate;
      while (this.#strokePhase >= STROKE_PHASE) {
        this.#strokePhase -= STROKE_PHASE;
        this.#stroke(ctx, 0.35 + move * 0.55 + Math.random() * 0.12);
      }
    } else {
      this.#strokePhase = 0;
    }
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
    limiter.attack.value = 0.006;
    limiter.release.value = 0.28;
    limiter.connect(ctx.destination);

    this.#master = ctx.createGain();
    this.#master.gain.value = 0;
    this.#master.connect(limiter);

    // 2s white noise, shared by ambience + one-shots
    const sr = ctx.sampleRate;
    this.#noise = ctx.createBuffer(1, sr * 2, sr);
    const n = this.#noise.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;

    this.#ambGain = ctx.createGain();
    this.#ambGain.gain.value = 0;
    this.#ambGain.connect(this.#master);
    this.#buildAmbience(ctx, this.#ambGain);

    this.#strokeBus = ctx.createGain();
    this.#strokeBus.gain.value = 0.85;
    this.#strokeBus.connect(this.#master);

    return ctx;
  }

  /** Soft surface lap / submerged hush — bandpassed noise with a slow breath. */
  #buildAmbience(ctx: AudioContext, dest: AudioNode) {
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 180;
    hp.Q.value = 0.5;

    this.#ambFilter = ctx.createBiquadFilter();
    this.#ambFilter.type = "lowpass";
    this.#ambFilter.frequency.value = 520;
    this.#ambFilter.Q.value = 0.7;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 340;
    bp.Q.value = 0.55;

    src.connect(hp);
    hp.connect(bp);
    bp.connect(this.#ambFilter);
    this.#ambFilter.connect(dest);
    src.start();

    // slow swell so the bed never feels static
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.11;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 70;
    lfo.connect(lfoG);
    lfoG.connect(this.#ambFilter.frequency);
    lfo.start();
  }

  /** One arm-pull splash: brief noise body + soft mid thump. */
  #stroke(ctx: AudioContext, intensity: number) {
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.22 * intensity, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18 + Math.random() * 0.06);
    g.connect(this.#strokeBus);

    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;
    // random offset so consecutive strokes don't phase-lock
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + 0.28);

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 700 + Math.random() * 500;
    bp.Q.value = 0.9;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1600 + Math.random() * 600;

    src.connect(bp);
    bp.connect(lp);
    lp.connect(g);

    // soft water "thup" under the splash
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(95 + Math.random() * 40, t0);
    o.frequency.exponentialRampToValueAtTime(55, t0 + 0.09);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t0);
    og.gain.linearRampToValueAtTime(0.07 * intensity, t0 + 0.008);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.11);
    o.connect(og);
    og.connect(this.#strokeBus);
    o.start(t0);
    o.stop(t0 + 0.14);
  }

  /** Water-entry plunge — bigger, darker splash. */
  #plunge(ctx: AudioContext, intensity: number) {
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.38 * intensity, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
    g.connect(this.#strokeBus);

    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;
    src.start(t0, Math.random());
    src.stop(t0 + 0.65);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2200, t0);
    lp.frequency.exponentialRampToValueAtTime(480, t0 + 0.4);

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 90;

    src.connect(hp);
    hp.connect(lp);
    lp.connect(g);

    // sub thump
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(70, t0);
    o.frequency.exponentialRampToValueAtTime(32, t0 + 0.22);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t0);
    og.gain.linearRampToValueAtTime(0.16 * intensity, t0 + 0.015);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.28);
    o.connect(og);
    og.connect(this.#strokeBus);
    o.start(t0);
    o.stop(t0 + 0.32);
  }
}
