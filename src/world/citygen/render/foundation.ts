// Terrain conforming for the merged chunk-LOD path. The baked `base` is the
// LOWEST ground under a footprint (buildings dig into hills), so a far chunk
// building drawn flat from `base` half-buries its uphill windows AND floats over
// the downhill slope. Sampling live terrain under the footprint gives us the two
// lines we need to fix both:
//   • grade = HIGHEST ground → windows/roof start here (no buried bottom row)
//   • foot  = LOWEST  ground → a plain foundation skirt drops to here (no float)
// This mirrors stream/ring.ts `footprintGrade` (kept intentionally in sync); it is
// reimplemented locally so the chunk builder owns its own copy and never reaches
// across module ownership. Cheap: 2 samples per footprint edge, no allocation.
import type { Vec2 } from "../core/types";

/** Live terrain height sampler in the host world frame (metres). */
export type GroundSampler = (x: number, z: number) => number;

/** Vertical conform lines for one footprint (world Y, metres). */
export interface FootprintGrade {
  /** highest ground under the footprint, clamped into (base, top-1.5); the
   *  windowed wall + roof are emitted from here up so no bottom row buries. */
  grade: number;
  /** lowest ground under the footprint (<= grade); the plain foundation skirt is
   *  emitted from here up to `grade` so the far side never floats. */
  foot: number;
}

/** Sample terrain at the footprint corners + edge midpoints and return the
 *  conform lines. Matches stream/ring.ts's max-ground `grade`, and additionally
 *  reports the min-ground `foot` for the foundation skirt. Falls back to a flat
 *  `base` lot if a sample is non-finite (bad/oob terrain). */
export function footprintGrade(
  poly: readonly Vec2[],
  base: number,
  top: number,
  ground: GroundSampler,
): FootprintGrade {
  const ceil = top - 1.5; // keep the grade under the roof so windows always fit
  let gmax = -Infinity;
  let gmin = Infinity;
  for (let k = 0; k < poly.length; k++) {
    const [x0, z0] = poly[k];
    const [x1, z1] = poly[(k + 1) % poly.length];
    const h0 = ground(x0, z0);
    const hm = ground((x0 + x1) / 2, (z0 + z1) / 2);
    if (h0 > gmax) gmax = h0;
    if (h0 < gmin) gmin = h0;
    if (hm > gmax) gmax = hm;
    if (hm < gmin) gmin = hm;
  }
  if (!Number.isFinite(gmax) || !Number.isFinite(gmin)) {
    // no usable terrain → behave like a flat lot at the baked base
    return { grade: Math.min(Math.max(base, base), ceil), foot: base };
  }
  const grade = Math.min(Math.max(gmax, base), ceil);
  // foundation drops to the lowest sampled ground, but never above the grade
  const foot = Math.min(gmin, grade);
  return { grade, foot };
}
