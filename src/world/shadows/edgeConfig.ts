export const CLIPMAP_SHADOW_EDGES = Object.freeze({
  hero: { fadeMeters: 5, sampleMarginMeters: 0.125 },
  local: { handoffStartMeters: 41.5, handoffEndMeters: 47.75 },
  far: { fadeMeters: 96, sampleMarginMeters: 4 }
});

const smooth01 = (value: number): number => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

/** CPU contract twin of the TSL projection-edge retirement curve. */
export function shadowMapEdgeWeight(
  radius: number,
  halfExtent: number,
  fadeMeters: number,
  sampleMarginMeters: number
): number {
  const fadeEnd = halfExtent - sampleMarginMeters;
  const fadeStart = fadeEnd - fadeMeters;
  return 1 - smooth01((radius - fadeStart) / Math.max(1e-6, fadeEnd - fadeStart));
}
