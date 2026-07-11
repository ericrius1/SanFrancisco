// Procedural nature "voices" — short synthesized animal/insect calls, no
// samples. Each call is built live from oscillators and filtered noise with
// every parameter randomized inside a species range, so no two calls are ever
// identical and a soundscape running for an hour never audibly loops. This is
// what keeps the beds (looped ambience) from getting boring: the sampled forest
// wash carries the "body", these carry the ever-changing foreground life.
//
// A voice function draws its whole graph into a caller-owned node (`out`, a
// spatial panner) and returns its total duration in seconds so the scheduler
// knows when to tear the panner down. All timing is on the AudioContext clock
// (t0 + offsets), so calls schedule cleanly ahead of the audio thread.

export type NatureVoiceKind =
  | "songbird"
  | "sparrow"
  | "warble"
  | "dove"
  | "crow"
  | "gull"
  | "hawk"
  | "woodpecker"
  | "quail"
  | "owl"
  | "frog"
  | "cricketChirp"
  | "bee"
  | "foghorn";

/** Dog voices are deliberately separate from NatureVoiceKind so a bark can
 * never leak into a region's weighted wildlife palette. */
export type DogVoiceKind =
  | "goldenBark"
  | "collieBark"
  | "terrierBark"
  | "corgiBark"
  | "dogHuff";

export type VoiceCtx = {
  ctx: AudioContext;
  /** Connect the voice's graph here — the scheduler owns this (a PannerNode). */
  out: AudioNode;
  /** AudioContext time to begin. */
  t0: number;
  /** Shared looping white-noise buffer (built once by the engine). */
  noise: AudioBuffer;
  /** 0..1 uniform RNG (defaults to Math.random; injectable for tests). */
  rng: () => number;
  /** Overall gain scalar for this call (region weight × tuning × distance-safe). */
  level: number;
};

export type VoiceFn = (v: VoiceCtx) => number;

/* --------------------------------------------------------------- primitives */

const rand = (rng: () => number, a: number, b: number) => a + (b - a) * rng();
const randInt = (rng: () => number, a: number, b: number) => Math.floor(rand(rng, a, b + 1));
const pick = <T,>(rng: () => number, xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
const EPS = 0.0001;

/** One tonal note with an attack/decay envelope, optional pitch glide, vibrato,
 *  and FM sparkle. Returns the note end time. */
function note(
  v: VoiceCtx,
  o: {
    t: number;
    dur: number;
    f0: number;
    f1?: number;
    type?: OscillatorType;
    gain?: number;
    attack?: number;
    vibHz?: number;
    vibDepth?: number;
    fmRatio?: number;
    fmIndex?: number;
  }
): number {
  const { ctx, out } = v;
  const t = o.t;
  const dur = o.dur;
  const g = ctx.createGain();
  g.connect(out);
  const osc = ctx.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.f0, t);
  if (o.f1 && o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + dur);
  osc.connect(g);

  const peak = Math.max(EPS * 2, (o.gain ?? 0.3) * v.level);
  const a = Math.min(o.attack ?? 0.008, dur * 0.4);
  g.gain.setValueAtTime(EPS, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);

  if (o.vibHz) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = o.vibHz;
    const lg = ctx.createGain();
    lg.gain.value = o.vibDepth ?? o.f0 * 0.02;
    lfo.connect(lg).connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + dur + 0.03);
  }
  if (o.fmRatio) {
    const m = ctx.createOscillator();
    m.frequency.value = o.f0 * o.fmRatio;
    const mg = ctx.createGain();
    mg.gain.value = o.f0 * (o.fmIndex ?? 0.1);
    m.connect(mg).connect(osc.frequency);
    m.start(t);
    m.stop(t + dur + 0.03);
  }
  osc.start(t);
  osc.stop(t + dur + 0.03);
  return t + dur;
}

/** A filtered-noise burst — the raspy/breathy half of most animal calls. The
 *  band centre can sweep (f0→f1) and wobble (vibrato) for screeches and caws. */
