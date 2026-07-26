// Sustained half of the palette — the harmony everything else sits on.
//
// The director calls a pad voice once per chord tone, so nothing here builds a
// chord: each voice builds one long note that swells, holds for `n.dur` and
// eases out. All six are loudness-matched against `drift` at the same velocity.
// `drift` is what the score was balanced around, and a pad that arrives 3 dB
// hot buries the keys it is supposed to sit under.
//
// Saturation, tape wow and the worn-cassette lowpass all live on the master
// chain, so these voices stay deliberately clean and let that chain do the
// ageing. The one thing they must never do is click: the pad bus is the loudest
// continuous thing in the mix, and a discontinuity there is a pop, not a note.

import {
  midiToFreq,
  ramp,
  voiceOutput,
  type PadVoiceId,
  type Voice,
  type VoiceCtx
} from "../voiceTypes";

/* ----------------------------------------------------------------- shared */

const NOISE_SECONDS = 3;
/** RMS of uniform noise on [-1,1] — used to size band-limited makeup gains. */
const NOISE_RMS = 0.5774;

const NOISE_CACHE = new WeakMap<BaseAudioContext, AudioBuffer>();

/** Fixed-seed bit noise. The bed is a context-lifetime constant, and pulling
 *  ~150k samples out of `v.rng()` would shift every later draw depending on
 *  which note happened to allocate it first — that breaks exactly the
 *  determinism the injected rng exists to protect. */
function seededNoise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** One noise bed per context, allocated on the first note that needs air. */
function noiseBed(ctx: BaseAudioContext): AudioBuffer {
  const cached = NOISE_CACHE.get(ctx);
  if (cached) return cached;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rnd = seededNoise(0x5ea1f0a);
  for (let i = 0; i < frames; i++) data[i] = rnd() * 2 - 1;
  NOISE_CACHE.set(ctx, buffer);
  return buffer;
}

/** A looping tap into the shared bed. The read offset and a hair of rate skew
 *  vary per note so two layers of one chord never correlate into phasey hiss. */
function noiseSource(v: VoiceCtx, t: number, stopAt: number): AudioBufferSourceNode {
  const bed = noiseBed(v.ctx);
  const src = v.ctx.createBufferSource();
  src.buffer = bed;
  src.loop = true;
  src.playbackRate.value = 0.94 + v.rng() * 0.12;
  src.start(t, v.rng() * bed.duration);
  src.stop(stopAt);
  return src;
}

/** The shared pad gesture: silence → linear swell → hold → long ease.
 *  Linear on the way in because a pad should arrive at a constant rate rather
 *  than accelerate; exponential out because rooms let go slowly. A `dur`
 *  shorter than the swell simply truncates it, which is what the original did. */
function swell(
  param: AudioParam,
  t: number,
  peak: number,
  attack: number,
  holdUntil: number,
  tau: number
): void {
  param.setValueAtTime(0.0001, t);
  param.linearRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  param.setTargetAtTime(0.0001, Math.max(holdUntil, t + 0.05), tau);
}

/** Makeup for noise through a 2nd-order bandpass, from its equivalent noise
 *  bandwidth. A high-Q band passes almost nothing, and how little depends on
 *  both the centre frequency and the sample rate — a fixed gain would swing
 *  `breath` by 12 dB across the register and again on a 44.1 kHz device. */
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

/* ------------------------------------------------------------------ drift */

/** The original pad. Two sines a whisker apart — the beating between them *is*
 *  the voice, and anything wider than ±4 cents stops reading as one note.
 *  Daylight thins the body and floats an octave over it, so the same chord is
 *  weight at night and air at noon; at bright 0 this is the untouched port. */
