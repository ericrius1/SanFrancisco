// The keys family — eight instruments that all sound the same chord voicing but
// give a neighbourhood its face.
//
// `rhodes` is the reference: the director's original e-piano, ported whole.
// Every other voice is a deliberate departure from it along one axis. `felt`
// trades brightness for intimacy, `vibes` trades attack for ring, `nylon` and
// `koto` trade a struck body for a plucked one, `reed` trades decay for breath,
// `marimba` trades sustain for wood, `celeste` trades body for air.
//
// Nothing here is pooled, so every source that start()s carries a bounded
// stop(), and nothing here feeds back into itself — see `pluckedString` for
// what happened the one time something did.

import {
  midiToFreq,
  ramp,
  voiceOutput,
  type KeysVoiceId,
  type Voice,
  type VoiceCtx
} from "../voiceTypes";

/* ---------------------------------------------------------------- material */

const NOISE_SECONDS = 2;
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** One noise bed per context. Hammers, breath and plectra all read slices of
 *  it — these voices fire dozens of times a minute and a buffer per note would
 *  churn a megabyte a second for no audible gain. */
function noiseBed(v: VoiceCtx): AudioBuffer {
  const cached = noiseCache.get(v.ctx);
  if (cached) return cached;
  const len = Math.floor(v.ctx.sampleRate * NOISE_SECONDS);
  const buf = v.ctx.createBuffer(1, len, v.ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = v.rng() * 2 - 1;
  noiseCache.set(v.ctx, buf);
  return buf;
}

/** A slice of the shared bed. Per-note colour comes from the read offset. */
function burst(v: VoiceCtx, dest: AudioNode, t: number, dur: number): void {
  const src = v.ctx.createBufferSource();
  const bed = noiseBed(v);
  src.buffer = bed;
  src.connect(dest);
  const from = v.rng() * Math.max(0, bed.duration - dur - 0.05);
  src.start(t, from, dur);
  src.stop(t + dur + 0.05);
}

/* ------------------------------------------------------------------ string */

// BiquadFilterNode.Q is in DECIBELS for lowpass/highpass, not a dimensionless
// quality factor: Q = 0 is already a linear Q of 1, which peaks +1.25 dB above
// unity. This is the value that makes the response genuinely flat (linear
// 1/sqrt(2)) — inside a feedback loop the difference is a damped string versus
// a self-oscillating one.
const FLAT_Q = -3.0103;

type PluckShape = {
  /** cache key — the wave depends on the shape, never on the pitch. */
  key: string;
  /** where the string is set moving, as a fraction of its length. */
  pos: number;
  /** extra roll-off past the ideal 1/n; below 1 is a harder, brighter attack. */
  tilt: number;
};

// A nylon guitar is fingered out over the soundhole; a koto is struck close to
// the bridge, which is why it is nearly all upper partial and almost no
// fundamental.
const NYLON_SHAPE: PluckShape = { key: "nylon", pos: 0.28, tilt: 1 };
const KOTO_SHAPE: PluckShape = { key: "koto", pos: 0.16, tilt: 0.85 };

const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();

/** Bridge-force spectrum of an ideal string plucked at `pos`: harmonic n
 *  arrives at sin(n·pi·pos)/n^tilt, so the pluck point notches out every
 *  harmonic whose node it lands on. That comb is most of what separates a
 *  guitar picked over the rose from one picked at the saddle. */
function pluckWave(v: VoiceCtx, shape: PluckShape): PeriodicWave {
  let perCtx = waveCache.get(v.ctx);
  if (!perCtx) {
    perCtx = new Map();
    waveCache.set(v.ctx, perCtx);
  }
  const cached = perCtx.get(shape.key);
  if (cached) return cached;
  const harmonics = 48;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    const amp = Math.sin(n * Math.PI * shape.pos) / Math.pow(n, shape.tilt);
    // Scattered phase. The magnitude spectrum — everything the ear reads as
    // timbre — is untouched, but the waveform stops being one tall spike, which
    // is worth about 6 dB of loudness against the same peak.
    const phase = v.rng() * Math.PI * 2;
    real[n] = amp * Math.cos(phase);
    imag[n] = amp * Math.sin(phase);
  }
  const wave = v.ctx.createPeriodicWave(real, imag);
  perCtx.set(shape.key, wave);
  return wave;
}

