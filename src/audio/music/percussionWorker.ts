// Off-thread one-shot percussion synthesis for the procedural groove engine
// (./groove). This is the DSP that used to live in tools/music/render_stems.py
// ported to TypeScript — the same exponential kick sweep, the same 195 Hz rim
// body + 720 Hz knock + bandpassed snap, the same highpassed shaker — plus the
// extra voices the region kits need (snare, brushes, hats, congas, clave,
// woodblock, tom, tambourine, splash).
//
// Mirrors musicBuffersWorker exactly: one message in, transferred ArrayBuffers
// out, caller terminates. Nothing here is fetched and nothing runs at boot.
//
// Every drum ships 2-3 variants. Round-robin at playback is the single biggest
// thing that stops a synthesized kit reading as a drum machine, so variants are
// siblings — a few percent of pitch, decay and brightness apart — not clones.
// The seeds are fixed so an unload/rebuild produces the identical kit; the live
// *performance* variation belongs to groove.ts, not to the samples.

export type PercussionDrumId =
  | "kick"
  | "kickDeep"
  | "rim"
  | "rimSoft"
  | "snare"
  | "brushHit"
  | "brushSwirl"
  | "hatClosed"
  | "hatOpen"
  | "shakerClosed"
  | "shakerOpen"
  | "congaLo"
  | "congaHi"
  | "clave"
  | "woodblock"
  | "tomLo"
  | "tambourine"
  | "splash";

export type PercussionRequest = {
  sampleRate: number;
};

export type PercussionResult = {
  sampleRate: number;
  /** drum id → mono Float32 variants; playback round-robins them. */
  variants: Record<PercussionDrumId, ArrayBuffer[]>;
  /** total transferred bytes, for the runtime's debug/residency readout. */
  bytes: number;
};

/* ------------------------------------------------------------------ noise */

/** mulberry32 — small, fast, and seedable so the kit never drifts. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, matching numpy's standard_normal that every voice draws from. */
function gauss(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function noise(n: number, rng: () => number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = gauss(rng);
  return out;
}

function seconds(value: number, sr: number): number {
  return Math.max(1, Math.round(value * sr));
}

/** exp(-t/tau) as a per-sample multiplier — render_stems' env_exp, unrolled. */
function decayStep(tau: number, sr: number): number {
  return Math.exp(-1 / (sr * Math.max(1e-5, tau)));
}

/* ---------------------------------------------------------------- filters */
// A biquad cascade stands in for scipy.butter+sosfilt. Order 2 is exact (a
// Butterworth section is just Q = 1/√2); order 3 adds the real pole as a
// one-pole stage. Same causal single-pass behaviour as sosfilt, so the phase
// smear on the transients matches what the baked stems had.

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

function biquad(kind: "low" | "high" | "band", hz: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * Math.min(Math.max(hz, 10), sr * 0.49)) / sr;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const shared = { a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
  if (kind === "low") {
    const k = (1 - cw) / 2 / a0;
    return { b0: k, b1: 2 * k, b2: k, ...shared };
  }
  if (kind === "high") {
    const k = (1 + cw) / 2 / a0;
    return { b0: k, b1: -2 * k, b2: k, ...shared };
  }
  return { b0: alpha / a0, b1: 0, b2: -alpha / a0, ...shared };
}

function applyBiquad(x: Float32Array, f: Biquad): Float32Array {
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = f.b0 * v + z1;
    z1 = f.b1 * v - f.a1 * y + z2;
    z2 = f.b2 * v - f.a2 * y;
    x[i] = y;
  }
  return x;
}

const BUTTER_Q = Math.SQRT1_2;

function lowpass(x: Float32Array, hz: number, sr: number, order = 2): Float32Array {
  applyBiquad(x, biquad("low", hz, order >= 3 ? 1 : BUTTER_Q, sr));
  if (order < 3) return x;
  const c = Math.exp((-2 * Math.PI * Math.min(hz, sr * 0.49)) / sr);
  let lp = 0;
  for (let i = 0; i < x.length; i++) {
    lp = lp * c + x[i] * (1 - c);
    x[i] = lp;
  }
  return x;
}

