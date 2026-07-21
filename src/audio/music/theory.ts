// Music theory for the lo-fi soundscape — pure math, no WebAudio, Node-safe.
//
// The director composes with three primitives from here: a chord built by
// stacking thirds on a mode degree, a voice-leading step that moves the
// previous voicing the shortest total distance onto the new chord (the thing
// that makes slow ambient progressions sound intentional instead of random),
// and a pentatonic subset for melodic sparkles that can never land outside
// the current key.

export type ModeName = "lydian" | "ionian" | "mixolydian" | "dorian" | "aeolian";

export const MODES: Record<ModeName, readonly number[]> = {
  lydian: [0, 2, 4, 6, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10]
};

export const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** Pitch classes of a chord stacked in thirds on a 0-based scale degree.
 *  size 3 = triad, 4 = seventh, 5 = ninth. First entry is the chord root. */
export function degreeChordPcs(
  rootPc: number,
  mode: readonly number[],
  degree: number,
  size: number
): number[] {
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    const idx = degree + i * 2;
    const pc = (rootPc + mode[idx % 7] + 120) % 12;
    if (!out.includes(pc)) out.push(pc);
  }
  return out;
}

/** Major-flavoured pentatonic of the mode (degrees 1 2 3 5 6) — minor modes
 *  yield their natural minor pentatonic through the same degree picks. */
export function pentatonicPcs(rootPc: number, mode: readonly number[]): number[] {
  return [0, 1, 2, 4, 5].map((d) => (rootPc + mode[d]) % 12);
}

/** The realization of pitch-class `pc` nearest to `ref` (within a tritone). */
function nearestMidiOfClass(pc: number, ref: number): number {
  const up = ref + ((((pc - Math.round(ref)) % 12) + 12) % 12);
  return up - ref <= 6 ? up : up - 12;
}

/**
 * Move the previous voicing onto the new chord with minimal total motion.
 * Tries every rotation of the pitch-class list against the old voices and
 * keeps the cheapest assignment, then resolves register clashes upward.
 * With no previous voicing, builds a compact ascending stack from `lo`.
 */
export function leadVoices(
  prev: readonly number[] | null,
  pcs: readonly number[],
  lo: number,
  hi: number
): number[] {
  const n = pcs.length;
  if (!prev || prev.length === 0) {
    const out: number[] = [];
    let cursor = lo;
    for (const pc of pcs) {
      let m = cursor + ((((pc - cursor) % 12) + 12) % 12);
      while (out.includes(m)) m += 12;
      out.push(m);
      cursor = m + 1;
    }
    return out.map((m) => clampOctave(m, lo, hi)).sort((a, b) => a - b);
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
  const out = (best ?? []).sort((a, b) => a - b);
  for (let i = 1; i < out.length; i++) {
    while (out[i] <= out[i - 1]) out[i] += 12;
    if (out[i] > hi) out[i] = clampOctave(out[i], lo, hi);
  }
  return out;
}

function clampOctave(m: number, lo: number, hi: number): number {
  let v = m;
  while (v < lo) v += 12;
  while (v > hi) v -= 12;
  return v;
}

/**
 * Weighted walk over scale degrees. Prefers the warm degrees (I, IV, vi, ii),
 * avoids restating the previous chord, and leans toward step/fourth motion —
 * the gentle circular drift that keeps a lo-fi bed moving without ever
 * arriving anywhere dramatic.
 */
export function pickNextDegree(prev: number, rng: () => number): number {
  const base = [3, 2, 1.4, 3, 1.8, 2.6, 0.35]; // I ii iii IV V vi vii°
  let total = 0;
  const w: number[] = [];
  for (let d = 0; d < 7; d++) {
    let weight = base[d];
    if (d === prev) weight *= 0.12;
    const interval = Math.min((d - prev + 7) % 7, (prev - d + 7) % 7);
    if (interval === 1 || interval === 3) weight *= 1.5; // steps + fourths flow
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