type PluckOpts = {
  t: number;
  f: number;
  shape: PluckShape;
  peak: number;
  /** lowpass start and end, x f — the sweep between them IS the damping. */
  openHi: number;
  closeLo: number;
  sweep: number;
  /** seconds to -60 dB. */
  t60: number;
};

/** A plucked string as a pluck spectrum with the highs swept off it.
 *
 *  This was a Karplus-Strong delay loop until it was measured. Two things kill
 *  that topology here: a lowpass at the Q we wanted peaks 1.2x above unity, so
 *  the loop ran away to NaN within a second; and a DelayNode inside a feedback
 *  cycle costs a whole extra render quantum per lap on top of the loop filter's
 *  group delay, which tuned MIDI 76 down to 83 Hz. The quantum is only spec'd
 *  as "at least one", so even the mistuning is the browser's choice. Sweeping a
 *  filter down across a fixed pluck spectrum is the same physics — the highs
 *  shed first, the fundamental rings on — with no cycle to detune or blow up. */
function pluckedString(
  v: VoiceCtx,
  dest: AudioNode,
  o: PluckOpts
): { strings: OscillatorNode[]; tail: number } {
  const { ctx } = v;
  const { t } = o;
  const tail = o.t60 * 1.05;
  const stopAt = t + tail + 0.35;
  const nyquistish = ctx.sampleRate * 0.45;

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = FLAT_Q;
  lp.frequency.setValueAtTime(Math.min(nyquistish, o.f * o.openHi), t);
  lp.frequency.exponentialRampToValueAtTime(
    Math.max(80, Math.min(nyquistish, o.f * o.closeLo)),
    t + o.sweep
  );

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.peak), t + 0.0035);
  // Two stages: the pluck dumps most of its energy in the first breath, and
  // then the string is just ringing.
  g.gain.setTargetAtTime(o.peak * 0.55, t + 0.006, 0.08);
  g.gain.setTargetAtTime(0.0001, t + 0.16, o.t60 / 3.4);
  g.gain.setTargetAtTime(0.0001, t + tail * 0.78, Math.max(0.03, tail * 0.05));
  lp.connect(g).connect(dest);

  const wave = pluckWave(v, o.shape);
  const strings: OscillatorNode[] = [];
  const course = (detune: number, level: number) => {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.value = o.f;
    osc.detune.value = detune;
    const lvl = ctx.createGain();
    lvl.gain.value = level;
    osc.connect(lvl).connect(lp);
    osc.start(t);
    osc.stop(stopAt);
    strings.push(osc);
  };
  course(0, 1);
  // A second course a few cents off. One perfectly periodic oscillator reads as
  // a synth; two beating slowly against each other read as an instrument.
  course((v.rng() < 0.5 ? -1 : 1) * (2.5 + v.rng() * 2.5), 0.38);
  return { strings, tail };
}

/* ------------------------------------------------------------------ voices */