const drift: Voice = (v, n) => {
  const { ctx } = v;
  const f = midiToFreq(n.midi);
  const stopAt = n.t + n.dur + 7;
  const core = n.vel * (1 - 0.2 * n.bright);
  const spread = 0.18 + v.rng() * 0.12;

  [-4, 4].forEach((detune, i) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = f;
    osc.detune.value = detune;
    const g = ctx.createGain();
    swell(g.gain, n.t, core, 2.8, n.t + n.dur, 1.6);
    osc.connect(g);
    voiceOutput(v, g, 0.5, i === 0 ? -spread : spread);
    osc.start(n.t);
    osc.stop(stopAt);
  });

  if (n.bright > 0.05) {
    const osc = ctx.createOscillator();
    osc.frequency.value = f * 2;
    osc.detune.value = 6;
    const g = ctx.createGain();
    // arrives after the body so the pad opens rather than simply being brighter
    swell(g.gain, n.t, n.vel * 0.3 * n.bright, 3.6, n.t + n.dur, 1.6);
    osc.connect(g);
    voiceOutput(v, g, 0.6, (v.rng() - 0.5) * 0.5);
    osc.start(n.t);
    osc.stop(stopAt);
  }
};

/* -------------------------------------------------------------------- bow */

/** A section, not a soloist. Three players lean in at different rates, each
 *  with their own vibrato — and none of them vibrato on the attack, because
 *  nobody does. The filter opening across the swell is rosin catching: a bow
 *  only gets the string properly speaking once pressure builds. */
const bow: Voice = (v, n) => {
  const { ctx } = v;
  const f = midiToFreq(n.midi);
  const stopAt = n.t + n.dur + 6;
  const openTo = Math.min(5200, Math.max(520, f * (3.2 + 4.5 * n.bright)));
  const layers: readonly [number, number, number][] = [
    // [detune cents, swell seconds, vibrato Hz]
    [-7, 2.2, 4.3],
    [2, 2.9, 4.8],
    [9, 3.6, 5.2]
  ];

  layers.forEach(([detune, attack, rate], i) => {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = f;
    osc.detune.value = detune + (v.rng() - 0.5) * 5;

    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.setValueAtTime(Math.max(180, f * 1.3), n.t);
    tone.frequency.setTargetAtTime(openTo, n.t + 0.15, attack * 0.45);
    tone.Q.value = 0.7;

    // vibrato is silent for the first beat, then fades in over ~1.5 s
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate + (v.rng() - 0.5) * 0.5;
    const depth = ctx.createGain();
    const held = n.t + 0.5 + v.rng() * 0.4;
    depth.gain.setValueAtTime(0, n.t);
    depth.gain.setValueAtTime(0, held);
    depth.gain.linearRampToValueAtTime(4.5 + v.rng() * 2.5, held + 1.5 + v.rng() * 0.4);
    lfo.connect(depth).connect(osc.detune);
    lfo.start(n.t);
    lfo.stop(stopAt);

    const g = ctx.createGain();
    swell(g.gain, n.t, n.vel * 0.78 * (1 - 0.12 * n.bright), attack, n.t + n.dur, 1.4);
    osc.connect(tone).connect(g);
    voiceOutput(v, g, 0.55, (i - 1) * (0.28 + v.rng() * 0.16));
    osc.start(n.t);
    osc.stop(stopAt);
  });

  // hair on the string: a breath of rosin under the attack only, then gone
  const air = noiseSource(v, n.t, n.t + 1.8);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = Math.min(2600, Math.max(900, f * 6));
  band.Q.value = 1.1;
  const airGain = ctx.createGain();
  ramp(
    airGain.gain,
    n.t,
    bandNoiseGain(ctx, band.frequency.value, 1.1, n.vel * 0.1 * (0.5 + 0.5 * n.bright)),
    0.5,
    1.7
  );
  air.connect(band).connect(airGain);
  voiceOutput(v, airGain, 0.5, (v.rng() - 0.5) * 0.5);
};

/* ------------------------------------------------------------------ choir */

/** Vowel pad. Three voices buzzing through a formant bank that closes from
 *  /ah/ toward /oo/ across the note — a choir shutting its mouth on a held
 *  chord. That closing is what keeps a formant pad from reading as a preset.
 *  The bandpasses throw most of the source away; this makeup was measured
 *  against `drift` through the pad bus rather than calculated. */
