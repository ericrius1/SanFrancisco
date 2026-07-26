// Music theory for the generative score — pure math, no WebAudio, Node-safe.
//
// The director composes with five primitives from here: a chord built from a
// mode degree in one of several *voicing styles* (the same harmony spaced as
// thirds, fourths, a jazz shell or a cluster is what makes a place sound urban
// or vast), a voice-leading step that moves the previous voicing the shortest
// total distance onto the new chord, a scripted cadence that lets the harmony
// occasionally arrive somewhere instead of drifting forever, a bass line that
// can walk instead of pedalling, and a pentatonic subset for melodic sparkles
// that can never land outside the current key.

export type ModeName =
  | "lydian"
  | "ionian"
  | "mixolydian"
  | "dorian"
  | "aeolian"
  | "phrygian"
  | "harmonicMinor";

export const MODES: Record<ModeName, readonly number[]> = {
  lydian: [0, 2, 4, 6, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  // the ♭2 gives the Mission its doorway-flamenco colour
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  // the augmented 2nd is deliberate: gothic interiors and the island
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11]
};

export const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/* ---------------------------------------------------------------- chords */

/** Pitch classes of a chord stacked in thirds on a 0-based scale degree.
 *  size 3 = triad, 4 = seventh, 5 = ninth. First entry is the chord root. */
export function degreeChordPcs(
  rootPc: number,
  mode: readonly number[],
  degree: number,
  size: number
): number[] {
  return stepsToPcs(rootPc, mode, degree, THIRDS_STEPS.slice(0, size));
}

/** How the same harmony is spaced. Not decoration — spacing is most of why a
 *  place reads as a cathedral, a canyon or a warehouse. */
export type VoicingStyle = "thirds" | "quartal" | "shell" | "cluster" | "open";

export type Voicing = {
  /** pitch classes; first entry is the chord root. */
  pcs: number[];
  /** 0 = voices packed adjacent, 1 = voices thrown wide apart. */
  spread: number;
};

// scale-step offsets from the chord degree, per style
const THIRDS_STEPS = [0, 2, 4, 6, 8];
const QUARTAL_STEPS = [0, 3, 6, 9, 12]; // stacked fourths — open, modal, weightless
const SHELL_STEPS = [0, 2, 6, 8, 4]; // root, 3rd, 7th, 9th — the lean jazz shell
const CLUSTER_STEPS = [0, 1, 2, 4, 6]; // adjacent degrees — dense, urban, unresolved
const OPEN_STEPS = [0, 4, 1, 2, 6]; // root, 5th, 9th, 10th — air between every voice

const STYLE_STEPS: Record<VoicingStyle, readonly number[]> = {
  thirds: THIRDS_STEPS,
  quartal: QUARTAL_STEPS,
  shell: SHELL_STEPS,
  cluster: CLUSTER_STEPS,
  open: OPEN_STEPS
};

const STYLE_SPREAD: Record<VoicingStyle, number> = {
  thirds: 0.45,
  quartal: 0.78,
  shell: 0.6,
  cluster: 0.1,
  open: 0.92
};

function stepsToPcs(
  rootPc: number,
  mode: readonly number[],
  degree: number,
  steps: readonly number[]
): number[] {
  const out: number[] = [];
  for (const step of steps) {
    const pc = (rootPc + mode[(degree + step) % 7] + 120) % 12;
    if (!out.includes(pc)) out.push(pc);
  }
  return out;
}

export function buildVoicing(
  rootPc: number,
  mode: readonly number[],
  degree: number,
  size: number,
  style: VoicingStyle
): Voicing {
  const steps = STYLE_STEPS[style];
  const pcs = stepsToPcs(rootPc, mode, degree, steps.slice(0, Math.max(2, size)));
  return { pcs, spread: STYLE_SPREAD[style] };
}

/** Minimum semitones between adjacent voices for a given spread. Wide styles
 *  scale their demand back as voices are added — a five-note open stack at the
 *  four-note gap would span three octaves and stop sounding like one chord. */
export function gapForSpread(spread: number, voices = 4): number {
  const raw = 1 + Math.round(spread * 6);
  return Math.max(1, Math.min(raw, Math.round(22 / Math.max(1, voices - 1))));
}

/* -------------------------------------------------------- voice leading */

/** The realization of pitch-class `pc` nearest to `ref` (within a tritone). */
function nearestMidiOfClass(pc: number, ref: number): number {
  const up = ref + ((((pc - Math.round(ref)) % 12) + 12) % 12);
  return up - ref <= 6 ? up : up - 12;
}

/**
 * Move the previous voicing onto the new chord with minimal total motion.
 * Tries every rotation of the pitch-class list against the old voices and
 * keeps the cheapest assignment, then spaces the result out to `minGap`.
 * With no previous voicing, builds a compact ascending stack from `lo`.
 */