/** Rhodes-flavoured note: sine body, soft octave partial, fast "tine" ping. */
const rhodes: Voice = (v, n) => {
  const { ctx } = v;
  const { t, dur } = n;
  const f = midiToFreq(n.midi);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  // The original sat at f × 5.5; daylight now swings that either side so the
  // same bars read hazy at 3am and bell-clear at noon.
  filter.frequency.value = Math.min(8500, f * (4.2 + n.bright * 2.6));
  filter.Q.value = 0.4;
  voiceOutput(v, filter, 0.3, (v.rng() * 2 - 1) * 0.4);

  const stopAt = t + Math.min(dur, 8) + 4;
  const partial = (freq: number, level: number, decay: number, sustain = 0) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + 0.012);
    if (sustain > 0) {
      g.gain.setTargetAtTime(level * sustain, t + 0.02, 1.1);
      g.gain.setTargetAtTime(0.0001, t + Math.min(dur, 8), 0.9 - n.bright * 0.25);
    } else {
      g.gain.setTargetAtTime(0.0001, t + 0.02, decay);
    }
    osc.connect(g).connect(filter);
    osc.start(t);
    osc.stop(stopAt);
  };
  partial(f, n.vel, 0, 0.25); // body rings and releases with the chord
  partial(f * 2.001, n.vel * 0.18, 0.45); // soft octave bloom
  partial(f * 3.98, n.vel * (0.11 + n.bright * 0.05), 0.09); // tine attack
};

/** Upright with the hammers muffled: all thump, almost no string. */
const felt: Voice = (v, n) => {
  const { ctx } = v;
  const { t } = n;
  const f = midiToFreq(n.midi);
  const tail = 1.5 - n.bright * 0.42;
  const stopAt = t + tail + 0.3;

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  // The blanket sits barely above the fundamental, and night pulls it lower
  // still — this is a piano heard through a wall, not across a hall.
  tone.frequency.value = Math.max(300, Math.min(4200, f * (1.65 + n.bright * 1.0)));
  tone.Q.value = 0.7;
  voiceOutput(v, tone, 0.2 - n.bright * 0.05, (v.rng() * 2 - 1) * 0.26);

  const partial = (mult: number, level: number, decay: number) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = f * mult;
    osc.detune.value = (v.rng() * 2 - 1) * 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + 0.006);
    g.gain.setTargetAtTime(0.0001, t + 0.012, decay);
    g.gain.setTargetAtTime(0.0001, t + tail * 0.78, 0.11); // the damper drops
    osc.connect(g).connect(tone);
    osc.start(t);
    osc.stop(stopAt);
  };
  // Odd partials only, each dying faster than the last.
  partial(1, n.vel, 0.55 - n.bright * 0.12);
  partial(3.02, n.vel * 0.16, 0.13);
  partial(5.06, n.vel * 0.06, 0.055);

  const knock = ctx.createBiquadFilter();
  knock.type = "lowpass";
  knock.frequency.value = Math.min(1800, f * (2.2 + n.bright * 1.6));
  const knockGain = ctx.createGain();
  ramp(knockGain.gain, t, n.vel * 0.5, 0.0015, 0.032); // felt thumps, it never clicks
  knock.connect(knockGain).connect(tone);
  burst(v, knock, t, 0.045);
};

/** Vibraphone: three bar modes and the motor turning underneath them. */
const vibes: Voice = (v, n) => {
  const { ctx } = v;
  const { t } = n;
  const f = midiToFreq(n.midi);
  const tail = 3.6 - n.bright * 1.2;
  const tau = tail / 4.2;
  const stopAt = t + tail + 0.6;
  const peak = n.vel * 0.88; // metal at equal peak reads far louder than felt

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = Math.min(11000, f * (7 + n.bright * 5));
  tone.Q.value = 0.4;
  voiceOutput(v, tone, 0.55, (v.rng() * 2 - 1) * 0.45);

  // The motor. Players run the fans faster in bright rooms, so daylight speeds
  // it up and deepens it; at night it barely turns.
  const rate = 4.5 + n.bright * 1.1 + v.rng() * 0.5;
  const depth = 0.26 + n.bright * 0.12;
  // Centred so the motor only ever ducks, never boosts — a crest above unity
  // would put the attack over the peak the mix was budgeted for.
  const trem = ctx.createGain();
  trem.gain.value = 1 - depth * 0.5;
  trem.connect(tone);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = rate;
  const lfoAmt = ctx.createGain();
  lfoAmt.gain.value = depth * 0.5;
  lfo.connect(lfoAmt);
  lfoAmt.connect(trem.gain);
  // Free-running motor: start it early so no two notes share a phase.
  lfo.start(Math.max(ctx.currentTime, t - v.rng() / rate));
  lfo.stop(stopAt);

  const bar = (mult: number, level: number, attack: number, decay: number) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = f * mult;
    osc.detune.value = (v.rng() * 2 - 1) * 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + attack);
    g.gain.setTargetAtTime(0.0001, t + attack + 0.005, decay);
    osc.connect(g).connect(trem);
    osc.start(t);
    osc.stop(stopAt);
  };
  // Undercut bars tune to roughly 1 : 4 : 10 — the strong 4th is the vibraphone.
  bar(1, peak, 0.018, tau);
  bar(4.002, peak * 0.34, 0.01, tau * 0.42);
  bar(10.5, peak * 0.055, 0.003, 0.055); // the mallet's initial ting
};