function highpass(x: Float32Array, hz: number, sr: number, order = 2): Float32Array {
  applyBiquad(x, biquad("high", hz, order >= 3 ? 1 : BUTTER_Q, sr));
  if (order < 3) return x;
  const c = Math.exp((-2 * Math.PI * Math.min(hz, sr * 0.49)) / sr);
  let lp = 0;
  for (let i = 0; i < x.length; i++) {
    lp = lp * c + x[i] * (1 - c);
    x[i] -= lp;
  }
  return x;
}

/** scipy's 2nd-order band is 4th-order overall; HP→LP keeps that character. */
function bandpass(x: Float32Array, lo: number, hi: number, sr: number): Float32Array {
  return lowpass(highpass(x, lo, sr), Math.max(lo * 1.2, hi), sr);
}

function saturate(x: Float32Array, drive: number): Float32Array {
  const norm = 1 / Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) * norm;
  return x;
}

/* ----------------------------------------------------------------- voices */

/** Per-variant detune. Variant 0 is the reference — the exact tuned values. */
type Variation = { tune: number; decay: number; tone: number; level: number };

function variation(index: number, rng: () => number): Variation {
  const spread = index === 0 ? 0 : 1;
  return {
    tune: 1 + spread * (rng() - 0.5) * 0.07,
    decay: 1 + spread * (rng() - 0.5) * 0.22,
    tone: 1 + spread * (rng() - 0.5) * 0.18,
    level: 1 + spread * (rng() - 0.5) * 0.14
  };
}

function kick(rng: () => number, v: Variation, sr: number, deep: boolean): Float32Array {
  const n = seconds(deep ? 0.32 : 0.22, sr);
  const f0 = (deep ? 34 : 42) * v.tune;
  const f1 = (deep ? 82 : 96) * v.tune;
  const tau = (deep ? 0.055 : 0.04) * v.decay;
  const out = new Float32Array(n);
  const dec = decayStep((deep ? 0.16 : 0.11) * v.decay, sr);
  let phase = 0;
  let env = 1;
  for (let i = 0; i < n; i++) {
    // the drop is the sound: f0 + f1·exp(-t/tau), integrated into phase
    phase += (2 * Math.PI * (f0 + f1 * Math.exp(-i / (sr * tau)))) / sr;
    out[i] = Math.sin(phase) * env;
    env *= dec;
  }
  const click = highpass(noise(seconds(0.004, sr), rng), 1200, sr);
  for (let i = 0; i < click.length; i++) out[i] += click[i] * 0.18;
  return lowpass(saturate(out, 1.7), 2800 * v.tone, sr);
}

function rim(rng: () => number, v: Variation, sr: number, soft: boolean): Float32Array {
  const n = seconds(0.14, sr);
  const out = new Float32Array(n);
  const snap = bandpass(noise(n, rng), 900, 4200 * v.tone, sr);
  const wBody = (2 * Math.PI * 195 * v.tune) / sr;
  const wKnock = (2 * Math.PI * 720 * v.tune) / sr;
  const dBody = decayStep(0.045 * v.decay, sr);
  const dKnock = decayStep(0.012 * v.decay, sr);
  const dSnap = decayStep(0.028 * v.decay, sr);
  const knockLevel = soft ? 0.35 : 0.6;
  const snapLevel = soft ? 0.5 : 0.8;
  let eBody = 1;
  let eKnock = 1;
  let eSnap = 1;
  for (let i = 0; i < n; i++) {
    out[i] =
      Math.sin(wBody * i) * eBody * 0.7 +
      Math.sin(wKnock * i) * eKnock * knockLevel +
      snap[i] * eSnap * snapLevel;
    eBody *= dBody;
    eKnock *= dKnock;
    eSnap *= dSnap;
  }
  return lowpass(saturate(out, 1.4), 3600 * v.tone, sr);
}

