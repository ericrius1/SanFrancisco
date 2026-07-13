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
import { BOARD_PITCHES, type BoardHum } from "../vehicles/board/config";

export type VehicleSignals = {
  mode: PlayerMode;
  speed: number; // m/s
  vspeed: number; // vertical m/s, signed
  boost: boolean;
  grounded: boolean; // board only — everything else passes true
  /** Surf-only proximity to the steep wave face/lip (0..1). */
  surfFace?: number;
  /** Local presentation-only surf flow envelope (0..1). */
  surfFlow?: number;
  /** Rider motion rate; world/audio clock itself remains unscaled. */
  surfMotionRate?: number;
  /** When mode is drive: combustion car vs electric cart (etc). */
  driveVoice?: "engine" | "electric";
};

type Voice = {
  mode: PlayerMode;
  gain: GainNode; // starts silent; update() drives it every frame
  level: number; // JS-side smoothed value mirrored into gain.gain
  /** Extra gate when several voices share a PlayerMode (drive engine vs EV). */
  when?: (sig: VehicleSignals) => boolean;
  /** Steer freqs/filters for this frame, return the target loudness. */
  drive(sig: VehicleSignals, dt: number): number;
};

const approach = (cur: number, target: number, dt: number, rate: number) =>
  cur + (target - cur) * Math.min(1, dt * rate);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * What the hoverboard customizer can voice. Tone/motion shape the oscillator
 * stack; thrust/air shape how that voice responds to riding. Thrust is neutral
 * at 50 so the authored stacks preserve their original speed response.
 */
export type BoardVoiceStyle = {
  hum: BoardHum;
  pitch: number;
  soundTone: number;
  soundMotion: number;
  soundThrust: number;
  soundAir: number;
};

type BoardRuntimeState = {
  response: number;
  detuneCents: number;
  cutoffHz: number;
  airGain: number;
};

// Each hum character is a 6-slot partial stack (type, freq multiple of the
// root, gain) plus a filter/LFO personality. Every stack keeps consonant
// ratios (octaves/fifths/thirds) with one barely-sharp partial for the
// electric shimmer beat, and every cutoff stays low enough that the +5
// semitone speed lift can never turn shrill.
type BoardStack = {
  parts: [OscillatorType, number, number][];
  cutoff: number;
  lfoRate: number;
  lfoDepth: number;
  level: number; // per-style loudness trim so switching never jumps volume
};

const BOARD_STACKS: Record<BoardHum, BoardStack> = {
  hum: {
    parts: [
      ["sine", 1, 1.0],
      ["sine", 1.5, 0.5],
      ["triangle", 2, 0.28],
      ["sine", 3, 0.15],
      ["sine", 4.012, 0.09],
      ["sine", 0.5, 0]
    ],
    cutoff: 300,
    lfoRate: 0.37,
    lfoDepth: 45,
    level: 1.0
  },
  crystal: {
    parts: [
      ["sine", 1, 0.6],
      ["sine", 2, 0.5],
      ["sine", 2.5, 0.3],
      ["triangle", 4, 0.16],
      ["sine", 6.01, 0.07],
      ["sine", 3, 0.12]
    ],
    cutoff: 520,
    lfoRate: 0.6,
    lfoDepth: 80,
    level: 0.95
  },
  deep: {
    parts: [
      ["sine", 0.5, 1.15],
      ["sine", 1, 0.6],
      ["triangle", 1.5, 0.18],
      ["sine", 2.004, 0.1],
      ["sine", 3, 0],
      ["sine", 4, 0]
    ],
    cutoff: 210,
    lfoRate: 0.22,
    lfoDepth: 26,
    level: 1.05
  },
  choir: {
    parts: [
      ["sawtooth", 1, 0.32],
      ["sawtooth", 1.006, 0.32],
      ["sine", 1.5, 0.3],
      ["sine", 2, 0.2],
      ["triangle", 3, 0.1],
      ["sine", 2.5, 0.12]
    ],
    cutoff: 360,
    lfoRate: 0.31,
    lfoDepth: 55,
    level: 0.9
  },
  retro: {
    parts: [
      ["square", 1, 0.28],
      ["square", 2, 0.12],
      ["triangle", 1.5, 0.24],
      ["sine", 0.5, 0.5],
      ["sine", 4.01, 0.05],
      ["sine", 3, 0]
    ],
    cutoff: 330,
    lfoRate: 0.5,
    lfoDepth: 70,
    level: 0.9
  }
};