function band(
  v: VoiceCtx,
  o: {
    t: number;
    dur: number;
    f0: number;
    f1?: number;
    q?: number;
    gain?: number;
    type?: BiquadFilterType;
    attack?: number;
    vibHz?: number;
    vibDepth?: number;
  }
): number {
  const { ctx, out, noise } = v;
  const t = o.t;
  const dur = o.dur;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = o.type ?? "bandpass";
  bp.Q.value = o.q ?? 4;
  bp.frequency.setValueAtTime(o.f0, t);
  if (o.f1 && o.f1 !== o.f0) bp.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + dur);
  const g = ctx.createGain();
  const peak = Math.max(EPS * 2, (o.gain ?? 0.3) * v.level);
  const a = Math.min(o.attack ?? Math.min(0.02, dur * 0.25), dur * 0.5);
  g.gain.setValueAtTime(EPS, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);
  src.connect(bp).connect(g).connect(out);

  let lfo: OscillatorNode | null = null;
  let lg: GainNode | null = null;
  if (o.vibHz) {
    lfo = ctx.createOscillator();
    lfo.frequency.value = o.vibHz;
    lg = ctx.createGain();
    lg.gain.value = o.vibDepth ?? o.f0 * 0.06;
    lfo.connect(lg).connect(bp.frequency);
    lfo.start(t);
    lfo.stop(t + dur + 0.03);
  }
  src.start(t, v.rng() * 0.5);
  src.stop(t + dur + 0.03);
  src.onended = () => {
    src.disconnect();
    bp.disconnect();
    g.disconnect();
    lfo?.disconnect();
    lg?.disconnect();
  };
  return t + dur;
}

/* ------------------------------------------------------------------ voices */

// Small melodic songbird phrase: a random walk of glided notes with sparkle.
const songbird: VoiceFn = (v) => {
  const n = randInt(v.rng, 3, 6);
  let f = rand(v.rng, 2000, 3200);
  let t = v.t0;
  for (let i = 0; i < n; i++) {
    const dur = rand(v.rng, 0.05, 0.13);
    const f0 = f * rand(v.rng, 0.85, 1.18);
    const f1 = f0 * pick(v.rng, [0.6, 0.72, 1.28, 1.55]);
    note(v, {
      t,
      dur,
      f0,
      f1,
      type: "triangle",
      gain: 0.32,
      vibHz: v.rng() < 0.4 ? rand(v.rng, 32, 60) : 0,
      vibDepth: f0 * 0.03,
      fmRatio: 2.0,
      fmIndex: 0.14
    });
    t += dur + rand(v.rng, 0.03, 0.11);
    f = f0;
  }
  return t - v.t0;
};

// Terse "chip chip" of a house sparrow.
const sparrow: VoiceFn = (v) => {
  const n = randInt(v.rng, 2, 4);
  const base = rand(v.rng, 2600, 3500);
  let t = v.t0;
  for (let i = 0; i < n; i++) {
    const dur = rand(v.rng, 0.03, 0.06);
    note(v, { t, dur, f0: base * rand(v.rng, 0.95, 1.06), f1: base * 0.78, type: "square", gain: 0.14 });
    t += dur + rand(v.rng, 0.05, 0.12);
  }
  return t - v.t0;
};

// Wren-style fast trill capped with a falling flourish.
const warble: VoiceFn = (v) => {
  const dur = rand(v.rng, 0.28, 0.5);
  const carrier = rand(v.rng, 3000, 4200);
  const t = v.t0;
  const g = v.ctx.createGain();
  g.connect(v.out);
  const osc = v.ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(carrier, t);
  osc.frequency.linearRampToValueAtTime(carrier * rand(v.rng, 0.9, 1.12), t + dur);
  osc.connect(g);
  const peak = Math.max(EPS * 2, 0.22 * v.level);
  g.gain.setValueAtTime(EPS, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
  // tremolo = the trill
  const trem = v.ctx.createOscillator();
  trem.type = "sine";
  trem.frequency.value = rand(v.rng, 26, 46);
  const tg = v.ctx.createGain();
  tg.gain.value = peak * 0.9;
  trem.connect(tg).connect(g.gain);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);
  osc.start(t);
  osc.stop(t + dur + 0.03);
  trem.start(t);
  trem.stop(t + dur + 0.03);
  // flourish
  note(v, { t: t + dur + 0.02, dur: 0.09, f0: carrier * 1.1, f1: carrier * 0.7, type: "triangle", gain: 0.24 });
  return dur + 0.14;
};

// Mourning dove: a rising intro coo then three falling coos.
const dove: VoiceFn = (v) => {
  const f = rand(v.rng, 470, 600);
  let t = v.t0;
  note(v, { t, dur: 0.18, f0: f * 0.9, f1: f * 1.07, type: "sine", gain: 0.3, attack: 0.05 });
  t += 0.3;
  for (let i = 0; i < 3; i++) {
    note(v, { t, dur: 0.22, f0: f, f1: f * 0.9, type: "sine", gain: 0.26 - i * 0.04, attack: 0.05 });
    t += 0.28;
  }
  return t - v.t0;
};

