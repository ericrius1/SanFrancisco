// Low register — four ways to sit under the chord.
//
// One rule shapes all of them: the bass owns everything below ~120 Hz and
// nothing else in the score does, so these voices stay narrow and centred.
// Reverb down here is mud, so the sends are near zero and `sub` has none at
// all. `upright` and `tape` are high-passed at 35 Hz because a pluck transient
// and a tanh curve both make subsonic rubbish, and the master compressor would
// otherwise duck the entire mix for energy nobody can hear.
//
// Deliberately no imports beyond the voice contract, so the two noise helpers
// below are a small duplicate of the ones in pads.ts rather than shared.

import {
  midiToFreq,
  ramp,
  voiceOutput,
  type BassVoiceId,
  type Voice,
  type VoiceCtx
} from "../voiceTypes";

/* ----------------------------------------------------------------- shared */

/** Bass only ever needs noise for transients, so the bed stays short. */
const NOISE_SECONDS = 1;
/** RMS of uniform noise on [-1,1] — used to size band-limited makeup gains. */
const NOISE_RMS = 0.5774;

const NOISE_CACHE = new WeakMap<BaseAudioContext, AudioBuffer>();

/** Fixed-seed bit noise: the bed is a context-lifetime constant, and drawing
 *  50k samples from `v.rng()` would derail every later draw depending on which
 *  note allocated it first. */
function seededNoise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function noiseBed(ctx: BaseAudioContext): AudioBuffer {
  const cached = NOISE_CACHE.get(ctx);
  if (cached) return cached;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rnd = seededNoise(0x1f0c0de);
  for (let i = 0; i < frames; i++) data[i] = rnd() * 2 - 1;
  NOISE_CACHE.set(ctx, buffer);
  return buffer;
}

function noiseSource(v: VoiceCtx, t: number, stopAt: number): AudioBufferSourceNode {
  const bed = noiseBed(v.ctx);
  const src = v.ctx.createBufferSource();
  src.buffer = bed;
  src.loop = true;
  src.start(t, v.rng() * bed.duration);
  src.stop(stopAt);
  return src;
}

/** Makeup for noise through a 2nd-order bandpass, from its equivalent noise
 *  bandwidth — otherwise the body thump would be a different instrument on a
 *  44.1 kHz device than on a 48 kHz one. */
function bandNoiseGain(
  ctx: BaseAudioContext,
  hz: number,
  q: number,
  targetRms: number
): number {
  const enbw = (Math.PI / 2) * (hz / Math.max(0.5, q));
  const passed = NOISE_RMS * Math.sqrt(Math.min(1, enbw / (ctx.sampleRate * 0.5)));
  return Math.min(80, targetRms / Math.max(1e-5, passed));
}

/* ------------------------------------------------------------------- sub */

/** The original: one sine, felt rather than heard. The 1.2 s swell is what
 *  keeps it from thumping in a score with no drums to hide a thump. */
const sub: Voice = (v, n) => {
  const { ctx } = v;
  const f = midiToFreq(n.midi);
  const stopAt = n.t + n.dur + 5;

  const out = ctx.createGain();
  out.gain.value = 1;
  voiceOutput(v, out, 0, 0);

  const osc = ctx.createOscillator();
  osc.frequency.value = f;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, n.t);
  g.gain.linearRampToValueAtTime(Math.max(0.0002, n.vel), n.t + 1.2);
  g.gain.setTargetAtTime(0.0001, n.t + n.dur * 0.85, 1.2);
  osc.connect(g).connect(out);
  osc.start(n.t);
  osc.stop(stopAt);

  // a pure sine vanishes in a busy daytime mix; one quiet octave gives the ear
  // something to track without adding any weight. Night is the untouched port.
  if (n.bright > 0.06) {
    const oct = ctx.createOscillator();
    oct.frequency.value = f * 2;
    oct.detune.value = 4;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, n.t);
    og.gain.linearRampToValueAtTime(Math.max(0.0002, n.vel * 0.17 * n.bright), n.t + 1.5);
    og.gain.setTargetAtTime(0.0001, n.t + n.dur * 0.85, 1.2);
    oct.connect(og).connect(out);
    oct.start(n.t);
    oct.stop(stopAt);
  }
};

/* --------------------------------------------------------------- upright */

