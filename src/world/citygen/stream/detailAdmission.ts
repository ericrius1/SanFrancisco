import { signedDistToPoly } from "../core/footprint.ts";

export interface FootprintBounds {
  minx: number;
  maxx: number;
  minz: number;
  maxz: number;
}

export interface DetailRankMetric {
  centerDistance2: number;
  surfaceDistance2: number;
  sticky: boolean;
}

/** Cheap lower bound for distance to a building footprint. */
export function aabbDistance2(bounds: FootprintBounds, x: number, z: number): number {
  const dx = x < bounds.minx ? bounds.minx - x : x > bounds.maxx ? x - bounds.maxx : 0;
  const dz = z < bounds.minz ? bounds.minz - z : z > bounds.maxz ? z - bounds.maxz : 0;
  return dx * dx + dz * dz;
}

/**
 * Exact planar distance to a building footprint, with an AABB broad-phase.
 * Passing `maxExactDistance2` avoids walking polygon edges for the thousands of
 * buildings that cannot possibly belong to the guaranteed near-detail core.
 */
export function footprintSurfaceDistance2(
  poly: readonly (readonly [number, number])[],
  bounds: FootprintBounds,
  x: number,
  z: number,
  maxExactDistance2 = Infinity,
): number {
  if (aabbDistance2(bounds, x, z) > maxExactDistance2) return Infinity;
  const signedDistance = signedDistToPoly(poly, x, z);
  const outsideDistance = signedDistance < 0 ? -signedDistance : 0;
  return outsideDistance * outsideDistance;
}

/**
 * Guaranteed-core candidates always rank before the legacy centroid/cost ring.
 * Existing detail keeps the same 13% dead-band within its own tier.
 */
export function compareDetailAdmission(
  a: DetailRankMetric,
  b: DetailRankMetric,
  coreRadius2: number,
  stickyFactor: number,
): number {
  const aCore = a.surfaceDistance2 <= coreRadius2;
  const bCore = b.surfaceDistance2 <= coreRadius2;
  if (aCore !== bCore) return aCore ? -1 : 1;
  const aDistance2 = aCore ? a.surfaceDistance2 : a.centerDistance2;
  const bDistance2 = bCore ? b.surfaceDistance2 : b.centerDistance2;
  const aRank = a.sticky ? aDistance2 * stickyFactor : aDistance2;
  const bRank = b.sticky ? bDistance2 * stickyFactor : bDistance2;
  return aRank - bRank || a.centerDistance2 - b.centerDistance2;
}

/**
 * The close core may spend through the old facade budget, but still contributes
 * its full cost to the remaining outer-ring allowance. This bounds steady-state
 * detail near the existing budget except where the local core itself exceeds it.
 */
export function shouldAdmitNewDetail(
  isCore: boolean,
  centerDistance2: number,
  admissionRadius2: number,
  cost: number,
  costLeft: number,
): boolean {
  return isCore || (centerDistance2 <= admissionRadius2 && cost <= costLeft);
}