// Harsh crow caws: sawtooth body + noisy rasp, descending.
const crow: VoiceFn = (v) => {
  const n = randInt(v.rng, 1, 3);
  let t = v.t0;
  for (let i = 0; i < n; i++) {
    const dur = rand(v.rng, 0.16, 0.3);
    const f = rand(v.rng, 520, 760);
    note(v, { t, dur, f0: f, f1: f * 0.82, type: "sawtooth", gain: 0.2 });
    band(v, { t, dur: dur * 0.9, f0: 1200, q: 1.4, gain: 0.13 });
    t += dur + rand(v.rng, 0.12, 0.26);
  }
  return t - v.t0;
};

// Laughing-gull descending accelerating series — a coastal sound.
const gull: VoiceFn = (v) => {
  const n = randInt(v.rng, 4, 7);
  let t = v.t0;
  let f = rand(v.rng, 1000, 1400);
  let gap = rand(v.rng, 0.14, 0.2);
  for (let i = 0; i < n; i++) {
    const dur = rand(v.rng, 0.07, 0.11);
    note(v, { t, dur, f0: f, f1: f * 0.7, type: "sawtooth", gain: 0.16, vibHz: 60, vibDepth: f * 0.03 });
    t += dur + gap;
    f *= rand(v.rng, 0.9, 0.98);
    gap *= 0.86;
  }
  return t - v.t0;
};

// Red-tailed hawk: one long raspy descending scream. The iconic wild raptor.
const hawk: VoiceFn = (v) => {
  const dur = rand(v.rng, 0.8, 1.3);
  const f0 = rand(v.rng, 3200, 3800);
  const f1 = f0 * rand(v.rng, 0.45, 0.55);
  band(v, { t: v.t0, dur, f0, f1, q: 6, gain: 0.2, attack: 0.04, vibHz: rand(v.rng, 6, 9), vibDepth: f0 * 0.05 });
  note(v, { t: v.t0, dur, f0: f0 * 0.5, f1: f1 * 0.5, type: "sawtooth", gain: 0.05, attack: 0.05 });
  return dur;
};

// Woodpecker drum roll: a rapid decelerating burst of filtered clicks.
const woodpecker: VoiceFn = (v) => {
  const n = randInt(v.rng, 8, 15);
  let t = v.t0;
  let interval = rand(v.rng, 0.03, 0.05);
  const f = rand(v.rng, 900, 1500);
  for (let i = 0; i < n; i++) {
    band(v, { t, dur: 0.014, f0: f, q: 1, gain: 0.18, type: "bandpass" });
    t += interval;
    interval *= 1.012;
  }
  return t - v.t0;
};

// California quail "chi-ca-go" three-note.
const quail: VoiceFn = (v) => {
  let t = v.t0;
  const b = rand(v.rng, 0.9, 1.15);
  note(v, { t, dur: 0.09, f0: 1500 * b, f1: 1700 * b, type: "triangle", gain: 0.16 });
  t += 0.13;
  note(v, { t, dur: 0.11, f0: 2000 * b, f1: 2200 * b, type: "triangle", gain: 0.22 });
  t += 0.15;
  note(v, { t, dur: 0.13, f0: 1300 * b, f1: 1100 * b, type: "triangle", gain: 0.17 });
  return t + 0.13 - v.t0;
};

// Great horned owl: soft "hoo, hoo-hoo, hoo" pattern. Night.
const owl: VoiceFn = (v) => {
  const f = rand(v.rng, 360, 470);
  const gaps = [0.3, 0.14, 0.3];
  let t = v.t0;
  const hoot = (tt: number) => {
    note(v, { t: tt, dur: 0.22, f0: f, f1: f * 0.97, type: "sine", gain: 0.28, attack: 0.06, vibHz: 5, vibDepth: f * 0.01 });
    band(v, { t: tt, dur: 0.2, f0: 480, q: 0.8, gain: 0.025, type: "lowpass" });
  };
  for (let i = 0; i < 4; i++) {
    hoot(t);
    t += 0.22 + gaps[Math.min(gaps.length - 1, i)];
  }
  return t - v.t0;
};