const FORMANT_MAKEUP = 2.6;

const choir: Voice = (v, n) => {
  const { ctx } = v;
  const f = midiToFreq(n.midi);
  const stopAt = n.t + n.dur + 7;

  // A formant sits at a fixed frequency, so it picks whichever harmonic lands
  // in it — and a sawtooth's nth harmonic is 1/n as loud. Left alone that made
  // the bottom of the register 8 dB quieter than the top. Compensating by 1/f
  // (capped, or low notes cost more headroom than they are worth) is what a
  // singer does anyway: you push harder down there.
  const src = ctx.createGain();
  src.gain.value = 0.34 * Math.min(2, Math.max(1, 392 / f));
  // spread wide — a real section is ±20 cents, and the faster beating keeps
  // three resonant formant chains from cresting together
  for (const detune of [-16, 3, 18]) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = f;
    osc.detune.value = detune + (v.rng() - 0.5) * 7;
    osc.connect(src);
    osc.start(n.t);
    osc.stop(stopAt);
  }

  // A real glottal source rolls off far faster than a raw sawtooth — and its
  // corner barely tracks pitch, which matters: a pitch-relative cutoff put F2
  // above the source's last harmonic on low notes and made the bottom of the
  // register 4 dB quieter than the top.
  const glottal = ctx.createBiquadFilter();
  glottal.type = "lowpass";
  glottal.frequency.value = Math.max(f * 3, 1500 + 1700 * n.bright);
  glottal.Q.value = 0.4;
  src.connect(glottal);

  const bank = ctx.createGain();
  bank.gain.value = FORMANT_MAKEUP;

  // night starts nearer /oo/ and barely moves; midday opens the mouth first
  const open = 0.55 + 0.45 * n.bright;
  const glide = Math.max(2.5, Math.min(n.dur * 0.85, 14));
  const formants: readonly [number, number, number, number][] = [
    // [start Hz, end Hz, Q, level] — Qs sit wide for a section: one singer's
    // formants are narrower, but a dozen of them are not in tune. Narrow bands
    // also ring between harmonics on low notes, which costs peak headroom for
    // loudness the ear never receives.
    [120 + 640 * open, 350, 4.5, 1],
    [220 + 1000 * open, 800, 6, 0.55],
    [2350, 2100, 8, 0.06 + 0.1 * n.bright]
  ];
  for (const [from, to, q, level] of formants) {
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(from, n.t);
    bp.frequency.setValueAtTime(from, n.t + 0.6);
    bp.frequency.linearRampToValueAtTime(to, n.t + 0.6 + glide);
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = level;
    glottal.connect(bp).connect(g).connect(bank);
  }

  // an uneven slow sway so the section reads as people rather than a patch
  const shimmer = ctx.createGain();
  shimmer.gain.value = 1;
  const shimLfo = ctx.createOscillator();
  shimLfo.frequency.value = 0.15 + v.rng() * 0.2;
  const shimDepth = ctx.createGain();
  shimDepth.gain.value = 0.14;
  shimLfo.connect(shimDepth).connect(shimmer.gain);
  shimLfo.start(n.t);
  shimLfo.stop(stopAt);

  const env = ctx.createGain();
  // the open vowel loses low harmonics to the pad bus, so daylight pays a
  // little back rather than thinning like the other five
  swell(env.gain, n.t, n.vel * (1 + 0.12 * n.bright), 3.2, n.t + n.dur, 1.9);
  bank.connect(shimmer).connect(env);
  voiceOutput(v, env, 0.6, (v.rng() - 0.5) * 0.8);
};

/* ------------------------------------------------------------------ organ */

/** Six harmonics sum to well over unity, and the stack phase-aligns the way a
 *  harmonic series does, so the drawbars are trimmed as a set. Measured, not
 *  calculated: the pad bus lowpass removes most of what makes an organ loud. */
const ORGAN_TRIM = 0.82;

/** Drawbar reed organ — the interior/sacred pad. No swell: an organ is either
 *  sounding or it isn't, and that squareness is its whole character next to
 *  five voices that all breathe. Daylight pulls the upper drawbars out. */