/** Fingerpicked nylon: soft gut, damped fast, played over the soundhole. */
const nylon: Voice = (v, n) => {
  const { ctx } = v;
  const { t } = n;
  const f = midiToFreq(n.midi);

  const bus = ctx.createGain();
  voiceOutput(v, bus, 0.28, (v.rng() * 2 - 1) * 0.38);

  pluckedString(v, bus, {
    t,
    f,
    shape: NYLON_SHAPE,
    // A pluck spectrum is spikier than a sine at the same peak, so it needs the
    // headroom to sit level with the struck voices.
    peak: n.vel * 1.2,
    openHi: 11 + n.bright * 7,
    closeLo: 1.3, // gut and nylon lose their highs fast
    sweep: 1.4 - n.bright * 0.4,
    t60: 2.5 - n.bright * 0.9
  });

  // The nail catching the string on the way past — never the string itself.
  const nail = ctx.createBiquadFilter();
  nail.type = "bandpass";
  nail.frequency.value = 2200 + n.bright * 1600;
  nail.Q.value = 0.9;
  const nailGain = ctx.createGain();
  ramp(nailGain.gain, t, n.vel * 0.16, 0.001, 0.012);
  nail.connect(nailGain).connect(bus);
  burst(v, nail, t, 0.02);
};

/** Struck glass: one sine, one bright lie about it, and a very long room. */
const celeste: Voice = (v, n) => {
  const { ctx } = v;
  const { t } = n;
  const f = midiToFreq(n.midi);
  const tail = 5.6 - n.bright * 1.9;
  const stopAt = t + tail + 0.5;
  const peak = n.vel * 0.72; // a clean high sine carries further than it looks

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = Math.min(12000, f * (7 + n.bright * 6));
  tone.Q.value = 0.3;
  voiceOutput(v, tone, 0.78, (v.rng() * 2 - 1) * 0.5);

  const body = ctx.createOscillator();
  body.frequency.value = f;
  const bodyGain = ctx.createGain();
  bodyGain.gain.setValueAtTime(0.0001, t);
  bodyGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.008);
  bodyGain.gain.setTargetAtTime(0.0001, t + 0.012, tail / 4.5);
  body.connect(bodyGain).connect(tone);
  body.start(t);
  body.stop(stopAt);

  const bloom = ctx.createOscillator();
  bloom.frequency.value = f * 2.006;
  const bloomGain = ctx.createGain();
  bloomGain.gain.setValueAtTime(0.0001, t);
  bloomGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.08), t + 0.01);
  bloomGain.gain.setTargetAtTime(0.0001, t + 0.014, tail / 10);
  bloom.connect(bloomGain).connect(tone);
  bloom.start(t);
  bloom.stop(stopAt);

  // The hammer on the plate: inharmonic, gone in 40 ms, and the only thing that
  // tells you this was struck rather than blown.
  const strike = ctx.createOscillator();
  strike.frequency.value = f * 5.4;
  const strikeGain = ctx.createGain();
  ramp(strikeGain.gain, t, peak * (0.13 + n.bright * 0.07), 0.002, 0.04);
  strike.connect(strikeGain).connect(tone);
  strike.start(t);
  strike.stop(t + 0.09);
};

