import { NATURE_AUDIO_TUNING, type NatureSoundscape } from "../../audio/natureSoundscape";

/**
 * Archery one-shots on the shared nature soundscape (dogPark.ts model): no
 * AudioContext of our own — the layer rides voiceBus()'s always-on effects
 * bus, so HUD volume/mute, gesture unlock and the limiter stay the single
 * source of truth. Every event is spatialised at its world position through
 * a short-lived panner (a few per second at most; they self-dispose).
 */

type NatureVoiceIO = NonNullable<ReturnType<NatureSoundscape["voiceBus"]>>;

const LAYER_GAIN = 0.6;
const EPS = 0.0001;

export class ArcheryAudio {
  #nature: NatureSoundscape;
  #io: NatureVoiceIO | null = null;
  #layer: GainNode | null = null;
  #awake = false;
  #releaseNatureHold: (() => void) | null = null;

  constructor(nature: NatureSoundscape) {
    this.#nature = nature;
  }

  /** Site-awake follower: keeps the shared always-bus alive while the range
   *  is hot, releases it (fading our layer) when the player leaves. */
  setAwake(on: boolean): void {
    if (this.#awake === on) return;
    this.#awake = on;
    if (on) this.#releaseNatureHold ??= this.#nature.acquireExternalHold("archery");
    else {
      this.#releaseNatureHold?.();
      this.#releaseNatureHold = null;
    }
    const io = this.#io;
    if (!on && io && this.#layer) this.#layer.gain.setTargetAtTime(0, io.ctx.currentTime, 0.15);
  }

  dispose(): void {
    this.setAwake(false);
    this.#layer?.disconnect();
    this.#layer = null;
  }

  #ready(): NatureVoiceIO | null {
    if (!this.#awake) return null;
    const io = (this.#io ??= this.#nature.voiceBus());
    if (!io || io.ctx.state !== "running") return null;
    if (!this.#layer) {
      this.#layer = io.ctx.createGain();
      this.#layer.gain.value = 0;
      this.#layer.connect(io.alwaysBus);
    }
    this.#layer.gain.setTargetAtTime(LAYER_GAIN, io.ctx.currentTime, 0.1);
    return io;
  }

  /** One panner per event, torn down when the last source ends. */
  #panner(io: NatureVoiceIO, x: number, y: number, z: number, lifeSeconds: number): PannerNode {
    const p = io.ctx.createPanner();
    p.panningModel = "HRTF";
    p.distanceModel = "inverse";
    p.refDistance = 5;
    p.rolloffFactor = 1.2;
    p.maxDistance = 80;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
    p.connect(this.#layer!);
    const send = io.ctx.createGain();
    send.gain.value = 0.3 * Number(NATURE_AUDIO_TUNING.values.reverb);
    p.connect(send).connect(io.effectsReverbSend);
    setTimeout(() => {
      p.disconnect();
      send.disconnect();
    }, (lifeSeconds + 0.4) * 1000);
    return p;
  }

  #level(base: number): number {
    return Number(NATURE_AUDIO_TUNING.values.voices) * base;
  }

  /** Draw creak: a filtered noise swell + low ratchet ticks riding the pull.
   *  `dur` should match the expected draw time. */
  drawCreak(x: number, y: number, z: number, dur = 1.1, quiet = false): void {
    const io = this.#ready();
    if (!io) return;
    const t = io.ctx.currentTime;
    const out = this.#panner(io, x, y, z, dur);
    const lvl = this.#level(quiet ? 0.05 : 0.11);

    const src = io.ctx.createBufferSource();
    src.buffer = io.noise;
    src.loop = true;
    const lp = io.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(240, t);
    lp.frequency.linearRampToValueAtTime(680, t + dur);
    lp.Q.value = 2.2;
    const g = io.ctx.createGain();
    g.gain.setValueAtTime(EPS, t);
    g.gain.exponentialRampToValueAtTime(lvl, t + dur * 0.85);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur + 0.12);
    src.connect(lp).connect(g).connect(out);
    src.start(t);
    src.stop(t + dur + 0.2);
    // ratchet ticks: a handful of short bright taps spread over the pull
    const ticks = 5;
    for (let i = 0; i < ticks; i++) {
      const tt = t + dur * (0.15 + (i / ticks) * 0.8) + Math.random() * 0.03;
      const tick = io.ctx.createBufferSource();
      tick.buffer = io.noise;
      const bp = io.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 900 + i * 160;
      bp.Q.value = 6;
      const tg = io.ctx.createGain();
      tg.gain.setValueAtTime(lvl * 1.4, tt);
      tg.gain.exponentialRampToValueAtTime(EPS, tt + 0.035);
      tick.connect(bp).connect(tg).connect(out);
      tick.start(tt, Math.random());
      tick.stop(tt + 0.06);
    }
  }

  /** Release: string twang (damped ~180 Hz pluck + burst) and arrow whoosh. */
  loose(x: number, y: number, z: number, power = 1, quiet = false): void {
    const io = this.#ready();
    if (!io) return;
    const t = io.ctx.currentTime;
    const out = this.#panner(io, x, y, z, 0.7);
    const lvl = this.#level(quiet ? 0.09 : 0.2);

    // twang: plucked damped sine with a fast pitch sag
    const osc = io.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(196, t);
    osc.frequency.exponentialRampToValueAtTime(164, t + 0.16);
    const og = io.ctx.createGain();
    og.gain.setValueAtTime(lvl, t);
    og.gain.exponentialRampToValueAtTime(EPS, t + 0.28);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.32);
    // release burst
    const burst = io.ctx.createBufferSource();
    burst.buffer = io.noise;
    const hp = io.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1400;
    const bg = io.ctx.createGain();
    bg.gain.setValueAtTime(lvl * 0.8, t);
    bg.gain.exponentialRampToValueAtTime(EPS, t + 0.06);
    burst.connect(hp).connect(bg).connect(out);
    burst.start(t, Math.random());
    burst.stop(t + 0.1);
    // whoosh: fast bandpass sweep chasing the arrow out
    const wh = io.ctx.createBufferSource();
    wh.buffer = io.noise;
    const bp = io.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(2400, t);
    bp.frequency.exponentialRampToValueAtTime(500, t + 0.32);
    const wg = io.ctx.createGain();
    wg.gain.setValueAtTime(lvl * (0.35 + power * 0.4), t + 0.01);
    wg.gain.exponentialRampToValueAtTime(EPS, t + 0.34);
    wh.connect(bp).connect(wg).connect(out);
    wh.start(t, Math.random());
    wh.stop(t + 0.4);
  }