function shaker(rng: () => number, v: Variation, sr: number, open: boolean): Float32Array {
  const n = seconds((open ? 0.16 : 0.05) * v.decay, sr);
  const out = highpass(noise(n, rng), 6200 * v.tone, sr, 3);
  const dec = decayStep((open ? 0.06 : 0.016) * v.decay, sr);
  const ramp = seconds(0.004, sr);
  let env = 1;
  for (let i = 0; i < n; i++) {
    out[i] *= env * Math.min(1, i / ramp) * 0.5;
    env *= dec;
  }
  return out;
}

/** Boom-bap snare: two short shells under a wide wire buzz and a stick crack. */
function snare(rng: () => number, v: Variation, sr: number): Float32Array {
  const n = seconds(0.3 * v.decay, sr);
  const out = new Float32Array(n);
  const w1 = (2 * Math.PI * 182 * v.tune) / sr;
  const w2 = (2 * Math.PI * 331 * v.tune) / sr;
  const dShell = decayStep(0.055 * v.decay, sr);
  let eShell = 1;
  for (let i = 0; i < n; i++) {
    out[i] = (Math.sin(w1 * i) * 0.6 + Math.sin(w2 * i) * 0.34) * eShell;
    eShell *= dShell;
  }
  const wires = bandpass(noise(n, rng), 1400, 7600 * v.tone, sr);
  const dWires = decayStep(0.11 * v.decay, sr);
  let eWires = 1;
  for (let i = 0; i < n; i++) {
    out[i] += wires[i] * eWires * 0.85;
    eWires *= dWires;
  }
  const crack = highpass(noise(seconds(0.006, sr), rng), 2600, sr);
  for (let i = 0; i < crack.length; i++) out[i] += crack[i] * 0.3;
  return lowpass(saturate(out, 1.6), 7200 * v.tone, sr);
}

/** Brush slap — no stick transient at all, a 3 ms swell into wire noise. */
function brushHit(rng: () => number, v: Variation, sr: number): Float32Array {
  const n = seconds(0.26 * v.decay, sr);
  const wires = bandpass(noise(n, rng), 700, 5200 * v.tone, sr);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * 186 * v.tune) / sr;
  const dWires = decayStep(0.075 * v.decay, sr);
  const dBody = decayStep(0.05 * v.decay, sr);
  const ramp = seconds(0.003, sr);
  let eWires = 1;
  let eBody = 1;
  for (let i = 0; i < n; i++) {
    const attack = Math.min(1, i / ramp);
    out[i] = (wires[i] * eWires * 0.9 + Math.sin(w * i) * eBody * 0.22) * attack;
    eWires *= dWires;
    eBody *= dBody;
  }
  return lowpass(saturate(out, 1.2), 5200 * v.tone, sr);
}

/** One circular sweep of the wire across the head — swells instead of decaying,
 *  which is what lets the brush kit sustain between backbeats. */
function brushSwirl(rng: () => number, v: Variation, sr: number): Float32Array {
  const n = seconds(0.9 * v.decay, sr);
  const out = bandpass(noise(n, rng), 900, 4200 * v.tone, sr);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out[i] *= Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 1.6) * 0.55;
  }
  return lowpass(out, 4800 * v.tone, sr);
}

/** 808-flavoured metal: six inharmonic squares whose aliased top end is band-
 *  limited into a dense metallic cluster. Cheaper and grittier than FM. */