// Frog croak: low AM-buzzed pulses through a lowpass. Night meadow / water.
const frog: VoiceFn = (v) => {
  const n = randInt(v.rng, 2, 5);
  const base = rand(v.rng, 150, 250);
  let t = v.t0;
  for (let i = 0; i < n; i++) {
    const dur = rand(v.rng, 0.1, 0.16);
    const g = v.ctx.createGain();
    const lp = v.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 520;
    const osc = v.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = base * rand(v.rng, 0.95, 1.06);
    const trem = v.ctx.createOscillator();
    trem.type = "square";
    trem.frequency.value = rand(v.rng, 26, 36);
    const tg = v.ctx.createGain();
    const peak = Math.max(EPS * 2, 0.14 * v.level);
    tg.gain.value = peak;
    trem.connect(tg).connect(g.gain);
    g.gain.setValueAtTime(EPS, t);
    osc.connect(lp).connect(g).connect(v.out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    trem.start(t);
    trem.stop(t + dur + 0.02);
    t += dur + rand(v.rng, 0.05, 0.12);
  }
  return t - v.t0;
};

// A single close cricket — tight high pulse train, sparse accent over the bed.
const cricketChirp: VoiceFn = (v) => {
  const n = randInt(v.rng, 3, 6);
  const base = rand(v.rng, 4200, 4800);
  let t = v.t0;
  for (let i = 0; i < n; i++) {
    band(v, { t, dur: 0.008, f0: base, q: 12, gain: 0.1 });
    t += 0.028;
  }
  return t - v.t0;
};

// Passing insect drone (bee/fly) — buzzy AM sawtooth, daytime.
const bee: VoiceFn = (v) => {
  const dur = rand(v.rng, 0.6, 1.1);
  const base = rand(v.rng, 180, 250);
  const t = v.t0;
  const g = v.ctx.createGain();
  const lp = v.ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 950;
  const osc = v.ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(base, t);
  osc.frequency.linearRampToValueAtTime(base * 1.12, t + dur);
  const trem = v.ctx.createOscillator();
  trem.type = "sine";
  trem.frequency.value = rand(v.rng, 45, 70);
  const tg = v.ctx.createGain();
  const peak = Math.max(EPS * 2, 0.06 * v.level);
  tg.gain.value = peak;
  trem.connect(tg).connect(g.gain);
  g.gain.setValueAtTime(peak * 0.5, t);
  g.gain.linearRampToValueAtTime(peak, t + dur * 0.4);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);
  osc.connect(lp).connect(g).connect(v.out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  trem.start(t);
  trem.stop(t + dur + 0.02);
  return dur;
};

// Distant foghorn — a rare two-tone low swell for the coast at night / in fog.
const foghorn: VoiceFn = (v) => {
  const dur = rand(v.rng, 1.4, 2.2);
  const f = pick(v.rng, [104, 118, 130]);
  const t = v.t0;
  const g = v.ctx.createGain();
  g.connect(v.out);
  const peak = Math.max(EPS * 2, 0.32 * v.level);
  g.gain.setValueAtTime(EPS, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.4);
  g.gain.setValueAtTime(peak, t + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);
  for (const mult of [1, 1.5]) {
    const osc = v.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = f * mult;
    const og = v.ctx.createGain();
    og.gain.value = mult === 1 ? 1 : 0.5;
    osc.connect(og).connect(g);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
  return dur;
};

type BarkProfile = {
  fundamental: readonly [number, number];
  duration: readonly [number, number];
  pitchDrop: readonly [number, number];
  bodyCutoff: readonly [number, number];
  formant: readonly [number, number];
  rasp: readonly [number, number];
  voicedMix: number;
  formantMix: number;
  raspMix: number;
  output: number;
  doubleChance: number;
  tripleChance: number;
  gap: readonly [number, number];
};

/**
 * A bark is a short glottal pitch-drop plus two bits of anatomy: a resonant
 * muzzle/chest formant and a breathy noise burst. Breed profiles move all three
 * together instead of merely pitch-shifting one generic clip. Every call also
 * varies pitch, duration, cadence, formant and rasp, so even repeated barks by
 * the same dog do not produce an audible sample-gun pattern.
 */
function dogBark(profile: BarkProfile): VoiceFn {
  return (v) => {
    const phraseRoll = v.rng();
    const count =
      phraseRoll < profile.tripleChance
        ? 3
        : phraseRoll < profile.tripleChance + profile.doubleChance
          ? 2
          : 1;
    let t = v.t0;
    let end = t;
    for (let i = 0; i < count; i++) {
      const dur = rand(v.rng, profile.duration[0], profile.duration[1]);
      const f0 = rand(v.rng, profile.fundamental[0], profile.fundamental[1]);
      const drop = rand(v.rng, profile.pitchDrop[0], profile.pitchDrop[1]);
      const strength = profile.output * (1 - i * 0.08) * rand(v.rng, 0.88, 1.08);
      const ctx = v.ctx;
      const envelope = ctx.createGain();
      const peak = Math.max(EPS * 2, v.level * strength);
      envelope.gain.setValueAtTime(EPS, t);
      envelope.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.009, dur * 0.16));
      envelope.gain.exponentialRampToValueAtTime(peak * 0.42, t + dur * 0.56);
      envelope.gain.exponentialRampToValueAtTime(EPS, t + dur);
      envelope.connect(v.out);

      // Glottal body: a slightly detuned saw + triangle pair falling together.
      const body = ctx.createBiquadFilter();
      body.type = "lowpass";
      body.frequency.setValueAtTime(
        rand(v.rng, profile.bodyCutoff[0], profile.bodyCutoff[1]),
        t
      );
      body.Q.value = 0.72;
      const bodyGain = ctx.createGain();
      bodyGain.gain.value = profile.voicedMix;
      body.connect(bodyGain).connect(envelope);
      const fundamental = ctx.createOscillator();
      fundamental.type = "sawtooth";
      fundamental.frequency.setValueAtTime(f0 * rand(v.rng, 1.05, 1.18), t);
      fundamental.frequency.exponentialRampToValueAtTime(f0 * drop, t + dur);
      fundamental.detune.value = rand(v.rng, -18, 18);
      fundamental.connect(body);
      const overtone = ctx.createOscillator();
      overtone.type = "triangle";
      overtone.frequency.setValueAtTime(f0 * rand(v.rng, 1.92, 2.08), t);
      overtone.frequency.exponentialRampToValueAtTime(f0 * drop * 1.72, t + dur);
      overtone.detune.value = rand(v.rng, -28, 28);
      const overtoneGain = ctx.createGain();
      overtoneGain.gain.value = 0.24;
      overtone.connect(overtoneGain).connect(body);

      // Chest/muzzle resonance: the breed's characteristic "aw/arf/yap" vowel.
      const formant = ctx.createBiquadFilter();
      formant.type = "bandpass";
      formant.frequency.setValueAtTime(rand(v.rng, profile.formant[0], profile.formant[1]), t);
      formant.Q.value = rand(v.rng, 1.1, 1.8);
      const formantGain = ctx.createGain();
      formantGain.gain.value = profile.formantMix;
      fundamental.connect(formant).connect(formantGain).connect(envelope);

      // Air/teeth transient: shared noise, individually filtered for every bark.
      const noise = ctx.createBufferSource();
      noise.buffer = v.noise;
      noise.loop = true;
      const rasp = ctx.createBiquadFilter();
      rasp.type = "bandpass";
      const raspStart = rand(v.rng, profile.rasp[0], profile.rasp[1]);
      rasp.frequency.setValueAtTime(raspStart, t);
      rasp.frequency.exponentialRampToValueAtTime(Math.max(120, raspStart * rand(v.rng, 0.58, 0.78)), t + dur);
      rasp.Q.value = rand(v.rng, 0.7, 1.25);
      const raspGain = ctx.createGain();
      raspGain.gain.value = profile.raspMix;
      noise.connect(rasp).connect(raspGain).connect(envelope);

      fundamental.start(t);
      overtone.start(t);
      noise.start(t, v.rng() * 0.6);
      fundamental.stop(t + dur + 0.025);
      overtone.stop(t + dur + 0.025);
      noise.stop(t + dur + 0.025);
      fundamental.onended = () => {
        fundamental.disconnect();
        overtone.disconnect();
        overtoneGain.disconnect();
        noise.disconnect();
        rasp.disconnect();
        raspGain.disconnect();
        formant.disconnect();
        formantGain.disconnect();
        body.disconnect();
        bodyGain.disconnect();
        envelope.disconnect();
      };
      end = t + dur;
      t = end + rand(v.rng, profile.gap[0], profile.gap[1]);
    }
    return end - v.t0;
  };
}