  /** Arrow burying in straw: a dull thud with a short fibrous rustle. */
  thunk(x: number, y: number, z: number, quiet = false): void {
    const io = this.#ready();
    if (!io) return;
    const t = io.ctx.currentTime;
    const out = this.#panner(io, x, y, z, 0.4);
    const lvl = this.#level(quiet ? 0.1 : 0.24);
    const osc = io.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(62, t + 0.12);
    const og = io.ctx.createGain();
    og.gain.setValueAtTime(lvl, t);
    og.gain.exponentialRampToValueAtTime(EPS, t + 0.18);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.2);
    const rustle = io.ctx.createBufferSource();
    rustle.buffer = io.noise;
    const lp = io.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    const rg = io.ctx.createGain();
    rg.gain.setValueAtTime(lvl * 0.5, t);
    rg.gain.exponentialRampToValueAtTime(EPS, t + 0.1);
    rustle.connect(lp).connect(rg).connect(out);
    rustle.start(t, Math.random());
    rustle.stop(t + 0.14);
  }

  /** Arrow cracking into wood/dirt: short bright snap. */
  crack(x: number, y: number, z: number, quiet = false): void {
    const io = this.#ready();
    if (!io) return;
    const t = io.ctx.currentTime;
    const out = this.#panner(io, x, y, z, 0.3);
    const lvl = this.#level(quiet ? 0.07 : 0.16);
    const snap = io.ctx.createBufferSource();
    snap.buffer = io.noise;
    const bp = io.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2100;
    bp.Q.value = 1.1;
    const g = io.ctx.createGain();
    g.gain.setValueAtTime(lvl, t);
    g.gain.exponentialRampToValueAtTime(EPS, t + 0.07);
    snap.connect(bp).connect(g).connect(out);
    snap.start(t, Math.random());
    snap.stop(t + 0.1);
  }

  /** Score chime, brighter and fuller the better the ring (10 = gold). */
  chime(ring: number, x: number, y: number, z: number): void {
    const io = this.#ready();
    if (!io) return;
    const t = io.ctx.currentTime + 0.06;
    const out = this.#panner(io, x, y, z, 0.9);
    const lvl = this.#level(0.07 + (ring / 10) * 0.09);
    const base = 523 + ring * 44; // higher rings sing higher
    const notes = ring >= 10 ? [1, 1.25, 1.5] : ring >= 6 ? [1, 1.25] : [1];
    notes.forEach((mult, i) => {
      const osc = io.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = base * mult;
      const g = io.ctx.createGain();
      const at = t + i * 0.07;
      g.gain.setValueAtTime(EPS, at);
      g.gain.exponentialRampToValueAtTime(lvl, at + 0.015);
      g.gain.exponentialRampToValueAtTime(EPS, at + 0.5);
      osc.connect(g).connect(out);
      osc.start(at);
      osc.stop(at + 0.55);
    });
  }
}