function hat(rng: () => number, v: Variation, sr: number, open: boolean): Float32Array {
  const n = seconds((open ? 0.34 : 0.06) * v.decay, sr);
  const out = new Float32Array(n);
  const base = 40 * v.tune;
  for (const ratio of [2, 3, 4.16, 5.43, 6.79, 8.21]) {
    const w = (2 * Math.PI * base * ratio) / sr;
    for (let i = 0; i < n; i++) out[i] += Math.sin(w * i) >= 0 ? 0.16 : -0.16;
  }
  const air = noise(n, rng);
  for (let i = 0; i < n; i++) out[i] += air[i] * 0.25;
  // filters work in place; the band is what turns the square bank into metal
  const band = highpass(lowpass(out, 11500, sr), 7200 * v.tone, sr, 3);
  const dec = decayStep((open ? 0.16 : 0.018) * v.decay, sr);
  const ramp = seconds(0.001, sr);
  let env = 1;
  for (let i = 0; i < n; i++) {
    band[i] *= env * Math.min(1, i / ramp) * 0.6;
    env *= dec;
  }
  return band;
}

/** Membrane whose head tightens on the strike, so the pitch falls ~45 % in the
 *  first 12 ms. Quinto (hi) and conga (lo) differ only in tension. */
function conga(rng: () => number, v: Variation, sr: number, hi: boolean): Float32Array {
  const f0 = (hi ? 300 : 190) * v.tune;
  const n = seconds((hi ? 0.24 : 0.34) * v.decay, sr);
  const out = new Float32Array(n);
  const dBody = decayStep((hi ? 0.09 : 0.13) * v.decay, sr);
  const dOver = decayStep(0.03 * v.decay, sr);
  const wOver = (2 * Math.PI * f0 * 2.72) / sr;
  let phase = 0;
  let eBody = 1;
  let eOver = 1;
  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * (f0 + f0 * 0.45 * Math.exp(-i / (sr * 0.012)))) / sr;
    out[i] = Math.sin(phase) * eBody + Math.sin(wOver * i) * eOver * 0.16;
    eBody *= dBody;
    eOver *= dOver;
  }
  const slap = bandpass(noise(seconds(0.03, sr), rng), 1200, 5200 * v.tone, sr);
  const dSlap = decayStep(0.012, sr);
  let eSlap = 1;
  for (let i = 0; i < slap.length; i++) {
    out[i] += slap[i] * eSlap * 0.28;
    eSlap *= dSlap;
  }
  return lowpass(saturate(out, 1.3), 4600 * v.tone, sr);
}

/** Two rosewood sticks — a bright ring over a woody thud, both very short. */
function clave(rng: () => number, v: Variation, sr: number): Float32Array {
  const n = seconds(0.11 * v.decay, sr);
  const out = new Float32Array(n);
  const w1 = (2 * Math.PI * 2500 * v.tune) / sr;
  const w2 = (2 * Math.PI * 1180 * v.tune) / sr;
  const d1 = decayStep(0.014 * v.decay, sr);
  const d2 = decayStep(0.032 * v.decay, sr);
  let e1 = 1;
  let e2 = 1;
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(w1 * i) * e1 * 0.7 + Math.sin(w2 * i) * e2 * 0.45;
    e1 *= d1;
    e2 *= d2;
  }
  const tick = highpass(noise(seconds(0.002, sr), rng), 3000, sr);
  for (let i = 0; i < tick.length; i++) out[i] += tick[i] * 0.12;
  return lowpass(saturate(out, 1.2), 9000 * v.tone, sr);
}

/** Hollow block: same model as the clave, tuned down and damped harder. */
function woodblock(rng: () => number, v: Variation, sr: number): Float32Array {
  const n = seconds(0.09 * v.decay, sr);
  const out = new Float32Array(n);
  const w1 = (2 * Math.PI * 1050 * v.tune) / sr;
  const w2 = (2 * Math.PI * 1830 * v.tune) / sr;
  const d1 = decayStep(0.022 * v.decay, sr);
  const d2 = decayStep(0.007 * v.decay, sr);
  let e1 = 1;
  let e2 = 1;
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(w1 * i) * e1 * 0.72 + Math.sin(w2 * i) * e2 * 0.3;
    e1 *= d1;
    e2 *= d2;
  }
  const tick = highpass(noise(seconds(0.0025, sr), rng), 2400, sr);
  for (let i = 0; i < tick.length; i++) out[i] += tick[i] * 0.14;
  return lowpass(saturate(out, 1.25), 6200 * v.tone, sr);
}

