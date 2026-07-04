/**
 * Procedural vehicle audio — no sample files. Each mode gets a small synth
 * voice (an oscillator stack and/or filtered noise) that idles near-silent and
 * swells + pitches with speed. Everything is built once on one AudioContext;
 * mode switches crossfade the voice gains so nothing clicks.
 *
 * The mix is deliberately gentle: low fundamentals, lowpassed tops, and a soft
 * limiter on the master. The hoverboard is the flagship — a harmonious
 * electric hum (root + fifth + octave on A, with a barely-sharp partial for a
 * slow shimmer beat) breathing through a slow filter LFO.
 */

import type { PlayerMode } from "../player/types";
import { effectsAudioLevel } from "../core/audioSettings";

export type VehicleSignals = {
  mode: PlayerMode;
  speed: number; // m/s
  vspeed: number; // vertical m/s, signed
  boost: boolean;
  grounded: boolean; // board only — everything else passes true
};

type Voice = {
  mode: PlayerMode;
  gain: GainNode; // starts silent; update() drives it every frame
  level: number; // JS-side smoothed value mirrored into gain.gain
  /** Steer freqs/filters for this frame, return the target loudness. */
  drive(sig: VehicleSignals, dt: number): number;
};

const approach = (cur: number, target: number, dt: number, rate: number) =>
  cur + (target - cur) * Math.min(1, dt * rate);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class VehicleAudio {
  #ctx: AudioContext | null = null;
  #master!: GainNode;
  #noise!: AudioBuffer;
  #voices: Voice[] = [];
  #masterLevel = 0;

  constructor() {
    // autoplay policy: same unlock dance as the fireworks — build + resume on
    // the first gesture (the click into pointer lock counts)
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

  /** Headless-verify/tuning peek: context state + smoothed levels. */
  get debugState() {
    return {
      ctx: this.#ctx?.state ?? "none",
      master: this.#masterLevel,
      voices: this.#voices.map((v) => ({ mode: v.mode, level: v.level }))
    };
  }

  /** Per rendered frame. `sig` null (paused) fades every voice out. */
  update(dt: number, sig: VehicleSignals | null) {
    const ctx = this.#ctx;
    if (!ctx) return; // not unlocked yet
    const targetMaster = effectsAudioLevel();
    // muted and already faded: park the whole graph, it costs nothing
    if (targetMaster <= 0.0001 && this.#masterLevel <= 0.001) {
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
    for (const v of this.#voices) {
      const target = sig && sig.mode === v.mode ? v.drive(sig, dt) : 0;
      v.level = approach(v.level, target, dt, 4.5);
      v.gain.gain.value = v.level;
    }
  }

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    if (typeof AudioContext === "undefined") return null;
    const ctx = new AudioContext();
    this.#ctx = ctx;

    // master: gain -> soft limiter -> out (keeps stacked partials polite)
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -16;
    limiter.knee.value = 20;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.3;
    limiter.connect(ctx.destination);
    this.#master = ctx.createGain();
    this.#master.gain.value = 0;
    this.#master.connect(limiter);

    // 2s of white noise, looped by every noise layer at random offsets
    const sr = ctx.sampleRate;
    this.#noise = ctx.createBuffer(1, sr * 2, sr);
    const n = this.#noise.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;

    this.#voices = [
      this.#buildBoard(ctx),
      this.#buildCar(ctx),
      this.#buildPlane(ctx),
      this.#buildBoat(ctx),
      this.#buildDrone(ctx),
      this.#buildBird(ctx)
    ];
    for (const v of this.#voices) v.gain.connect(this.#master);
    return ctx;
  }

  /** Voice output gain, born silent. */
  #out(ctx: AudioContext): GainNode {
    const g = ctx.createGain();
    g.gain.value = 0;
    return g;
  }

  #oscInto(ctx: AudioContext, type: OscillatorType, freq: number, gain: number, dest: AudioNode) {
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

  #noiseInto(ctx: AudioContext, filterType: BiquadFilterType, freq: number, q: number, gain: number, dest: AudioNode) {
    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(0, Math.random() * 1.5);
    return { filter: f, gain: g };
  }

  /** A sine LFO leaning on an AudioParam (adds to its .value). */
  #lfo(ctx: AudioContext, freq: number, depth: number, param: AudioParam) {
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g);
    g.connect(param);
    o.start();
  }

  /**
   * Hoverboard: the low harmonious electric hum. A-rooted stack (A1 root,
   * E2 fifth, A2 octave, E3, and a barely-sharp near-A3 whose beat against the
   * octave reads as electric shimmer), all under a breathing lowpass. Speed
   * lifts the whole stack a few semitones together, so it stays a chord.
   */
  #buildBoard(ctx: AudioContext): Voice {
    const out = this.#out(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 300;
    filter.Q.value = 0.9;
    filter.connect(out);

    const stack: [OscillatorType, number, number][] = [
      ["sine", 55, 1.0],
      ["sine", 82.41, 0.5],
      ["triangle", 110, 0.28],
      ["sine", 164.81, 0.15],
      ["sine", 220.7, 0.09]
    ];
    const oscs = stack.map(([type, f, g]) => this.#oscInto(ctx, type, f, g, filter));
    this.#lfo(ctx, 0.37, 45, filter.frequency); // slow breathing so the hum never sits still
    for (const o of oscs) this.#lfo(ctx, 0.23, 4, o.detune); // faint organic pitch drift

    const s = { detune: 0, cutoff: 300 };
    return {
      mode: "board",
      gain: out,
      level: 0,
      drive: (sig, dt) => {
        const norm = clamp01(sig.speed / 40);
        // +4 semitones flat out, +1 more on boost — audible lift, never a whine
        s.detune = approach(s.detune, norm * 400 + (sig.boost ? 110 : 0), dt, 4);
        s.cutoff = approach(s.cutoff, (sig.grounded ? 300 : 220) + 480 * norm, dt, 4);
        for (const o of oscs) o.detune.value = s.detune;
        filter.frequency.value = s.cutoff;
        return sig.grounded ? 0.2 + 0.4 * norm : 0.13 + 0.24 * norm;
      }
    };
  }

  /** Car: a soft engine purr — saw fundamental + sub sine tracking speed, plus road-noise hiss. */
  #buildCar(ctx: AudioContext): Voice {
    const out = this.#out(ctx);
    const engineLp = ctx.createBiquadFilter();
    engineLp.type = "lowpass";
    engineLp.frequency.value = 260;
    engineLp.Q.value = 0.7;
    engineLp.connect(out);
    const saw = this.#oscInto(ctx, "sawtooth", 44, 0.4, engineLp);
    const sub = this.#oscInto(ctx, "sine", 22, 0.55, engineLp);
    const road = this.#noiseInto(ctx, "lowpass", 480, 0.6, 0, out);

    const s = { rpm: 44 };
    return {
      mode: "drive",
      gain: out,
      level: 0,
      drive: (sig, dt) => {
        const norm = clamp01(sig.speed / 50);
        s.rpm = approach(s.rpm, 44 + 78 * norm + (sig.boost ? 16 : 0), dt, 3.5);
        saw.frequency.value = s.rpm;
        sub.frequency.value = s.rpm / 2;
        engineLp.frequency.value = 260 + 300 * norm;
        road.gain.gain.value = 0.3 * norm;
        return 0.16 + 0.38 * norm + (sig.boost ? 0.05 : 0);
      }
    };
  }

  /** Plane: a low prop drone plus wind rushing past the canopy. */
  #buildPlane(ctx: AudioContext): Voice {
    const out = this.#out(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    lp.Q.value = 0.7;
    lp.connect(out);
    const prop = this.#oscInto(ctx, "sawtooth", 58, 0.38, lp);
    const harm = this.#oscInto(ctx, "triangle", 116, 0.22, lp);
    const wind = this.#noiseInto(ctx, "bandpass", 380, 0.5, 0.08, out);

    const s = { hz: 58 };
    return {
      mode: "plane",
      gain: out,
      level: 0,
      drive: (sig, dt) => {
        const norm = clamp01(sig.speed / 120);
        s.hz = approach(s.hz, 58 + 62 * norm + (sig.boost ? 10 : 0), dt, 3);
        prop.frequency.value = s.hz;
        harm.frequency.value = s.hz * 2;
        lp.frequency.value = 420 + 800 * norm;
        wind.filter.frequency.value = 380 + 1100 * norm;
        wind.gain.gain.value = 0.08 + 0.38 * norm;
        return 0.14 + 0.42 * norm;
      }
    };
  }

  /** Boat: lapping water (slow-LFO'd noise) over a faint hull tone; spray band rises with speed. */
  #buildBoat(ctx: AudioContext): Voice {
    const out = this.#out(ctx);
    this.#oscInto(ctx, "sine", 46, 0.3, out);
    const water = this.#noiseInto(ctx, "lowpass", 420, 0.6, 0.4, out);
    this.#lfo(ctx, 0.28, 0.16, water.gain.gain); // waves against the hull
    const spray = this.#noiseInto(ctx, "bandpass", 850, 0.8, 0, out);

    return {
      mode: "boat",
      gain: out,
      level: 0,
      drive: (sig) => {
        const norm = clamp01(sig.speed / 20);
        spray.gain.gain.value = 0.34 * norm;
        water.filter.frequency.value = 420 + 260 * norm;
        return 0.16 + 0.32 * norm;
      }
    };
  }

  /** Drone: two detuned rotors beating softly under a shallow tremolo — buzzy but rounded. */
  #buildDrone(ctx: AudioContext): Voice {
    const out = this.#out(ctx);
    const trem = ctx.createGain();
    trem.gain.value = 0.8;
    this.#lfo(ctx, 26, 0.18, trem.gain); // rotor flicker
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 950;
    lp.Q.value = 0.6;
    lp.connect(trem);
    trem.connect(out);
    const rotorA = this.#oscInto(ctx, "triangle", 148, 0.38, lp);
    const rotorB = this.#oscInto(ctx, "triangle", 151.5, 0.38, lp); // 3.5Hz beat
    const harm = this.#oscInto(ctx, "triangle", 296, 0.1, lp);

    const s = { detune: 0 };
    return {
      mode: "drone",
      gain: out,
      level: 0,
      drive: (sig, dt) => {
        // rotors spin up with travel speed and with climbing
        const thrust = clamp01(sig.speed / 50 + Math.max(0, sig.vspeed) / 14);
        s.detune = approach(s.detune, 420 * thrust + (sig.boost ? 90 : 0), dt, 4);
        rotorA.detune.value = s.detune;
        rotorB.detune.value = s.detune;
        harm.detune.value = s.detune;
        return 0.11 + 0.28 * thrust;
      }
    };
  }

  /** Bird: nothing but wind — near-silent gliding, swelling into a rush when stooping. */
  #buildBird(ctx: AudioContext): Voice {
    const out = this.#out(ctx);
    const rush = this.#noiseInto(ctx, "bandpass", 320, 0.55, 0.34, out);
    const body = this.#noiseInto(ctx, "lowpass", 220, 0.6, 0, out);

    return {
      mode: "bird",
      gain: out,
      level: 0,
      drive: (sig) => {
        const norm = clamp01(sig.speed / 50);
        const swell = norm * norm; // quadratic: quiet cruise, dramatic dive
        rush.filter.frequency.value = 320 + 900 * swell;
        body.gain.gain.value = 0.26 * swell; // low-end weight under the rush
        return swell * 0.38;
      }
    };
  }
}