const BOARD_PREVIEW_DUR = 1.9; // seconds of swell when auditioning in the customizer
// Reapplied styles during a drag hold the audition near its crest instead of
// restarting its attack on every pointermove.
const BOARD_PREVIEW_HOLD = 0.68;

export class VehicleAudio {
  #ctx: AudioContext | null = null;
  #master!: GainNode;
  #noise!: AudioBuffer;
  #voices: Voice[] = [];
  #masterLevel = 0;
  #boardStyle: BoardVoiceStyle = {
    hum: "hum",
    pitch: 0,
    soundTone: 50,
    soundMotion: 50,
    soundThrust: 50,
    soundAir: 30
  };
  #boardRuntime: BoardRuntimeState = { response: 0, detuneCents: 0, cutoffHz: 300, airGain: 0 };
  #applyBoardStyle: (() => void) | null = null; // bound once the voice exists
  #previewT: number | null = null; // seconds into a customizer audition swell
  #carLandingEvents = 0;
  #lastCarLandingStrength = 0;

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
      boardStyle: { ...this.#boardStyle },
      boardRuntime: { ...this.#boardRuntime },
      carLandingEvents: this.#carLandingEvents,
      lastCarLandingStrength: this.#lastCarLandingStrength,
      voices: this.#voices.map((v) => ({ mode: v.mode, level: v.level }))
    };
  }

  /**
   * Voice the hoverboard from the customizer config. Safe to call any time —
   * applied immediately if the audio graph exists, or on first unlock.
   */
  setBoardStyle(style: BoardVoiceStyle) {
    const macro = (value: number, fallback = 50) =>
      Number.isFinite(value) ? Math.round(clamp01(value / 100) * 100) : fallback;
    this.#boardStyle = {
      hum: BOARD_STACKS[style.hum] ? style.hum : "hum",
      pitch: Number.isFinite(style.pitch)
        ? Math.min(BOARD_PITCHES.length - 1, Math.max(0, Math.round(style.pitch)))
        : 0,
      soundTone: macro(style.soundTone),
      soundMotion: macro(style.soundMotion),
      soundThrust: macro(style.soundThrust),
      soundAir: macro(style.soundAir, 30)
    };
    this.#applyBoardStyle?.();
    if (this.#previewT !== null) this.#previewT = Math.min(this.#previewT, BOARD_PREVIEW_HOLD);
  }

  /**
   * Audition the current board voice (customizer click): a short speed + level
   * swell through the real voice path. While riding it layers onto the live
   * signal, so a sound edit still has an obvious audible response.
   */
  previewBoard() {
    const ctx = this.#ensure(); // UI click is a gesture, so this can unlock
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    this.#previewT = 0;
  }

  /** One-shot surf feedback through the existing FX mix and unlock policy. */
  surfEvent(kind: "carve" | "landing" | "wipeout" | "flow", strength = 1) {
    const ctx = this.#ensure();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const amount = clamp01(strength);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.connect(this.#master);

    if (kind === "flow") {
      // A small sea-glass chord: whimsical lift rather than sci-fi time warp.
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(1800, now);
      filter.frequency.exponentialRampToValueAtTime(620, now + 1.15);
      filter.connect(out);
      const notes = [220, 330, 440];
      for (let i = 0; i < notes.length; i++) {
        const tone = ctx.createOscillator();
        const voice = ctx.createGain();
        tone.type = i === 1 ? "triangle" : "sine";
        tone.frequency.setValueAtTime(notes[i], now);
        tone.frequency.exponentialRampToValueAtTime(notes[i] * 0.72, now + 1.2);
        voice.gain.value = 0.38 / (i + 1);
        tone.connect(voice).connect(filter);
        tone.start(now + i * 0.035);
        tone.stop(now + 1.28);
      }
      out.gain.exponentialRampToValueAtTime(0.16 + amount * 0.08, now + 0.025);
      out.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
      return;
    }

    if (kind === "landing") {
      const thump = ctx.createOscillator();
      thump.type = "sine";
      thump.frequency.setValueAtTime(92, now);
      thump.frequency.exponentialRampToValueAtTime(44, now + 0.24);
      thump.connect(out);
      out.gain.exponentialRampToValueAtTime(0.19 + amount * 0.16, now + 0.012);
      out.gain.exponentialRampToValueAtTime(0.0001, now + 0.31);
      thump.start(now);
      thump.stop(now + 0.34);
      return;
    }

    const src = ctx.createBufferSource();
    src.buffer = this.#noise;
    const filter = ctx.createBiquadFilter();
    filter.type = kind === "carve" ? "bandpass" : "lowpass";
    filter.frequency.value = kind === "carve" ? 1200 : 520;
    filter.Q.value = kind === "carve" ? 0.8 : 0.35;
    src.connect(filter);
    filter.connect(out);
    const duration = kind === "carve" ? 0.18 : 0.72;
    out.gain.exponentialRampToValueAtTime((kind === "carve" ? 0.1 : 0.23) + amount * 0.12, now + 0.015);
    out.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    src.start(now, Math.random() * 1.2, duration);
    src.stop(now + duration + 0.02);
  }

  /**
   * Car-to-road touchdown: a short filtered tyre/chassis slap over a low
   * suspension thump. Strength lowers the pitch, lengthens the tail, and raises
   * the transient; level is the car-folder authoring range chosen by main.
   */
  carLanding(strength: number, level = 1) {
    const ctx = this.#ensure();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    const amount = clamp01(strength);
    const trim = Math.max(0, Math.min(2, level));
    if (amount <= 0 || trim <= 0) return;
    this.#carLandingEvents += 1;
    this.#lastCarLandingStrength = amount;

    const now = ctx.currentTime;
    const duration = 0.2 + amount * 0.16;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime((0.11 + amount * 0.2) * trim, now + 0.009);
    out.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    out.connect(this.#master);

    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(94 - amount * 22, now);
    thump.frequency.exponentialRampToValueAtTime(40 - amount * 5, now + duration * 0.82);
    const thumpGain = ctx.createGain();
    thumpGain.gain.value = 0.72;
    thump.connect(thumpGain).connect(out);
    thump.start(now);
    thump.stop(now + duration + 0.02);

    const slap = ctx.createBufferSource();
    slap.buffer = this.#noise;
    const slapFilter = ctx.createBiquadFilter();
    slapFilter.type = "bandpass";
    slapFilter.frequency.value = 520 + (1 - amount) * 380;
    slapFilter.Q.value = 0.7;
    const slapGain = ctx.createGain();
    slapGain.gain.setValueAtTime(0.62 + amount * 0.18, now);
    slapGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075 + amount * 0.045);
    slap.connect(slapFilter).connect(slapGain).connect(out);
    slap.start(now, Math.random() * 1.4, 0.14);
    slap.stop(now + 0.15);
  }

  /** Per rendered frame. `sig` null (paused) fades every voice out. */
  update(dt: number, sig: VehicleSignals | null) {
    let boardPreviewEnv = 0;
    // customizer audition: impersonate a board run swelling 0→fast→0
    if (this.#previewT !== null) {
      this.#previewT += dt;
      if (this.#previewT >= BOARD_PREVIEW_DUR) {
        this.#previewT = null;
      } else {
        boardPreviewEnv = Math.sin((Math.PI * this.#previewT) / BOARD_PREVIEW_DUR);
        const previewSpeed = boardPreviewEnv * 24;
        if (sig?.mode === "board") {
          // Preserve the real ride, but guarantee a tonal lift even at idle.
          sig = { ...sig, speed: Math.max(sig.speed, previewSpeed) };
        } else {
          sig = { mode: "board", speed: previewSpeed, vspeed: 0, boost: false, grounded: true };
        }
      }
    }
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
      const active = !!(sig && sig.mode === v.mode && (!v.when || v.when(sig)));
      let target = active ? v.drive(sig!, dt) : 0;
      // The extra trim makes previewBoard read as an audition even when the
      // player is already moving faster than the synthetic preview signal.
      if (v.mode === "board") target = Math.min(1, target + boardPreviewEnv * 0.16);
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
      this.#buildSurf(ctx),
      this.#buildCar(ctx),
      this.#buildElectricCart(ctx),
      this.#buildPlane(ctx),
      this.#buildBoat(ctx),
      this.#buildDrone(ctx),
      this.#buildBird(ctx)
    ];
    for (const v of this.#voices) v.gain.connect(this.#master);
    return ctx;
  }

  /** Surfboard: two filtered-noise bands — rail hiss from speed and a deeper
   * breaker roar as the rider climbs into the pocket. */
  #buildSurf(ctx: AudioContext): Voice {
    const out = this.#out(ctx);
    const rail = this.#noiseInto(ctx, "bandpass", 820, 0.7, 0, out);
    const breaker = this.#noiseInto(ctx, "lowpass", 420, 0.35, 0, out);
    this.#lfo(ctx, 0.24, 0.035, breaker.gain.gain);
    return {
      mode: "surf",
      gain: out,
      level: 0,
      drive: (sig) => {
        const speed = clamp01(sig.speed / 30);
        const face = clamp01(sig.surfFace ?? 0);
        const flow = clamp01(sig.surfFlow ?? 0);
        const rate = THREE_MATH_SQRT_RATE(sig.surfMotionRate ?? 1);
        rail.filter.frequency.value = (680 + speed * 1250) * rate;
        rail.gain.gain.value = 0.08 + speed * 0.32;
        breaker.filter.frequency.value = (300 + face * 440) * rate;
        breaker.gain.gain.value = 0.08 + face * 0.48 + flow * 0.08;
        return 0.12 + speed * 0.22 + face * 0.3 + flow * 0.08;
      }
    };
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
   * Hoverboard: the low harmonious electric hum, now voiced by the customizer.
   * Six retunable oscillator slots under a breathing lowpass — a hum change
   * just rewrites types/freqs/gains and filter personality on the live nodes
   * (no rebuild, no click). Speed lifts the whole stack a few semitones
   * together, so whatever the voicing, it stays a chord.
   */
  #buildBoard(ctx: AudioContext): Voice {
    const out = this.#out(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 300;
    filter.Q.value = 0.9;
    filter.connect(out);

    // A single gentle air stream shares the board voice output. It stays in the
    // graph for the life of the AudioContext; the air macro only moves its
    // smoothed band-pass and gain, so live edits never rebuild or click.
    const air = this.#noiseInto(ctx, "bandpass", 620, 0.55, 0, out);

    // six generic slots; #applyBoardStyle re-voices them from BOARD_STACKS
    const slots = Array.from({ length: 6 }, () => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = 55;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g);
      g.connect(filter);
      o.start();
      return { o, g };
    });
    const filterLfo = ctx.createOscillator();
    filterLfo.frequency.value = 0.37;
    const filterLfoDepth = ctx.createGain();
    filterLfoDepth.gain.value = 45;
    filterLfo.connect(filterLfoDepth);
    filterLfoDepth.connect(filter.frequency);
    filterLfo.start();
    for (const s of slots) this.#lfo(ctx, 0.23, 4, s.o.detune); // faint organic pitch drift

    const state = {
      detune: 0,
      cutoff: 300,
      baseCutoff: 300,
      airGain: 0,
      airHz: 620,
      thrust: 0.5,
      airMix: 0.3,
      base: BOARD_STACKS.hum
    };
    const smooth = (param: AudioParam, value: number, timeConstant = 0.035) => {
      const now = ctx.currentTime;
      param.cancelScheduledValues(now);
      param.setTargetAtTime(value, now, timeConstant);
    };
    this.#applyBoardStyle = () => {
      const stack = BOARD_STACKS[this.#boardStyle.hum] ?? BOARD_STACKS.hum;
      const root = (BOARD_PITCHES[this.#boardStyle.pitch] ?? BOARD_PITCHES[0]).hz;
      const tone = this.#boardStyle.soundTone / 100;
      const motion = this.#boardStyle.soundMotion / 100;
      state.thrust = this.#boardStyle.soundThrust / 100;
      state.airMix = this.#boardStyle.soundAir / 100;
      // Neutral at 50: tone spans roughly 0.6×–1.7× cutoff and
      // 0.45×–1.55× upper-partial energy without changing wave types.
      const cutoffScale = Math.pow(2, (tone - 0.5) * 1.5);
      const richness = 0.45 + tone * 1.1;
      // Motion keeps each preset's personality while ranging from still to a
      // noticeably lively flutter. At 50 both values equal the authored stack.
      const motionRate = stack.lfoRate * Math.pow(6, motion - 0.5);
      const motionDepth = stack.lfoDepth * motion * 2;
      state.base = stack;
      state.baseCutoff = stack.cutoff * cutoffScale;
      for (let i = 0; i < slots.length; i++) {
        const [type, mul, gain] = stack.parts[i];
        slots[i].o.type = type;
        smooth(slots[i].o.frequency, root * mul, 0.025);
        smooth(slots[i].g.gain, gain * (mul >= 2 ? richness : 1));
      }
      smooth(filterLfo.frequency, motionRate, 0.05);
      smooth(filterLfoDepth.gain, motionDepth, 0.05);
    };
    this.#applyBoardStyle();

    return {
      mode: "board",
      gain: out,
      level: 0,
      drive: (sig, dt) => {
        const norm = clamp01(sig.speed / 40);
        const response = Math.pow(norm, 1.45 - state.thrust * 0.9);
        // At thrust=.5 these reduce exactly to the original 400-cent pitch
        // rise, 110-cent boost kick and 480 Hz speed-driven filter lift.
        const targetDetune = response * (180 + 440 * state.thrust) + (sig.boost ? 50 + 120 * state.thrust : 0);
        const targetCutoff =
          (sig.grounded ? state.baseCutoff : state.baseCutoff * 0.75) + response * (180 + 600 * state.thrust);
        state.detune = approach(state.detune, targetDetune, dt, 4);
        state.cutoff = approach(state.cutoff, targetCutoff, dt, 7);

        const airTarget = Math.min(
          0.07,
          (0.002 + 0.055 * Math.pow(state.airMix, 1.6)) *
            (0.22 + 0.78 * response) *
            (sig.grounded ? 1 : 1.22) *
            (sig.boost ? 1.15 : 1)
        );
        const airHzTarget = 420 + 650 * state.airMix + 450 * response;
        state.airGain = approach(state.airGain, airTarget, dt, 8);
        state.airHz = approach(state.airHz, airHzTarget, dt, 8);

        for (const s of slots) s.o.detune.value = state.detune;
        filter.frequency.value = state.cutoff;
        air.gain.gain.value = state.airGain;
        air.filter.frequency.value = state.airHz;
        this.#boardRuntime.response = response;
        this.#boardRuntime.detuneCents = state.detune;
        this.#boardRuntime.cutoffHz = state.cutoff;
        this.#boardRuntime.airGain = state.airGain;

        // Neutral thrust=.5 also preserves the former .4 grounded and .24
        // airborne speed-level slopes; the voice's outer gain smooths the result.
        const speedLevel = sig.grounded
          ? 0.25 + 0.3 * state.thrust
          : 0.15 + 0.18 * state.thrust;
        return ((sig.grounded ? 0.2 : 0.13) + response * speedLevel) * state.base.level;
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
      when: (sig) => sig.driveVoice !== "electric",
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

  /**
   * Electric golf cart: quiet idle hum + a rising motor whine (no combustion
   * rumble). Soft tire hiss on the path; pitch climbs with speed like a small EV.
   */
  #buildElectricCart(ctx: AudioContext): Voice {
    const out = this.#out(ctx);
    const motorLp = ctx.createBiquadFilter();
    motorLp.type = "lowpass";
    motorLp.frequency.value = 900;
    motorLp.Q.value = 0.85;
    motorLp.connect(out);
    // Controllers + inverter idle: soft low sine, always faintly present aboard.
    const idle = this.#oscInto(ctx, "sine", 72, 0.22, motorLp);
    // Motor whine: triangle fundamental + a faint fifth for that EV sheen.
    const whine = this.#oscInto(ctx, "triangle", 180, 0.34, motorLp);
    const sheen = this.#oscInto(ctx, "sine", 270, 0.12, motorLp);
    const tires = this.#noiseInto(ctx, "bandpass", 520, 0.7, 0, out);

    const s = { hz: 180 };
    return {
      mode: "drive",
      when: (sig) => sig.driveVoice === "electric",
      gain: out,
      level: 0,
      drive: (sig, dt) => {
        // Cart tops out ~half car speed, so normalize against ~25 m/s.
        const norm = clamp01(sig.speed / 25);
        s.hz = approach(s.hz, 160 + 420 * norm + (sig.boost ? 40 : 0), dt, 4.5);
        idle.frequency.value = 68 + 18 * norm;
        whine.frequency.value = s.hz;
        sheen.frequency.value = s.hz * 1.5;
        motorLp.frequency.value = 700 + 900 * norm;
        tires.filter.frequency.value = 480 + 420 * norm;
        tires.gain.gain.value = 0.04 + 0.22 * norm;
        // Quiet at rest (just the controller hum), then a clear whine under way.
        return 0.08 + 0.34 * norm + (sig.boost ? 0.04 : 0);
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

function THREE_MATH_SQRT_RATE(value: number): number {
  return Math.sqrt(Math.min(1, Math.max(0.18, Number.isFinite(value) ? value : 1)));
}