/** Harmonium: the only keys voice that holds, and the only one that breathes. */
const reed: Voice = (v, n) => {
  const { ctx } = v;
  const { t } = n;
  const f = midiToFreq(n.midi);
  const hold = Math.max(0.4, Math.min(10, n.dur));
  const attack = 0.15;
  const release = 0.34;
  const stopAt = t + hold + 2.2;

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = Math.min(7400, f * (6 + n.bright * 5));
  tone.Q.value = 0.6;
  voiceOutput(v, tone, 0.38, (v.rng() * 2 - 1) * 0.22);

  // Sustained tone at equal peak is far louder than any of the struck voices —
  // this is the deepest trim in the family.
  const peak = n.vel * 0.62;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  const swellAt = t + Math.max(attack + 0.08, hold * 0.55);
  if (swellAt < t + hold) {
    // The bellows arm never holds still.
    env.gain.exponentialRampToValueAtTime(peak * 1.07, swellAt);
  }
  env.gain.setTargetAtTime(0.0001, t + hold, release * 0.45);
  env.connect(tone);

  // Free reeds are odd-harmonic; night files the upper reeds off so the same
  // stop reads as a harmonium at dusk rather than a pump organ at noon.
  const tilt = 0.55 + n.bright * 0.65;
  const parts: Array<[number, number]> = [
    [1, 1],
    [3, 0.42 * tilt],
    [5, 0.2 * tilt * tilt],
    [7, 0.1 * tilt * tilt]
  ];
  const sum = parts.reduce((acc, [, level]) => acc + level, 0);

  const vib = ctx.createOscillator();
  vib.frequency.value = 4.6 + n.bright * 0.7 + v.rng() * 0.5;
  const vibAmt = ctx.createGain();
  vibAmt.gain.setValueAtTime(0.0001, t);
  vibAmt.gain.linearRampToValueAtTime(5 + v.rng() * 3, t + 1.1); // cents, faded in
  vib.connect(vibAmt);
  vib.start(t);
  vib.stop(stopAt);

  for (const [mult, level] of parts) {
    const osc = ctx.createOscillator();
    osc.frequency.value = f * mult;
    osc.detune.value = (v.rng() * 2 - 1) * 4; // reeds never quite agree
    vibAmt.connect(osc.detune);
    const g = ctx.createGain();
    g.gain.value = level / sum;
    osc.connect(g).connect(env);
    osc.start(t);
    osc.stop(stopAt);
  }

  // Air past the reed. It starts before the tone speaks and keeps leaking after
  // the key lifts, which is the whole character of the instrument.
  const airBand = ctx.createBiquadFilter();
  airBand.type = "bandpass";
  airBand.frequency.value = f * (2 + n.bright * 1.2);
  airBand.Q.value = 0.8;
  const air = ctx.createGain();
  air.gain.setValueAtTime(0.0001, t);
  air.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.16), t + attack * 0.5);
  air.gain.setTargetAtTime(0.0001, t + hold, release * 1.1);
  airBand.connect(air).connect(tone);

  const airSrc = ctx.createBufferSource();
  const bed = noiseBed(v);
  airSrc.buffer = bed;
  airSrc.loop = true;
  airSrc.connect(airBand);
  airSrc.start(t, v.rng() * (bed.duration - 0.1));
  airSrc.stop(stopAt);
};