/** Floor tom: the kick's sweep with a lazier fall and a boxy ring on top. */
function tomLo(rng: () => number, v: Variation, sr: number): Float32Array {
  const n = seconds(0.42 * v.decay, sr);
  const f0 = 92 * v.tune;
  const f1 = 58 * v.tune;
  const tau = 0.09 * v.decay;
  const out = new Float32Array(n);
  const dBody = decayStep(0.26 * v.decay, sr);
  const dOver = decayStep(0.09 * v.decay, sr);
  const wOver = (2 * Math.PI * f0 * 1.58) / sr;
  let phase = 0;
  let eBody = 1;
  let eOver = 1;
  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * (f0 + f1 * Math.exp(-i / (sr * tau)))) / sr;
    out[i] = Math.sin(phase) * eBody + Math.sin(wOver * i) * eOver * 0.14;
    eBody *= dBody;
    eOver *= dOver;
  }
  const head = highpass(noise(seconds(0.005, sr), rng), 900, sr);
  for (let i = 0; i < head.length; i++) out[i] += head[i] * 0.12;
  return lowpass(saturate(out, 1.35), 3000 * v.tone, sr);
}

/** A handful of jingles a few ms apart — the scatter is the whole difference
 *  between a tambourine and a shaker. */
function tambourine(rng: () => number, v: Variation, sr: number): Float32Array {
  const n = seconds(0.3 * v.decay, sr);
  const out = new Float32Array(n);
  for (let z = 0; z < 9; z++) {
    const at = Math.floor(rng() * seconds(0.02, sr));
    const len = seconds(0.02 + rng() * 0.05, sr);
    const grain = bandpass(noise(len, rng), 4200 + rng() * 2600, 11000 * v.tone, sr);
    const dec = decayStep(0.012 + rng() * 0.02, sr);
    let env = 1;
    for (let i = 0; i < len && at + i < n; i++) {
      out[at + i] += grain[i] * env * 0.4;
      env *= dec;
    }
  }
  const shimmer = bandpass(noise(n, rng), 5200, 12000 * v.tone, sr);
  const dec = decayStep(0.1 * v.decay, sr);
  let env = 1;
  for (let i = 0; i < n; i++) {
    out[i] += shimmer[i] * env * 0.22;
    env *= dec;
  }
  return highpass(out, 2400, sr);
}

/** Small splash: inharmonic metal partials over a wash that darkens as it
 *  falls (the running one-pole trick musicBuffersWorker uses on the impulse). */
function splash(rng: () => number, v: Variation, sr: number): Float32Array {
  const n = seconds(1.2 * v.decay, sr);
  const source = noise(n, rng);
  const out = new Float32Array(n);
  for (const [hz, level] of [
    [3120, 0.55],
    [4670, 0.44],
    [6210, 0.34],
    [8330, 0.26],
    [10450, 0.18]
  ] as const) {
    const band = applyBiquad(source.slice(), biquad("band", hz * v.tune, 7, sr));
    for (let i = 0; i < n; i++) out[i] += band[i] * level;
  }
  const wash = highpass(noise(n, rng), 2600, sr);
  const dec = decayStep(0.42 * v.decay, sr);
  const ramp = seconds(0.008, sr);
  let env = 1;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const cutoff = 8000 * Math.pow(env, 0.45) + 2600;
    const c = Math.exp((-2 * Math.PI * Math.min(cutoff, sr * 0.49)) / sr);
    lp = lp * c + wash[i] * (1 - c);
    out[i] = (out[i] * 0.7 + lp * 0.9) * env * Math.min(1, i / ramp);
    env *= dec;
  }
  return out;
}

