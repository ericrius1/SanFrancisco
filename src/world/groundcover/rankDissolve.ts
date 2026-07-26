// The ONE ground-cover distance dissolve — the reason a streamed meadow grows in
// instead of popping in.
//
// A layer owns an annulus [minRadius, visibleRadius] around the player. Every
// instance carries a stable rank in (0,1). Rather than switching the whole
// annulus at a radius (a ring sweeping through the field) or dithering coverage
// per pixel (visible noise on a bright petal), each instance gets its OWN
// threshold inside the band: rank r leaves the outer edge at
// `visibleRadius - r * fadeBand` and enters the inner edge at
// `minRadius + (1 - r) * innerBand`. Decorrelated ranks turn a hard boundary
// into a stochastic crossfade, and because the survivor set is a partition of
// rank space, two co-located layers hand off without ever double-drawing.
//
// Two functions, one shared truth:
//  · `rankAnnulusAccept` is the HARD test — the GPU cull pass drops the instance.
//  · `rankAnnulusGrowth` is the SOFT approach to that same test — the material
//    collapses the instance toward its ground anchor across the last
//    `RANK_DISSOLVE_SOFT` of the window, so it is already zero-sized when the
//    cull drops it (and grows back out of the ground on the way in).
// Both read identical inputs, so a material can never desynchronize from the
// cull that feeds it.

import { float } from "three/tsl";

// TSL's .d.ts narrows chained node types too aggressively for shared uniforms.
type N = any;

/** Softening window, in the same units as the rank threshold. */
export const RANK_DISSOLVE_SOFT = 0.25;

export type RankAnnulus = Readonly<{
  /** Outer radius (metres). A node when the owner exposes it as a live tunable. */
  visibleRadius: number | N;
  /** Width of the outer dissolve band (metres). */
  fadeBand: number;
  /** Inner hole radius. 0/undefined for a layer that owns the player's feet. */
  minRadius?: number;
  /** Width of the inner grow-in band. Defaults to `fadeBand`. */
  innerBand?: number;
}>;

const asNode = (value: number | N): N =>
  typeof value === "number" ? float(value) : value;

/** Outer band coordinate: >= 1 well inside, 0 at the outer radius, negative beyond. */
const outerRamp = (dist: N, annulus: RankAnnulus): N =>
  asNode(annulus.visibleRadius).sub(dist).div(float(Math.max(1, annulus.fadeBand)));

/** Inner band coordinate: 0 at `minRadius`, 1 once fully outside the inner hole. */
const innerRamp = (dist: N, annulus: RankAnnulus): N =>
  dist
    .sub(float(Math.max(0, annulus.minRadius ?? 0)))
    .div(float(Math.max(1, annulus.innerBand ?? annulus.fadeBand)));

/** True while this instance still belongs to the layer. Use in a cull pass. */
export function rankAnnulusAccept(dist: N, rank: N, annulus: RankAnnulus): N {
  const outer = (outerRamp(dist, annulus).clamp(0, 1) as N).greaterThanEqual(rank);
  const minRadius = Math.max(0, annulus.minRadius ?? 0);
  if (minRadius <= 0) return outer;
  return outer.and(
    (innerRamp(dist, annulus).clamp(0, 1) as N).greaterThanEqual(float(1).sub(rank))
  );
}

/** 1 at full size, easing to 0 exactly where `rankAnnulusAccept` turns false. */
export function rankAnnulusGrowth(dist: N, rank: N, annulus: RankAnnulus): N {
  const outer = outerRamp(dist, annulus).sub(rank).div(RANK_DISSOLVE_SOFT).clamp(0, 1) as N;
  const minRadius = Math.max(0, annulus.minRadius ?? 0);
  if (minRadius <= 0) return outer;
  return outer.min(
    innerRamp(dist, annulus).sub(float(1).sub(rank)).div(RANK_DISSOLVE_SOFT).clamp(0, 1) as N
  );
}

/**
 * Inner radius that lets this layer reach full size exactly where the layer it
 * hands off from starts to shrink — two soft windows inside that layer's own
 * dissolve. Keeping the ladder on this rule is what makes a handoff read as one
 * continuous field instead of a crossfade with a thin gap or a doubled band.
 */
export function rankHandoffRadius(innerVisibleRadius: number, innerFadeBand: number): number {
  return Math.max(0, innerVisibleRadius - innerFadeBand * (1 + 2 * RANK_DISSOLVE_SOFT));
}

/**
 * CPU mirror of the four distances the node graphs above resolve to, for
 * deterministic contracts and visual probes: where an instance of this rank
 * begins and finishes growing in, and where it begins and finishes shrinking
 * out. `dropEnd` is exactly where the cull stops accepting it.
 */
export function rankAnnulusWindow(
  rank: number,
  annulus: Readonly<{ visibleRadius: number; fadeBand: number; minRadius?: number; innerBand?: number }>
): { growStart: number; growEnd: number; dropStart: number; dropEnd: number } {
  const fadeBand = Math.max(1, annulus.fadeBand);
  const minRadius = Math.max(0, annulus.minRadius ?? 0);
  const innerBand = Math.max(1, annulus.innerBand ?? annulus.fadeBand);
  const dropEnd = annulus.visibleRadius - rank * fadeBand;
  return {
    growStart: minRadius > 0 ? minRadius + (1 - rank) * innerBand : 0,
    growEnd: minRadius > 0 ? minRadius + (1 - rank + RANK_DISSOLVE_SOFT) * innerBand : 0,
    dropStart: dropEnd - RANK_DISSOLVE_SOFT * fadeBand,
    dropEnd
  };
}