const organ: Voice = (v, n) => {
  const { ctx } = v;
  const f = midiToFreq(n.midi);
  const stopAt = n.t + n.dur + 1.6;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, n.t);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, n.vel), n.t + 0.08);
  env.gain.setTargetAtTime(0.0001, n.t + n.dur, 0.13); // ~0.4 s to gone

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = Math.min(6000, f * (4 + 5 * n.bright));
  tone.Q.value = 0.3;
  env.connect(tone);
  const outPan = voiceOutput(v, tone, 0.62, (v.rng() - 0.5) * 0.3);

  // 8' 4' 2⅔' 2' 1⅓' 1' — the 2nd and 3rd are pulled off pitch for chorus
  const bars: readonly [number, number, number][] = [
    // [harmonic, drawbar level, detune cents]
    [1, 1, 0],
    [2, 0.55, 5],
    [3, 0.32, -7],
    [4, 0.24, 0],
    [6, 0.13, 0],
    [8, 0.09, 0]
  ];
  for (const [mult, level, detune] of bars) {
    const osc = ctx.createOscillator();
    osc.frequency.value = f * mult;
    osc.detune.value = detune;
    const g = ctx.createGain();
    g.gain.value = level * ORGAN_TRIM * (mult >= 6 ? 0.25 + 0.75 * n.bright : 1);
    osc.connect(g).connect(env);
    osc.start(n.t);
    osc.stop(stopAt);
  }

  // key click: contact bounce, not a note. Joins at the panner so it skips the
  // pipe lowpass but still lands in the same room as the chord.
  const click = noiseSource(v, n.t, n.t + 0.1);
  const clickBand = ctx.createBiquadFilter();
  clickBand.type = "bandpass";
  clickBand.frequency.value = 1800 + v.rng() * 700;
  clickBand.Q.value = 1.4;
  const clickGain = ctx.createGain();
  ramp(
    clickGain.gain,
    n.t,
    bandNoiseGain(ctx, clickBand.frequency.value, 1.4, n.vel * 0.1),
    0.002,
    0.035
  );
  click.connect(clickBand).connect(clickGain).connect(outPan);
};

/* ------------------------------------------------------------------ glass */

/** Shimmer: the fundamental with an octave and a twelfth floating over it,
 *  each on its own unrelated tremolo clock so the three never lock into a
 *  chord you could name. Weightless, and mostly heard through the reverb —
 *  the wet path skips the pad bus lowpass, so this is where it lives. */
const glass: Voice = (v, n) => {
  const { ctx } = v;
  const f = midiToFreq(n.midi);
  const stopAt = n.t + n.dur + 8;

  const env = ctx.createGain();
  swell(env.gain, n.t, n.vel * 0.92, 4.2 + v.rng() * 0.8, n.t + n.dur, 2.2);
  voiceOutput(v, env, 0.8, (v.rng() - 0.5) * 1.2);

  const partials: readonly [number, number, number][] = [
    // [harmonic, level, detune cents] — night keeps only a ghost of the top
    [1, 1, 3],
    [2, 0.5 * (0.35 + 0.65 * n.bright), -5],
    [3, 0.32 * (0.25 + 0.75 * n.bright), 7]
  ];
  for (const [mult, level, detune] of partials) {
    const osc = ctx.createOscillator();
    osc.frequency.value = f * mult;
    osc.detune.value = detune;
    const trem = ctx.createGain();
    trem.gain.value = level;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13 + v.rng() * 0.18;
    const depth = ctx.createGain();
    // stays well under the base level: the partial must never invert phase,
    // and three tremolos cresting together is where glass runs out of headroom
    depth.gain.value = level * (0.18 + 0.1 * n.bright);
    lfo.connect(depth).connect(trem.gain);
    lfo.start(n.t);
    lfo.stop(stopAt);
    osc.connect(trem).connect(env);
    osc.start(n.t);
    osc.stop(stopAt);
  }
};

