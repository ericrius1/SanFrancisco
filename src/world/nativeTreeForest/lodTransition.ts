export const NATIVE_TREE_LOD_TRANSITION_WIDTH = 24;
export const NATIVE_TREE_LOD_CHUNK_BIAS_SPREAD = 12;
export const NATIVE_TREE_LOD_UPDATE_MOVE = 2;

export type NativeTreeSilhouetteLod = 2 | 3;
export type NativeTreeLodTransitionDirection = -1 | 0 | 1;

export type NativeTreeLodTransition = {
  /** The last fully settled silhouette grade. */
  settledLod: NativeTreeSilhouetteLod;
  /** -1 approaches landscape, +1 approaches horizon, 0 is fully settled. */
  direction: NativeTreeLodTransitionDirection;
  /** Fraction of the chunk population assigned to the horizon silhouette. */
  horizonFraction: number;
  transitioning: boolean;
};

function mixUint(value: number): number {
  let x = value | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Stable chunk-local offset that breaks the otherwise circular whole-grid LOD
 * frontier. It is intentionally pure so residency churn cannot change a
 * chunk's transition distance.
 */
export function nativeTreeChunkLodBias(
  chunkX: number,
  chunkZ: number,
  spread = NATIVE_TREE_LOD_CHUNK_BIAS_SPREAD
): number {
  const xHash = mixUint(Math.imul(chunkX | 0, 0x1f123bb5) ^ 0x2c1b3c6d);
  const hash = mixUint(xHash ^ Math.imul(chunkZ | 0, 0x5f356495));
  return ((hash + 0.5) / 0x1_0000_0000 * 2 - 1) * Math.max(0, spread);
}

export function nativeTreeUsesHorizonLod(rank: number, horizonFraction: number): boolean {
  return rank < Math.min(1, Math.max(0, horizonFraction));
}

/**
 * Directional bands retain the existing +/- hysteresis endpoints. A settled
 * landscape chunk finishes its outward transition at center+hysteresis; a
 * settled horizon chunk finishes its inward transition at center-hysteresis.
 * Reversing inside either band simply walks the same deterministic population
 * back, so camera dithering cannot randomize or double-render trees.
 */
export function resolveNativeTreeLodTransition(
  distance: number,
  center: number,
  settledLod: NativeTreeSilhouetteLod,
  width = NATIVE_TREE_LOD_TRANSITION_WIDTH,
  hysteresis = 14
): NativeTreeLodTransition {
  const safeWidth = Math.max(0.001, width);
  const safeHysteresis = Math.max(0, hysteresis);

  if (settledLod === 2) {
    const finish = center + safeHysteresis;
    const start = finish - safeWidth;
    if (distance >= finish) {
      return {
        settledLod: 3,
        direction: 0,
        horizonFraction: 1,
        transitioning: false
      };
    }
    const horizonFraction = Math.min(1, Math.max(0, (distance - start) / safeWidth));
    return {
      settledLod: 2,
      direction: horizonFraction > 0 ? 1 : 0,
      horizonFraction,
      transitioning: horizonFraction > 0
    };
  }

  const finish = center - safeHysteresis;
  if (distance <= finish) {
    return {
      settledLod: 2,
      direction: 0,
      horizonFraction: 0,
      transitioning: false
    };
  }
  const horizonFraction = Math.min(1, Math.max(0, (distance - finish) / safeWidth));
  return {
    settledLod: 3,
    direction: horizonFraction < 1 ? -1 : 0,
    horizonFraction,
    transitioning: horizonFraction < 1
  };
}