// Warm, chesty and mostly single: the largest dog carries the lowest formant.
const goldenBark = dogBark({
  fundamental: [145, 215],
  duration: [0.15, 0.22],
  pitchDrop: [0.52, 0.66],
  bodyCutoff: [920, 1320],
  formant: [430, 680],
  rasp: [720, 1250],
  voicedMix: 0.74,
  formantMix: 0.38,
  raspMix: 0.42,
  output: 0.92,
  doubleChance: 0.14,
  tripleChance: 0.01,
  gap: [0.14, 0.23]
});

// Alert, crisp and more likely to answer twice than the retriever.
const collieBark = dogBark({
  fundamental: [245, 350],
  duration: [0.095, 0.15],
  pitchDrop: [0.58, 0.73],
  bodyCutoff: [1350, 2050],
  formant: [760, 1160],
  rasp: [1150, 1950],
  voicedMix: 0.62,
  formantMix: 0.3,
  raspMix: 0.5,
  output: 0.8,
  doubleChance: 0.28,
  tripleChance: 0.03,
  gap: [0.1, 0.17]
});

// Scrappy high yaps, with the widest phrase-count variation but lower output.
const terrierBark = dogBark({
  fundamental: [420, 620],
  duration: [0.052, 0.09],
  pitchDrop: [0.62, 0.79],
  bodyCutoff: [2200, 3400],
  formant: [1450, 2300],
  rasp: [2050, 3400],
  voicedMix: 0.52,
  formantMix: 0.26,
  raspMix: 0.62,
  output: 0.61,
  doubleChance: 0.4,
  tripleChance: 0.12,
  gap: [0.065, 0.115]
});

