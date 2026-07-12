export type HeightSampler = (x: number, z: number) => number;

/**
 * Seat a ground-cover instance on the lowest point of its five-sample
 * footprint. This keeps every cluster root at or below the rendered surface;
 * discontinuities that are too large to fit safely are rejected instead of
 * producing a floating tuft.
 */
export function fitGroundY(
  sample: HeightSampler,
  x: number,
  z: number,
  footprintRadius: number,
  maxRise: number,
  offsetY = 0
): number | null {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(z) ||
    !Number.isFinite(footprintRadius) ||
    footprintRadius < 0 ||
    !Number.isFinite(maxRise) ||
    maxRise < 0 ||
    !Number.isFinite(offsetY)
  ) {
    return null;
  }

  const h0 = sample(x, z);
  const h1 = sample(x - footprintRadius, z);
  const h2 = sample(x + footprintRadius, z);
  const h3 = sample(x, z - footprintRadius);
  const h4 = sample(x, z + footprintRadius);
  if (
    !Number.isFinite(h0) ||
    !Number.isFinite(h1) ||
    !Number.isFinite(h2) ||
    !Number.isFinite(h3) ||
    !Number.isFinite(h4)
  ) {
    return null;
  }

  const hMin = Math.min(h0, h1, h2, h3, h4);
  if (Math.max(h0, h1, h2, h3, h4) - hMin > maxRise) return null;
  const fittedY = hMin + offsetY;
  return Number.isFinite(fittedY) ? fittedY : null;
}
