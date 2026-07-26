// Terrain conforming for BOTH building tiers. The baked `base` is the LOWEST
// ground under a footprint (buildings dig into hills), so a building drawn flat
// from `base` half-buries its uphill windows AND floats over the downhill slope.
// Sampling live terrain gives us the two lines that fix both:
//   • grade = HIGHEST ground under the footprint → windows/roof start here
//   • foot  = LOWEST  ground the walls must reach → a plain foundation skirt
//             drops to here (chunk LOD: render/lod.ts appendPrism; detail mesh:
//             core/massing.ts) so the downhill wall never floats
//
// `foot` is sampled on a ring DILATED outward from the footprint. That is the
// cliff-lip fix: a lot perched on the Point Lobos bluff has every one of its own
// corners on high ground, so a footprint-only min returns a high `foot` and the
// skirt can't reach the drop-off a few metres west. Long edges are also
// subdivided — a footprint-corner-only min misses a dip that opens mid-wall.
//
// Sampling reads `groundTop` (the RENDERED, walkable surface: terrain + draped
// roads/lawns + authored-region overlays), not the raw heightfield. Authored
// flat-ownership regions LOWER ground under their footprints; a raw-heightfield
// sampler cannot see that and leaves the same floating gap.
//
// ONE implementation, shared by the chunk-LOD builder and the streaming ring —
// the previous two hand-synced copies are exactly why the near tier never grew
// the skirt the far tier had.
import { ensureCCW } from "../core/footprint";
import type { Vec2 } from "../core/types";

/** Live terrain height sampler in the host world frame (metres). Pass a
 *  `groundTop`-backed sampler; see the module header. */
export type GroundSampler = (x: number, z: number) => number;

/** Vertical conform lines for one footprint (world Y, metres). */
export interface FootprintGrade {
  /** highest ground under the footprint, clamped into (base, top-1.5); the
   *  windowed wall + roof are emitted from here up so no bottom row buries. */
  grade: number;
  /** lowest ground on the dilated ring (<= grade); the plain foundation skirt is
   *  emitted from here up so the downhill side never floats. */
  foot: number;
}

/** How far OUTSIDE each footprint edge the foundation looks for a drop-off. Two
 *  rings: the near one catches an ordinary kerb/slope, the far one reaches past
 *  a bluff lip. Measured citywide (92k footprints) against a densely sampled
 *  ground line: these close every >0.3 m floating gap, worst residual 0.12 m. */
const SKIRT_OFFSETS = [0, 3, 8] as const;
/** Max spacing (metres) between ring samples along an edge. A long wall's
 *  corners can both sit high while the ground dips in the middle. */
const SKIRT_STEP = 6;

/** Sample terrain for one footprint and return the conform lines.
 *
 *  `grade` keeps the historical footprint-only max (corners + edge midpoints) —
 *  widening it would raise the window line on lots whose NEIGHBOUR is uphill.
 *  `foot` takes the min over the dilated, subdivided ring described above.
 *
 *  Falls back to a flat `base` lot if the samples are non-finite (bad/oob
 *  terrain). */
export function footprintGrade(
  poly: readonly Vec2[],
  base: number,
  top: number,
  ground: GroundSampler,
): FootprintGrade {
  const ceil = top - 1.5; // keep the grade under the roof so windows always fit
  // the outward normal below is only outward for a CCW ring, and the exported
  // footprints are not wound consistently
  const ring = ensureCCW(poly as Vec2[]);
  let gmax = -Infinity;
  let fmin = Infinity;
  for (let k = 0; k < ring.length; k++) {
    const [x0, z0] = ring[k];
    const [x1, z1] = ring[(k + 1) % ring.length];
    const ex = x1 - x0;
    const ez = z1 - z0;
    // grade: this footprint's own corner + midpoint, unchanged
    const h0 = ground(x0, z0);
    const hm = ground(x0 + ex / 2, z0 + ez / 2);
    if (h0 > gmax) gmax = h0;
    if (hm > gmax) gmax = hm;
    // foot: walk the edge and step outward along its normal at each stop
    const len = Math.hypot(ex, ez) || 1e-3;
    const nx = ez / len, nz = -ex / len; // outward normal (footprints are CCW)
    const steps = Math.max(2, Math.ceil(len / SKIRT_STEP));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const px = x0 + ex * t, pz = z0 + ez * t;
      for (const d of SKIRT_OFFSETS) {
        const h = ground(px + nx * d, pz + nz * d);
        if (h < fmin) fmin = h;
      }
    }
  }
  if (!Number.isFinite(gmax) || !Number.isFinite(fmin)) {
    // no usable terrain → behave like a flat lot at the baked base
    return { grade: Math.min(base, ceil), foot: base };
  }
  const grade = Math.min(Math.max(gmax, base), ceil);
  // foundation drops to the lowest ring sample, but never above the grade
  const foot = Math.min(fmin, grade);
  return { grade, foot };
}