export function leadVoices(
  prev: readonly number[] | null,
  pcs: readonly number[],
  lo: number,
  hi: number,
  minGap = 1
): number[] {
  const n = pcs.length;
  if (n === 0) return [];
  if (!prev || prev.length === 0) {
    const out: number[] = [];
    let cursor = lo;
    for (const pc of pcs) {
      let m = cursor + ((((pc - cursor) % 12) + 12) % 12);
      while (out.includes(m)) m += 12;
      out.push(m);
      cursor = m + 1;
    }
    return space(out.sort((a, b) => a - b), lo, hi, minGap);
  }

  // resize the reference voicing to the new chord size
  const ref = [...prev].sort((a, b) => a - b);
  while (ref.length < n) ref.push(ref[ref.length - 1] + 4);
  ref.length = n;

  let best: number[] | null = null;
  let bestCost = Infinity;
  for (let r = 0; r < n; r++) {
    const cand: number[] = [];
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const m = clampOctave(nearestMidiOfClass(pcs[(i + r) % n], ref[i]), lo, hi);
      cost += Math.abs(m - ref[i]);
      cand.push(m);
    }
    // register clashes are dissonant mud in a slow pad — penalize hard
    const set = new Set(cand.map((m) => Math.round(m)));
    cost += (cand.length - set.size) * 24;
    if (cost < bestCost) {
      bestCost = cost;
      best = cand;
    }
  }
  return space((best ?? []).sort((a, b) => a - b), lo, hi, minGap);
}

/**
 * Push voices apart to at least `gap` semitones, then drop the whole stack by
 * octaves until it fits the window. Transposing the block (rather than octave-
 * wrapping individual voices, which is what a naive clamp does) is what keeps a
 * wide quartal voicing from collapsing into a cluster at the top of the range.
 */
function space(sorted: number[], lo: number, hi: number, gap: number): number[] {
  const n = sorted.length;
  if (n === 0) return sorted;
  const span = Math.max(1, hi - lo);
  // an over-wide request would never fit — relax the gap rather than mangle it
  const g = Math.max(1, Math.min(gap, Math.floor(span / Math.max(1, n - 1))));
  const out = [...sorted];
  for (let i = 1; i < n; i++) {
    while (out[i] < out[i - 1] + g) out[i] += 12;
  }
  // Slide the whole block into the window. Octave shifts only: moving voices
  // individually is what collapses a wide quartal stack back into a cluster,
  // and any non-octave nudge would silently change the harmony.
  while (out[n - 1] > hi && out[0] - 12 >= lo - 12) {
    for (let i = 0; i < n; i++) out[i] -= 12;
  }
  while (out[0] < lo && out[n - 1] + 12 <= hi + 12) {
    for (let i = 0; i < n; i++) out[i] += 12;
  }
  return out;
}

function clampOctave(m: number, lo: number, hi: number): number {
  let v = m;
  while (v < lo) v += 12;
  while (v > hi) v -= 12;
  return v;
}

/* ------------------------------------------------------------ progression */

/**
 * Weighted walk over scale degrees. Prefers the warm degrees (I, IV, vi, ii),
 * avoids restating the previous chord, and leans toward step/fourth motion —
 * the gentle circular drift that keeps a lo-fi bed moving without ever
 * arriving anywhere dramatic.
 */
export function pickNextDegree(
  prev: number,
  rng: () => number,
  mode?: readonly number[],
  brightness = 0
): number {
  const base = [3, 2, 1.4, 3, 1.8, 2.6, 0.35]; // I ii iii IV V vi vii°
  let total = 0;
  const w: number[] = [];
  for (let d = 0; d < 7; d++) {
    let weight = base[d];
    if (d === prev) weight *= 0.12;
    const interval = Math.min((d - prev + 7) % 7, (prev - d + 7) % 7);
    if (interval === 1 || interval === 3) weight *= 1.5; // steps + fourths flow
    // brightness 0 (the default) leaves the classic walk untouched; above 0
    // it leans toward major-triad degrees and away from minor/diminished ones
    if (mode && brightness > 0) {
      const third = (mode[(d + 2) % 7] - mode[d] + 12) % 12;
      const fifth = (mode[(d + 4) % 7] - mode[d] + 12) % 12;
      if (fifth === 6) weight *= Math.max(0.2, 1 - 0.5 * brightness);
      else if (third === 4) weight *= 1 + 0.5 * brightness;
      else if (third === 3 && fifth === 7) weight *= Math.max(0.3, 1 - 0.28 * brightness);
    }
    w.push(weight);
    total += weight;
  }
  let r = rng() * total;
  for (let d = 0; d < 7; d++) {
    r -= w[d];
    if (r <= 0) return d;
  }
  return 0;
}

/**
 * The cure for "generated" harmony: every so often the walk stops wandering and
 * plays a scripted arrival instead. Two or three chords that genuinely resolve,
 * a handful of times an hour, is the difference between a bed and a piece.
 * `warmth` picks the family — dark places get plagal and ♭II motion, bright
 * places get dominant motion.
 */