// Short-legged but not tiny-sounding: a compact, throaty mid-high "arf".
const corgiBark = dogBark({
  fundamental: [295, 430],
  duration: [0.082, 0.13],
  pitchDrop: [0.54, 0.7],
  bodyCutoff: [1550, 2450],
  formant: [900, 1450],
  rasp: [1350, 2450],
  voicedMix: 0.66,
  formantMix: 0.34,
  raspMix: 0.54,
  output: 0.72,
  doubleChance: 0.32,
  tripleChance: 0.04,
  gap: [0.085, 0.145]
});

// Soft close-range huff/snuffle for catches and completed returns. It adds a
// second, less attention-grabbing dog sound so every fetch does not demand a
// bark. Kept out of nature palettes and spatialized on the actual dog.
const dogHuff: VoiceFn = (v) => {
  const t = v.t0;
  const dur = rand(v.rng, 0.16, 0.25);
  band(v, {
    t,
    dur,
    f0: rand(v.rng, 520, 760),
    f1: rand(v.rng, 260, 410),
    q: 0.72,
    gain: 0.24,
    attack: rand(v.rng, 0.015, 0.03)
  });
  if (v.rng() < 0.35) {
    band(v, {
      t: t + dur * 0.38,
      dur: dur * 0.62,
      f0: rand(v.rng, 360, 520),
      f1: rand(v.rng, 220, 330),
      q: 0.65,
      gain: 0.12,
      attack: 0.018
    });
  }
  return dur;
};

/** Map authored breed names to stable voices; scale keeps future dog styles
 * useful until they receive their own profile. */
export function dogVoiceForStyle(name: string, scale: number): Exclude<DogVoiceKind, "dogHuff"> {
  switch (name) {
    case "golden":
      return "goldenBark";
    case "border_collie":
      return "collieBark";
    case "terrier":
      return "terrierBark";
    case "corgi":
      return "corgiBark";
    default:
      return scale < 0.8 ? "terrierBark" : scale < 0.95 ? "corgiBark" : scale > 1.08 ? "goldenBark" : "collieBark";
  }
}

export const DOG_VOICE_LIB: Record<DogVoiceKind, VoiceFn> = {
  goldenBark,
  collieBark,
  terrierBark,
  corgiBark,
  dogHuff
};

export const VOICE_LIB: Record<NatureVoiceKind, VoiceFn> = {
  songbird,
  sparrow,
  warble,
  dove,
  crow,
  gull,
  hawk,
  woodpecker,
  quail,
  owl,
  frog,
  cricketChirp,
  bee,
  foghorn
};

/** Voices that make sense as a call-and-response "answer" from a second bird. */
export const RESPONDER_KINDS: ReadonlySet<NatureVoiceKind> = new Set([
  "songbird",
  "sparrow",
  "warble",
  "dove",
  "crow",
  "gull",
  "quail",
  "owl"
]);