/** Pizzicato double bass. Three things happen in the first 30 ms and together
 *  they are the whole instrument: the string goes sharp and settles, the
 *  fingerboard clacks, and the body thumps at its own fixed resonance
 *  regardless of which note was played. A plucked note then rings for as long
 *  as it rings — it does not hold for `dur`, and pretending otherwise is what
 *  makes sampled uprights sound like organs. */
const upright: Voice = (v, n) => {
  const { ctx } = v;
  const f = midiToFreq(n.midi);
  const ring = 1.3 + v.rng() * 0.6; // seconds to effectively gone
  const stopAt = n.t + ring + 1.5;

  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 35;
  hp.Q.value = 0.7;
  voiceOutput(v, hp, 0.06, 0);

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.setValueAtTime(Math.min(7000, f * (12 + 7 * n.bright)), n.t);
  tone.frequency.setTargetAtTime(Math.min(2600, f * (4.5 + 3.5 * n.bright)), n.t + 0.02, 0.3);
  tone.Q.value = 0.6;
  tone.connect(hp);

  // the higher partials die first — that spread of decays *is* the pluck
  const partials: readonly [number, number, number][] = [
    // [harmonic, level, decay tau]
    [1, 0.9, ring / 3],
    [2.002, 0.3, ring / 7],
    [3.005, 0.15, ring / 13],
    [4.81, 0.06, 0.04]
  ];
  for (const [mult, level, tau] of partials) {
    const osc = ctx.createOscillator();
    // a hard pluck stretches the string sharp; it settles in about 30 ms
    osc.frequency.setValueAtTime(f * mult * 1.028, n.t);
    osc.frequency.exponentialRampToValueAtTime(f * mult, n.t + 0.03);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, n.t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, n.vel * level), n.t + 0.008);
    g.gain.setTargetAtTime(0.0001, n.t + 0.012, tau);
    osc.connect(g).connect(tone);
    osc.start(n.t);
    osc.stop(stopAt);
  }

  const pluck = noiseSource(v, n.t, n.t + 0.4);

  // the box: a cavity resonance that sits where it sits, excited by the attack
  const body = ctx.createBiquadFilter();
  body.type = "bandpass";
  body.frequency.value = 96 + v.rng() * 18;
  body.Q.value = 9;
  const bodyGain = ctx.createGain();
  ramp(
    bodyGain.gain,
    n.t,
    bandNoiseGain(ctx, body.frequency.value, 9, n.vel * 0.3),
    0.004,
    0.34
  );
  pluck.connect(body).connect(bodyGain).connect(hp);

  // the finger leaving the string, brighter in daylight
  const finger = ctx.createBiquadFilter();
  finger.type = "bandpass";
  finger.frequency.value = 1300 + v.rng() * 700;
  finger.Q.value = 1.2;
  const fingerGain = ctx.createGain();
  ramp(
    fingerGain.gain,
    n.t,
    bandNoiseGain(ctx, finger.frequency.value, 1.2, n.vel * (0.07 + 0.07 * n.bright)),
    0.003,
    0.05
  );
  pluck.connect(finger).connect(fingerGain).connect(hp);
};

/* ----------------------------------------------------------------- round */

/** The safe option: a triangle behind a filter that opens on the attack and
 *  closes again as the note settles, which is the whole of what makes a synth
 *  bass read as "played" rather than "held". Warm, modern, gets out of the way. */
const round: Voice = (v, n) => {
  const { ctx } = v;
  const f = midiToFreq(n.midi);
  const stopAt = n.t + n.dur + 3;

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 0.9;
  lp.frequency.setValueAtTime(Math.max(60, f * 1.4), n.t);
  lp.frequency.linearRampToValueAtTime(Math.min(3400, f * (4.5 + 4 * n.bright)), n.t + 0.22);
  lp.frequency.setTargetAtTime(Math.min(1800, f * (2.2 + 2.2 * n.bright)), n.t + 0.24, 0.8);
  voiceOutput(v, lp, 0.04, 0);

  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = f;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, n.t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, n.vel * 1.1), n.t + 0.06);
  g.gain.setTargetAtTime(0.0001, n.t + n.dur * 0.94, 0.42);
  osc.connect(g).connect(lp);
  osc.start(n.t);
  osc.stop(stopAt);
};

