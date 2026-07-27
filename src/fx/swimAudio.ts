/**
 * Procedural swimming audio — no sample files. While the player is in the
 * water: a soft filtered-noise bed (surface lap / submerged hush) plus short
 * stroke splash bursts timed to the front-crawl cadence. Entry fires a one-shot
 * plunge. Rides the shared engine's effects bus, which applies the HUD level.
 */

import { effectsAudioLevel } from "../core/audioSettings";
import { audioEngine } from "../audio/engine";

export type SwimSignals = {
  swimming: boolean;
  /** Horizontal speed (m/s). */
  speed: number;
  /** Vertical speed (m/s), signed — dive / surface. */
  vspeed: number;
  /** 0 = head in air, 1 = fully under (fx/underwaterRig's eased submersion). */
  submersion?: number;
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
  #presence = 0;
  #ambLevel = 0;
  #strokePhase = 0;
  #wasSwimming = false;
  #entryCooldown = 0;
  #ambSource: AudioBufferSourceNode | null = null;
  #ambInput: AudioNode | null = null;
  #ambLfo: OscillatorNode | null = null;
  #ambLfoGain: GainNode | null = null;
  #idleSeconds = 0;
  #submersion = 0;
  #bubbleTimer = 0;

  get debugState() {
    return {
      ctx: this.#ctx?.state ?? "none",
      presence: +this.#presence.toFixed(3),
      ambienceRunning: this.#ambSource !== null,
      idleSeconds: +this.#idleSeconds.toFixed(2),
      submersion: +this.#submersion.toFixed(3)
    };
  }

  /** Per frame. Pass null (paused / frozen) to fade everything out. */
  update(dt: number, sig: SwimSignals | null) {
    const swimming = !!sig?.swimming;
    const audibleSwimming = swimming && effectsAudioLevel() > 0.0001;
    // A normal post-gesture walking frame should remain graph-free. Muted
    // swimming is tracked for edge semantics but also stays allocation-free.
    if (!this.#ctx && !audibleSwimming) {
      this.#wasSwimming = swimming;
      return;
    }
    const ctx = this.#ctx ?? this.#ensure();
    if (!ctx) return; // engine bus null until the first gesture
    if (audibleSwimming) {
      this.#idleSeconds = 0;
      this.#startAmbience(ctx);
    }

    // Cheap early-out: muted and already silent — synthesize nothing and let the
    // engine idle-suspend the shared ctx (no per-feature suspend anymore).
    if (effectsAudioLevel() <= 0.0001 && this.#presence <= 0.001) {
      this.#ambGain.gain.value = 0;
      this.#ambLevel = 0;
      this.#wasSwimming = swimming;
      this.#idleSeconds += Math.max(0, dt);
      if (this.#idleSeconds >= 3) this.#stopAmbience();
      return;
    }

    const want = audibleSwimming ? 1 : 0;
    this.#presence = approach(this.#presence, want, dt, audibleSwimming ? 3.5 : 5);
    // Continuous voice: keep the shared ctx alive while anything is audible.
    if (this.#presence > 0.001) audioEngine.touch();
    this.#entryCooldown = Math.max(0, this.#entryCooldown - dt);

    // plunge on the rising edge of swimming
    if (audibleSwimming && !this.#wasSwimming && this.#entryCooldown <= 0) {
      this.#plunge(ctx, Math.max(0.35, Math.min(1.2, Math.abs(sig?.vspeed ?? 0) * 0.18 + 0.55)));
      this.#entryCooldown = 0.45;
      this.#strokePhase = 0;
    }
    this.#wasSwimming = swimming;

    if (!sig || this.#presence < 0.001) {
      this.#ambGain.gain.value = 0;
      this.#ambLevel = 0;
      this.#idleSeconds += Math.max(0, dt);
      if (this.#idleSeconds >= 3) this.#stopAmbience();
      return;
    }

    const speed = sig.speed;
    const move = clamp01(speed / 3.2);
    const under = clamp01(sig.submersion ?? 0);
    this.#submersion = under;

    // Two beds in one filter. At the surface it is the bright slap and lap of
    // water against your ears; under it the world closes to a low pressurised
    // hush that gets *louder* and much darker, because sound is arriving
    // through your skull rather than your ear canal.
    const ambTarget = (0.045 + 0.09 * move + 0.075 * under) * this.#presence;
    this.#ambLevel = approach(this.#ambLevel, ambTarget, dt, 4);
    this.#ambGain.gain.value = this.#ambLevel;
    this.#ambFilter.frequency.value = (420 + 380 * move) * (1 - under * 0.72);

    // Strokes only while actually paddling. Submerged they lose the airy
    // splash-off-the-surface crack and become dull swirls.
    if (audibleSwimming && move > 0.12) {
      const rate = STROKE_RATE * (0.75 + move * 0.55) * (1 - under * 0.25);
      this.#strokePhase += dt * rate;
      while (this.#strokePhase >= STROKE_PHASE) {
        this.#strokePhase -= STROKE_PHASE;
        this.#stroke(ctx, 0.35 + move * 0.55 + Math.random() * 0.12, under);
      }
    } else {
      this.#strokePhase = 0;
    }

    // Breath bubbles: the one cue that says "under" even while holding still.
    if (audibleSwimming && under > 0.35) {
      this.#bubbleTimer -= dt * (0.55 + move * 0.9);
      if (this.#bubbleTimer <= 0) {
        this.#bubbleTimer = 0.7 + Math.random() * 1.5;
        this.#bubbles(ctx, under * (0.5 + Math.random() * 0.5));
      }
    } else {
      this.#bubbleTimer = 0.25;
    }
  }

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    const bus = audioEngine.bus("effects");
    if (!bus) return null; // null until first gesture — retry next update
    const { ctx, input } = bus;
    this.#ctx = ctx;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -18;
    limiter.knee.value = 22;
    limiter.ratio.value = 5;
    limiter.attack.value = 0.006;
    limiter.release.value = 0.28;
    limiter.connect(input);

    this.#master = ctx.createGain();
    this.#master.gain.value = 1; // constant trim; the engine group applies effectsAudioLevel()
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

    hp.connect(bp);
    bp.connect(this.#ambFilter);
    this.#ambFilter.connect(dest);
    this.#ambInput = hp;
    this.#startAmbience(ctx);
  }

  #startAmbience(ctx: AudioContext) {
    if (this.#ambSource || !this.#ambInput) return;
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;
    src.connect(this.#ambInput);
    src.start(0, Math.random() * Math.max(0.01, this.#noise.duration));
    this.#ambSource = src;

    // slow swell so the bed never feels static
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.11;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 70;
    lfo.connect(lfoG);
    lfoG.connect(this.#ambFilter.frequency);
    lfo.start();
    this.#ambLfo = lfo;
    this.#ambLfoGain = lfoG;
  }

  #stopAmbience() {
    try { this.#ambSource?.stop(); } catch { /* already stopped */ }
    try { this.#ambLfo?.stop(); } catch { /* already stopped */ }
    this.#ambSource?.disconnect();
    this.#ambLfo?.disconnect();
    this.#ambLfoGain?.disconnect();
    this.#ambSource = null;
    this.#ambLfo = null;
    this.#ambLfoGain = null;
  }

  /**
   * One arm-pull splash: brief noise body + soft mid thump. `under` (0..1)
   * slides it from a surface splash to a submerged swirl — same gesture, but
   * the crack of water thrown into air is gone and the pull gets longer.
   */
  #stroke(ctx: AudioContext, intensity: number, under = 0) {
    const t0 = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.22 * intensity * (1 - under * 0.4), t0 + 0.012 + under * 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18 + under * 0.16 + Math.random() * 0.06);
    g.connect(this.#strokeBus);

    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;
    // random offset so consecutive strokes don't phase-lock
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + 0.48);

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = (700 + Math.random() * 500) * (1 - under * 0.62);
    bp.Q.value = 0.9;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = (1600 + Math.random() * 600) * (1 - under * 0.7);

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

  /**
   * A short run of breath bubbles rising past your ears. Each bubble is a sine
   * whose pitch RISES as it goes — the classic bubble signature, since the
   * cavity shrinks as it climbs — with a whisper of noise for the burst.
   */
  #bubbles(ctx: AudioContext, intensity: number) {
    const t0 = ctx.currentTime;
    const count = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < count; i++) {
      const at = t0 + i * (0.035 + Math.random() * 0.075);
      const base = 240 + Math.random() * 520;
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(base, at);
      o.frequency.exponentialRampToValueAtTime(base * (1.7 + Math.random()), at + 0.06);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.035 * intensity * (0.6 + Math.random() * 0.7), at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0008, at + 0.075);
      o.connect(g);
      g.connect(this.#strokeBus);
      o.start(at);
      o.stop(at + 0.09);
    }
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
