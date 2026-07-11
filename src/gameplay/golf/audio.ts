import { effectsAudioLevel } from "../../core/audioSettings";

/**
 * Golf one-shots, all synthesized (no assets): the downswing whoosh, the
 * strike "thwack", a soft turf thud on landing and the cup rattle when a putt
 * drops. Same lazy-AudioContext pattern as the chimes — the swing itself is a
 * user gesture, so resume() always succeeds.
 */
export class GolfAudio {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #noise: AudioBuffer | null = null;

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    if (typeof AudioContext === "undefined") return null;
    this.#ctx = new AudioContext();
    const limiter = this.#ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.ratio.value = 5;
    limiter.connect(this.#ctx.destination);
    this.#master = this.#ctx.createGain();
    this.#master.gain.value = 0.9;
    this.#master.connect(limiter);
    const sr = this.#ctx.sampleRate;
    this.#noise = this.#ctx.createBuffer(1, sr, sr);
    const d = this.#noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return this.#ctx;
  }

  #ready(): AudioContext | null {
    if (effectsAudioLevel() <= 0) return null;
    const ctx = this.#ensure();
    if (!ctx || !this.#master || !this.#noise) return null;
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  }

  /** Downswing air-cut: a bandpassed noise sweep that swells into the strike.
   *  `peakIn` seconds = time until impact (pose crossing s=0). */
  whoosh(power: number, peakIn: number) {
    const ctx = this.#ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const master = effectsAudioLevel();
    const dur = Math.max(0.28, peakIn + 0.16);

    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(240, t);
    // the sweep accelerates like the club: slow rise, whip through impact
    bp.frequency.exponentialRampToValueAtTime(900 + power * 1500, t + Math.max(0.05, peakIn));
    bp.frequency.exponentialRampToValueAtTime(500, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime((0.16 + power * 0.3) * master, t + Math.max(0.05, peakIn));
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(bp).connect(g).connect(this.#master!);
    src.start(t);
    src.stop(t + dur + 0.05);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      g.disconnect();
    };
  }

  /** Contact. Full shots crack; putts get a soft wooden tap. */
  thwack(power: number, putter: boolean) {
    const ctx = this.#ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const master = effectsAudioLevel();
    const out = ctx.createGain();
    out.gain.value = master;
    out.connect(this.#master!);

    if (putter) {
      // tock: short mid knock, tiny noise tick
      this.#knock(ctx, out, 620, 0.05, 0.5 + power * 0.3);
      this.#tick(ctx, out, 2400, 0.018, 0.25);
      return;
    }
    const p = Math.max(0.25, power);
    // click transient (the "crack" of the face)
    this.#tick(ctx, out, 3400, 0.02, 0.5 * p);
    // body knock — fast pitch drop reads as compression
    this.#knock(ctx, out, 950, 0.06, 0.85 * p);
    // low thump for the "satisfying" weight
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(62, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * p, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.16);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
    };
  }

  /** Soft turf thud when the ball comes down (heavier the faster it lands). */
  landThud(speed: number) {
    const ctx = this.#ready();
    if (!ctx) return;
    const k = Math.min(1, speed / 30);
    if (k < 0.12) return;
    const master = effectsAudioLevel();
    const out = ctx.createGain();
    out.gain.value = master * 0.5 * k;
    out.connect(this.#master!);
    this.#knock(ctx, out, 220, 0.08, 1);
    this.#tick(ctx, out, 900, 0.03, 0.4);
  }

  /** Ball rattling into the cup — two knocks and a little plastic shimmer. */
  holed() {
    const ctx = this.#ready();
    if (!ctx) return;
    const master = effectsAudioLevel();
    const out = ctx.createGain();
    out.gain.value = master * 0.7;
    out.connect(this.#master!);
    this.#knock(ctx, out, 1350, 0.04, 0.5, 0);
    this.#knock(ctx, out, 1100, 0.05, 0.65, 0.07);
    this.#knock(ctx, out, 880, 0.09, 0.8, 0.15);
  }

  /** Damped resonant knock at `hz`, optional start delay. */
  #knock(ctx: AudioContext, out: GainNode, hz: number, dur: number, amp: number, delay = 0) {
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(hz, t);
    o.frequency.exponentialRampToValueAtTime(hz * 0.72, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur * 2.4);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur * 2.4 + 0.05);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
    };
  }

  /** Very short highpassed noise click. */
  #tick(ctx: AudioContext, out: GainNode, hz: number, dur: number, amp: number) {
    if (!this.#noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(hp).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
    src.onended = () => {
      src.disconnect();
      hp.disconnect();
      g.disconnect();
    };
  }
}
