/**
 * Procedural match audio for the Quidditch pitch — no sample files. Every cue
 * is synthesized on a shared AudioContext and gated by the HUD effects slider:
 *
 *   whistle()   — referee's pea whistle, kicks off / ends a match
 *   goal()      — brass goal horn + a swell of crowd roar (10-point score)
 *   snitch()    — shimmering catch fanfare + big crowd roar (150 + win)
 *   bludger()   — leathery THWACK when a bludger clobbers a rider
 *   cheer(level) — bed of crowd noise, level 0..1 scales the size of the swell
 *
 * Kept deliberately punchy and short so rapid goals don't smear together.
 */

import { effectsAudioLevel } from "../core/audioSettings";

export class QuidditchAudio {
  #ctx: AudioContext | null = null;
  #master!: GainNode;
  #noise!: AudioBuffer;

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

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    if (typeof AudioContext === "undefined") return null;
    const ctx = new AudioContext();
    this.#ctx = ctx;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 16;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);
    this.#master = ctx.createGain();
    this.#master.connect(limiter);

    const sr = ctx.sampleRate;
    this.#noise = ctx.createBuffer(1, sr * 2, sr);
    const n = this.#noise.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
    return ctx;
  }

  #gate(): { ctx: AudioContext; g: number } | null {
    const level = effectsAudioLevel();
    if (level <= 0) return null;
    const ctx = this.#ensure();
    if (!ctx || ctx.state !== "running") return null;
    return { ctx, g: level };
  }

  /** Referee whistle: a shrill sine with a fluttering warble, two short blasts. */
  whistle() {
    const gate = this.#gate();
    if (!gate) return;
    const { ctx, g } = gate;
    const now = ctx.currentTime;
    for (const [start, len] of [[0, 0.16], [0.22, 0.34]] as const) {
      const t0 = now + start;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(2350, t0);
      // pea rattle: fast vibrato via a second oscillator on the frequency param
      const warble = ctx.createOscillator();
      warble.type = "sine";
      warble.frequency.value = 32;
      const warbleG = ctx.createGain();
      warbleG.gain.value = 120;
      warble.connect(warbleG);
      warbleG.connect(osc.frequency);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(0.32 * g, t0 + 0.02);
      env.gain.setValueAtTime(0.32 * g, t0 + len - 0.04);
      env.gain.exponentialRampToValueAtTime(0.001, t0 + len);
      osc.connect(env);
      env.connect(this.#master);
      osc.start(t0);
      osc.stop(t0 + len + 0.02);
      warble.start(t0);
      warble.stop(t0 + len + 0.02);
    }
  }

  /** Goal horn: a fat detuned brass triad, plus a crowd swell. */
  goal() {
    const gate = this.#gate();
    if (!gate) return;
    const { ctx, g } = gate;
    const now = ctx.currentTime;
    const freqs = [196, 246.9, 293.7]; // G3 major-ish stab
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(0.5 * g, now + 0.02);
    out.gain.setValueAtTime(0.5 * g, now + 0.42);
    out.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    out.connect(this.#master);
    for (const f of freqs) {
      for (const det of [-4, 4]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f + det;
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.setValueAtTime(900, now);
        lp.frequency.linearRampToValueAtTime(2400, now + 0.12);
        const vg = ctx.createGain();
        vg.gain.value = 0.14;
        o.connect(lp);
        lp.connect(vg);
        vg.connect(out);
        o.start(now);
        o.stop(now + 0.95);
      }
    }
    this.cheer(0.7);
  }

  /** Snitch caught: rising bell arpeggio + a stadium-shaking roar. */
  snitch() {
    const gate = this.#gate();
    if (!gate) return;
    const { ctx, g } = gate;
    const now = ctx.currentTime;
    const notes = [659, 784, 988, 1319, 1568]; // E5 G5 B5 E6 G6
    notes.forEach((f, i) => {
      const t0 = now + i * 0.09;
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      const o2 = ctx.createOscillator();
      o2.type = "sine";
      o2.frequency.value = f * 2;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(0.28 * g, t0 + 0.01);
      env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.7);
      const h = ctx.createGain();
      h.gain.value = 0.4;
      o.connect(env);
      o2.connect(h);
      h.connect(env);
      env.connect(this.#master);
      o.start(t0);
      o.stop(t0 + 0.75);
      o2.start(t0);
      o2.stop(t0 + 0.75);
    });
    this.cheer(1);
  }

  /** Leathery thwack — a bludger connecting with a rider (or a beater's bat). */
  bludger() {
    const gate = this.#gate();
    if (!gate) return;
    const { ctx, g } = gate;
    const now = ctx.currentTime;
    // body: pitched noise burst through a bandpass, snappy attack
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(320, now);
    bp.frequency.exponentialRampToValueAtTime(120, now + 0.12);
    bp.Q.value = 1.1;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.6 * g, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    src.connect(bp);
    bp.connect(env);
    env.connect(this.#master);
    src.start(now, Math.random() * 1.5, 0.2);
    // sub thump for weight
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(140, now);
    sub.frequency.exponentialRampToValueAtTime(55, now + 0.12);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.5 * g, now);
    sg.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    sub.connect(sg);
    sg.connect(this.#master);
    sub.start(now);
    sub.stop(now + 0.2);
  }

  /** Crowd roar: filtered noise swell whose length/brightness scales with level. */
  cheer(level = 0.6) {
    const gate = this.#gate();
    if (!gate) return;
    const { ctx, g } = gate;
    const now = ctx.currentTime;
    const dur = 0.9 + level * 1.6;
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 700 + level * 900;
    bp.Q.value = 0.5;
    // shimmer: slow amplitude wobble so the roar breathes like a real crowd
    const wob = ctx.createOscillator();
    wob.type = "sine";
    wob.frequency.value = 6 + level * 4;
    const wobG = ctx.createGain();
    wobG.gain.value = 0.12;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime((0.18 + level * 0.22) * g, now + 0.25);
    env.gain.setValueAtTime((0.14 + level * 0.2) * g, now + dur * 0.5);
    env.gain.exponentialRampToValueAtTime(0.001, now + dur);
    wob.connect(wobG);
    wobG.connect(env.gain);
    src.connect(bp);
    bp.connect(env);
    env.connect(this.#master);
    src.start(now, Math.random());
    src.stop(now + dur + 0.05);
    wob.start(now);
    wob.stop(now + dur + 0.05);
  }
}
