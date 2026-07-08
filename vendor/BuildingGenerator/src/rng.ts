/**
 * Blender-style Random Value: a pure function of (element id, seed).
 * Matches the structure of the geometry-nodes graph — nodes sharing a seed see the
 * same underlying random stream, which the original file relies on (e.g. wall panel
 * and window-guard variants are matched by reusing one random value).
 */

function hashU32(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x165667b1, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h = h ^ (h >>> 16);
  return h >>> 0;
}

export function hash01(id: number, seed: number): number {
  return hashU32(id, seed) / 4294967296;
}

/** extra decorrelates multiple outputs/uses that Blender separates internally */
export function hash01x(id: number, seed: number, extra: number): number {
  return hashU32(hashU32(id, extra), seed) / 4294967296;
}

export function randBool(p: number, id: number, seed: number): boolean {
  return hash01(id, seed) < p;
}

/** inclusive integer range, like Blender's Random Value (Int) */
export function randInt(min: number, max: number, id: number, seed: number): number {
  const v = min + Math.floor(hash01(id, seed) * (max - min + 1));
  return Math.min(v, max);
}

export function randFloat(min: number, max: number, id: number, seed: number): number {
  return min + hash01(id, seed) * (max - min);
}

/** componentwise vector lerp used for rotations/scales (x component decorrelated per axis) */
export function randVecComponent(min: number, max: number, id: number, seed: number, axis: number): number {
  return min + hash01x(id, seed, 100 + axis) * (max - min);
}