const CADENCES: readonly { steps: readonly number[]; home: number; label: string }[] = [
  { steps: [3, 0], home: 0.5, label: "plagal" }, // IV → I, the warm one
  { steps: [4, 0], home: 0.85, label: "authentic" }, // V → I
  { steps: [1, 4, 0], home: 0.72, label: "ii-V-I" },
  { steps: [5, 3, 0], home: 0.66, label: "vi-IV-I" },
  { steps: [3, 4, 0], home: 0.6, label: "IV-V-I" },
  { steps: [6, 0], home: 0.28, label: "bVII-I" }, // subtonic pull in the modal keys
  { steps: [1, 0], home: 0.08, label: "phrygian" } // ♭II → i
];

export type Cadence = { degrees: number[]; label: string };

export function pickCadence(rng: () => number, warmth: number): Cadence {
  let total = 0;
  const w: number[] = [];
  for (const c of CADENCES) {
    const weight = Math.max(0.05, 1 - Math.abs(c.home - warmth) * 1.6);
    w.push(weight);
    total += weight;
  }
  let r = rng() * total;
  for (let i = 0; i < CADENCES.length; i++) {
    r -= w[i];
    if (r <= 0) return { degrees: [...CADENCES[i].steps], label: CADENCES[i].label };
  }
  return { degrees: [...CADENCES[0].steps], label: CADENCES[0].label };
}

/* ------------------------------------------------------------------ bass */

export type BassStep = {
  /** fraction of the chord's duration at which this note lands. */
  at: number;
  midi: number;
  /** relative velocity, 1 = the downbeat root. */
  vel: number;
};

/**
 * Root pedal → walking line, continuous in `motion`. The last note of a walking
 * bar approaches the next chord's root by a semitone, which is the entire trick
 * that makes a bass line sound like it is going somewhere.
 */
export function bassLine(o: {
  chordPcs: readonly number[];
  keyRoot: number;
  mode: readonly number[];
  /** the root of the chord that follows, if the director has picked it. */
  nextRootPc: number | null;
  prevMidi: number | null;
  /** 0 = pedal, 1 = walking. */
  motion: number;
  rng: () => number;
  lo?: number;
  hi?: number;
}): BassStep[] {
  const lo = o.lo ?? 33;
  const hi = o.hi ?? 50;
  const rng = o.rng;
  const rootPc = o.chordPcs[0];
  const root = nearestInWindow(rootPc, o.prevMidi ?? (lo + hi) / 2, lo, hi);
  const steps: BassStep[] = [{ at: 0, midi: root, vel: 1 }];
  const m = Math.max(0, Math.min(1, o.motion));
  if (m < 0.18) return steps;

  const fifthPc = o.chordPcs[Math.min(2, o.chordPcs.length - 1)] ?? rootPc;
  const scale = o.mode.map((s) => (o.keyRoot + s) % 12);

  if (m < 0.5) {
    // a single answering tone in the back half — motion without a groove
    if (rng() < 0.35 + m) {
      steps.push({ at: 0.58 + rng() * 0.12, midi: nearestInWindow(fifthPc, root, lo, hi), vel: 0.7 });
    }
    return steps;
  }

  // three or four notes across the bar, ending on an approach to the next root
  const count = m < 0.78 ? 3 : 4;
  for (let i = 1; i < count; i++) {
    const at = i / count + (rng() - 0.5) * 0.05;
    const isLast = i === count - 1;
    let pc: number;
    if (isLast && o.nextRootPc != null) {
      // chromatic approach from whichever side is nearer
      pc = (o.nextRootPc + (rng() < 0.5 ? 1 : 11)) % 12;
    } else if (rng() < 0.62) {
      pc = o.chordPcs[Math.floor(rng() * o.chordPcs.length)];
    } else {
      pc = scale[Math.floor(rng() * scale.length)];
    }
    const prev = steps[steps.length - 1].midi;
    steps.push({ at, midi: nearestInWindow(pc, prev, lo, hi), vel: isLast ? 0.72 : 0.6 });
  }
  return steps;
}

function nearestInWindow(pc: number, ref: number, lo: number, hi: number): number {
  let m = nearestMidiOfClass(pc, ref);
  while (m < lo) m += 12;
  while (m > hi) m -= 12;
  return m;
}

/* ------------------------------------------------------------- melodic */

/** Major-flavoured pentatonic of the mode (degrees 1 2 3 5 6) — minor modes
 *  yield their natural minor pentatonic through the same degree picks. */
export function pentatonicPcs(rootPc: number, mode: readonly number[]): number[] {
  return [0, 1, 2, 4, 5].map((d) => (rootPc + mode[d]) % 12);
}

/**
 * The figure that plays once when a new region takes the key — a place saying
 * its own name. A rising pentatonic gesture in the new key, so the listener
 * hears the modulation as an event rather than noticing it three chords later.
 */
export function arrivalFigure(
  rootPc: number,
  mode: readonly number[],
  base: number,
  rng: () => number
): number[] {
  const penta = pentatonicPcs(rootPc, mode);
  const shape = rng() < 0.5 ? [0, 2, 4, 3] : [0, 1, 3, 4];
  let cursor = base;
  return shape.map((i) => {
    const m = nearestInWindow(penta[i % penta.length], cursor, base - 2, base + 22);
    cursor = m + 2;
    return m;
  });
}
