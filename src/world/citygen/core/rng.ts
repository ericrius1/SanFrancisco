// Deterministic RNG for the generator. Same (buildingSeed, ruleSalt) → same
// stream on every client and every visit, so generated geometry, colliders and
// interiors are byte-identical everywhere (multiplayer + AI-training safety).
//
// mulberry32: tiny, fast, good enough for cosmetic variation. Never use Math.random
// anywhere in citygen — all variation must flow from a building's `seed`.

export type Rng = () => number;

/** A fresh stream seeded by a building seed, salted per rule so independent
 *  decisions (palette vs bay-count vs trim) don't correlate. */
export function rng(seed: number, salt = 0): Rng {
  let a = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** integer in [lo, hi] inclusive */
export function randInt(r: Rng, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

/** pick one element deterministically */
export function pick<T>(r: Rng, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length) % arr.length];
}