/** Koto: hard plectrum, bent attack, and a hand that presses the string later. */
const koto: Voice = (v, n) => {
  const { ctx } = v;
  const { t } = n;
  const f = midiToFreq(n.midi);

  const bus = ctx.createGain();
  voiceOutput(v, bus, 0.2, (v.rng() * 2 - 1) * 0.32); // dry and forward

  const { strings, tail } = pluckedString(v, bus, {
    t,
    f,
    shape: KOTO_SHAPE,
    peak: n.vel * 1.55, // struck near the bridge: bright, but thin on fundamental
    openHi: 16 + n.bright * 10,
    closeLo: 2.2, // a koto keeps its top long after a guitar has gone dull
    sweep: 1.1 - n.bright * 0.3,
    t60: 2.1 - n.bright * 0.6
  });

  // A struck koto string starts sharp and falls into pitch as the tension
  // settles; later the left hand presses down behind the bridge and lifts it
  // again. Bending the oscillators is exact — the delay line this replaced
  // could only bend by changing how long its own echo took.
  const sharp = Math.pow(2, (36 + v.rng() * 12) / 1200);
  const settled = t + 0.055 + v.rng() * 0.02;
  const pressAt = t + tail * 0.42;
  const press = Math.pow(2, 14 / 1200);
  for (const osc of strings) {
    osc.frequency.setValueAtTime(f * sharp, t);
    osc.frequency.exponentialRampToValueAtTime(f, settled);
    osc.frequency.setValueAtTime(f, pressAt);
    osc.frequency.exponentialRampToValueAtTime(f * press, pressAt + 0.18);
  }

  // The plectrum hitting the paulownia body under the string.
  const wood = ctx.createBiquadFilter();
  wood.type = "lowpass";
  wood.frequency.value = 320 + n.bright * 180;
  const woodGain = ctx.createGain();
  ramp(woodGain.gain, t, n.vel * 0.3, 0.001, 0.028);
  wood.connect(woodGain).connect(bus);
  burst(v, wood, t, 0.04);

  const nail = ctx.createBiquadFilter();
  nail.type = "bandpass";
  nail.frequency.value = 3200 + n.bright * 1800;
  nail.Q.value = 1.1;
  const nailGain = ctx.createGain();
  ramp(nailGain.gain, t, n.vel * 0.18, 0.0008, 0.008);
  nail.connect(nailGain).connect(bus);
  burst(v, nail, t, 0.015);
};

/** Rosewood bar over a tube: a knock, a fast 4th mode, and a hollow hoot. */
const marimba: Voice = (v, n) => {
  const { ctx } = v;
  const { t } = n;
  const f = midiToFreq(n.midi);
  const tail = 0.62 - n.bright * 0.18;
  const stopAt = t + tail + 0.35;

  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = Math.min(7000, f * (4.5 + n.bright * 3));
  tone.Q.value = 0.5;
  voiceOutput(v, tone, 0.24, (v.rng() * 2 - 1) * 0.35);

  const voice = (freq: number, level: number, attack: number, decay: number) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + attack);
    g.gain.setTargetAtTime(0.0001, t + attack + 0.004, decay);
    osc.connect(g).connect(tone);
    osc.start(t);
    osc.stop(stopAt);
  };
  voice(f, n.vel * 0.9, 0.004, tail / 4);
  voice(f * 3.9, n.vel * (0.34 + n.bright * 0.1), 0.003, 0.055); // the tuned bar mode
  // The resonator tube speaks a fraction late and hoots an octave under the bar;
  // low notes get less of it or the mix turns to mud.
  voice(f * 0.5, n.vel * 0.13 * Math.min(1, f / 200), 0.014, tail * 0.16);

  const knock = ctx.createBiquadFilter();
  knock.type = "bandpass";
  knock.frequency.value = 900 + n.bright * 900;
  knock.Q.value = 0.7;
  const knockGain = ctx.createGain();
  ramp(knockGain.gain, t, n.vel * 0.3, 0.001, 0.022);
  knock.connect(knockGain).connect(tone);
  burst(v, knock, t, 0.03);
};

export const KEYS_VOICES: Record<KeysVoiceId, Voice> = {
  rhodes,
  felt,
  vibes,
  nylon,
  celeste,
  reed,
  koto,
  marimba
};