/* ------------------------------------------------------------------- kit */

type DrumSpec = {
  /** round-robin depth; the long/rare voices settle for two. */
  variants: number;
  seed: number;
  render: (rng: () => number, v: Variation, sr: number) => Float32Array;
};

const DRUM_SPECS: Record<PercussionDrumId, DrumSpec> = {
  kick: { variants: 3, seed: 11, render: (r, v, sr) => kick(r, v, sr, false) },
  kickDeep: { variants: 3, seed: 23, render: (r, v, sr) => kick(r, v, sr, true) },
  rim: { variants: 3, seed: 31, render: (r, v, sr) => rim(r, v, sr, false) },
  rimSoft: { variants: 3, seed: 37, render: (r, v, sr) => rim(r, v, sr, true) },
  snare: { variants: 3, seed: 41, render: snare },
  brushHit: { variants: 3, seed: 47, render: brushHit },
  brushSwirl: { variants: 2, seed: 53, render: brushSwirl },
  hatClosed: { variants: 3, seed: 59, render: (r, v, sr) => hat(r, v, sr, false) },
  hatOpen: { variants: 3, seed: 61, render: (r, v, sr) => hat(r, v, sr, true) },
  shakerClosed: { variants: 3, seed: 67, render: (r, v, sr) => shaker(r, v, sr, false) },
  shakerOpen: { variants: 3, seed: 71, render: (r, v, sr) => shaker(r, v, sr, true) },
  congaLo: { variants: 3, seed: 73, render: (r, v, sr) => conga(r, v, sr, false) },
  congaHi: { variants: 3, seed: 79, render: (r, v, sr) => conga(r, v, sr, true) },
  clave: { variants: 3, seed: 83, render: clave },
  woodblock: { variants: 3, seed: 89, render: woodblock },
  tomLo: { variants: 2, seed: 97, render: tomLo },
  tambourine: { variants: 3, seed: 101, render: tambourine },
  splash: { variants: 2, seed: 103, render: splash }
};

export const PERCUSSION_DRUM_IDS = Object.keys(DRUM_SPECS) as PercussionDrumId[];

/** Normalize a drum's variants as a GROUP, so siblings keep their relative
 *  loudness while every drum arrives at the same headroom. Kit balance then
 *  lives in one place (groove.ts's trim table), not in the DSP. */
function renderDrum(spec: DrumSpec, sr: number): Float32Array[] {
  const rng = makeRng(spec.seed);
  const takes: Float32Array[] = [];
  let peak = 1e-9;
  for (let i = 0; i < spec.variants; i++) {
    const v = variation(i, rng);
    const take = spec.render(rng, v, sr);
    for (let s = 0; s < take.length; s++) take[s] *= v.level;
    for (let s = 0; s < take.length; s++) peak = Math.max(peak, Math.abs(take[s]));
    takes.push(take);
  }
  const norm = 0.98 / peak;
  for (const take of takes) {
    for (let s = 0; s < take.length; s++) take[s] *= norm;
  }
  return takes;
}

self.onmessage = (event: MessageEvent<PercussionRequest>) => {
  const sampleRate = Math.max(8_000, Math.min(192_000, Math.round(event.data.sampleRate)));
  const variants = {} as Record<PercussionDrumId, ArrayBuffer[]>;
  const transfer: ArrayBuffer[] = [];
  let bytes = 0;
  for (const id of PERCUSSION_DRUM_IDS) {
    const raw = renderDrum(DRUM_SPECS[id], sampleRate).map((take) => take.buffer as ArrayBuffer);
    for (const buffer of raw) {
      bytes += buffer.byteLength;
      transfer.push(buffer);
    }
    variants[id] = raw;
  }
  const result: PercussionResult = { sampleRate, variants, bytes };
  self.postMessage(result, { transfer });
};