/* ----------------------------------------------------------------- breath */

/** Air. The note is a narrow band of noise, not a tone; the sine underneath is
 *  only there to tell the ear which pitch the air is. Night is nearly all
 *  breath and the fog band carries it — daylight brings the tone forward. */
const breath: Voice = (v, n) => {
  const { ctx } = v;
  const f = midiToFreq(n.midi);
  const stopAt = n.t + n.dur + 5;

  // one inhale-and-ease every ~4 s, riding on top of the note envelope
  const cycle = ctx.createGain();
  cycle.gain.value = 0.78;
  const breathLfo = ctx.createOscillator();
  breathLfo.frequency.value = 1 / (3.6 + v.rng() * 1.4);
  const breathDepth = ctx.createGain();
  breathDepth.gain.value = 0.22;
  breathLfo.connect(breathDepth).connect(cycle.gain);
  breathLfo.start(n.t);
  breathLfo.stop(stopAt);

  const env = ctx.createGain();
  swell(env.gain, n.t, 1, 0.9 + v.rng() * 0.5, n.t + n.dur, 1.2);
  cycle.connect(env);
  voiceOutput(v, env, 0.7, (v.rng() - 0.5));

  const air = noiseSource(v, n.t, stopAt);

  // Two stages, because one bandpass has skirts too shallow to read as a pitch.
  // Both stay moderate: narrower bands are more obviously pitched but their
  // crest factor climbs fast, and this voice has to sit beside `drift` without
  // costing three times the peak headroom for the same loudness.
  const pitched = ctx.createBiquadFilter();
  pitched.type = "bandpass";
  pitched.frequency.value = f;
  pitched.Q.value = 7;
  const pitched2 = ctx.createBiquadFilter();
  pitched2.type = "bandpass";
  pitched2.frequency.value = f;
  pitched2.Q.value = 5;
  const pitchedGain = ctx.createGain();
  // The target is the level the *pair* should reach; the second stage's own
  // loss is folded in here rather than modelled. Held back deliberately: band
  // noise peaks about 4x its RMS, so the last few dB of "air" would cost more
  // headroom than the whole rest of the pad palette.
  pitchedGain.gain.value = bandNoiseGain(ctx, f, 7, n.vel * 0.72);
  air.connect(pitched).connect(pitched2).connect(pitchedGain).connect(cycle);

  // the overblown octave a shakuhachi cracks into
  const over = ctx.createBiquadFilter();
  over.type = "bandpass";
  over.frequency.value = f * 2;
  over.Q.value = 7;
  const overGain = ctx.createGain();
  overGain.gain.value = bandNoiseGain(ctx, f * 2, 7, n.vel * (0.1 + 0.12 * n.bright));
  air.connect(over).connect(overGain).connect(cycle);

  // the fog: wide, unpitched, and the whole voice after dark
  const hiss = ctx.createBiquadFilter();
  hiss.type = "bandpass";
  hiss.frequency.value = 1500 + 900 * n.bright;
  hiss.Q.value = 0.8;
  const hissGain = ctx.createGain();
  hissGain.gain.value = bandNoiseGain(
    ctx,
    hiss.frequency.value,
    0.8,
    n.vel * (0.3 - 0.18 * n.bright)
  );
  air.connect(hiss).connect(hissGain).connect(cycle);

  // The pitch locks in behind the air, the way a flute speaks. It also carries
  // more of the level than the noise does, because a sine costs a third of the
  // peak headroom for the same loudness.
  const core = ctx.createOscillator();
  core.frequency.value = f;
  core.detune.value = (v.rng() - 0.5) * 6;
  const coreGain = ctx.createGain();
  swell(coreGain.gain, n.t, n.vel * (0.72 + 0.24 * n.bright), 2.2, n.t + n.dur, 1.2);
  core.connect(coreGain).connect(cycle);
  core.start(n.t);
  core.stop(stopAt);
};

export const PAD_VOICES: Record<PadVoiceId, Voice> = {
  drift,
  bow,
  choir,
  organ,
  glass,
  breath
};