/* ------------------------------------------------------------------ tape */

const TAPE_PRE = 0.8; // level into the curve; fixed so the timbre is stable
const TAPE_CURVE_STEPS = 2048;
const TAPE_CURVES = new Map<number, Float32Array<ArrayBuffer>>();

/** tanh with a touch of even-order asymmetry. A tape head's transfer curve is
 *  not symmetric, and that asymmetry is most of why tape reads as warm rather
 *  than merely soft — the DC it leaves behind is what the 35 Hz highpass is
 *  really for. Keyed by drive, which is quantised to a handful of curves. */
function tapeCurve(k: number): Float32Array<ArrayBuffer> {
  const cached = TAPE_CURVES.get(k);
  if (cached) return cached;
  const curve = new Float32Array(TAPE_CURVE_STEPS);
  const norm = Math.tanh(1.09 * k);
  for (let i = 0; i < TAPE_CURVE_STEPS; i++) {
    const x = (i / (TAPE_CURVE_STEPS - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x + 0.09 * k * x * x) / norm;
  }
  TAPE_CURVES.set(k, curve);
  return curve;
}

/** A sine that went through a machine. The saturation is mild by design — the
 *  character is in the drift, which is a scheduled random walk rather than an
 *  LFO because real wow never repeats a period. Night runs hotter into the
 *  curve and loses the top end; that is the worn end of the reel. */
const tape: Voice = (v, n) => {
  const { ctx } = v;
  const f = midiToFreq(n.midi);
  const stopAt = n.t + n.dur + 4;

  const out = ctx.createGain();
  out.gain.value = 1;
  voiceOutput(v, out, 0.08, 0);

  const osc = ctx.createOscillator();
  osc.frequency.value = f;

  // a few cents of wander, re-aimed roughly once a second
  let cents = (v.rng() - 0.5) * 3;
  osc.detune.setValueAtTime(cents, n.t);
  const span = Math.min(n.dur + 1, 26);
  for (let w = 0.9; w < span; w += 0.7 + v.rng() * 0.7) {
    cents = Math.max(-6, Math.min(6, cents + (v.rng() - 0.5) * 5));
    osc.detune.linearRampToValueAtTime(cents, n.t + w);
  }

  const pre = ctx.createGain();
  pre.gain.value = TAPE_PRE;
  const drive = Math.round((1.3 + 0.9 * (1 - n.bright)) * 4) / 4;
  const shaper = ctx.createWaveShaper();
  shaper.curve = tapeCurve(drive);
  shaper.oversample = "2x";

  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 35;
  hp.Q.value = 0.7;

  // head bandwidth: the tape simply cannot hold the top after dark
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 900 + 2400 * n.bright;
  lp.Q.value = 0.5;

  // the curve's own output level moves with drive, so back it out here and
  // keep night and day at the same loudness
  const shaped = Math.tanh(drive * TAPE_PRE * (1 + 0.09 * TAPE_PRE)) / Math.tanh(1.09 * drive);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, n.t);
  g.gain.linearRampToValueAtTime(Math.max(0.0002, (n.vel * 0.8) / shaped), n.t + 0.35);
  g.gain.setTargetAtTime(0.0001, n.t + n.dur * 0.9, 0.9);

  osc.connect(pre).connect(shaper).connect(hp).connect(lp).connect(g).connect(out);
  osc.start(n.t);
  osc.stop(stopAt);

  // print-through: a faint upper ghost arriving late, the way one layer of
  // tape prints onto the layer wound against it
  const ghost = ctx.createOscillator();
  ghost.frequency.value = f * 3;
  ghost.detune.value = (v.rng() - 0.5) * 12;
  const gg = ctx.createGain();
  gg.gain.setValueAtTime(0.0001, n.t);
  gg.gain.linearRampToValueAtTime(
    Math.max(0.0002, n.vel * (0.04 + 0.05 * n.bright)),
    n.t + 0.9
  );
  gg.gain.setTargetAtTime(0.0001, n.t + n.dur * 0.8, 0.7);
  ghost.connect(gg).connect(out);
  ghost.start(n.t);
  ghost.stop(stopAt);
};

export const BASS_VOICES: Record<BassVoiceId, Voice> = {
  sub,
  upright,
  round,
  tape
};
