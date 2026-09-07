/** Small, renderer-independent policy helpers for authored native-tree source tiles. */

export type NativeTreeTileBounds = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}>;

export type NativeTreeSourceTile = Readonly<{
  key: string;
  bounds: NativeTreeTileBounds;
  distance: number;
}>;

type Point = Readonly<{ x: number; z: number }>;

function validateQuery(x: number, z: number, tileSize: number, radius: number): void {
  if (![x, z, tileSize, radius].every(Number.isFinite) || tileSize <= 0 || radius < 0) {
    throw new RangeError('Native tree source tile query requires finite coordinates, positive tileSize, and non-negative radius');
  }
}

function pointToBoundsDistance(point: Point, bounds: NativeTreeTileBounds): number {
  const dx = point.x < bounds.minX ? bounds.minX - point.x : point.x > bounds.maxX ? point.x - bounds.maxX : 0;
  const dz = point.z < bounds.minZ ? bounds.minZ - point.z : point.z > bounds.maxZ ? point.z - bounds.maxZ : 0;
  return Math.hypot(dx, dz);
}

/**
 * Collects grid cells touched by either the current or predicted-radius
 * circle. Bounds are half-open for consumers, while intersection uses the
 * closed edge of a cell so tangent cells are retained conservatively.
 */
export function collectNativeTreeSourceTiles(
  x: number,
  z: number,
  tileSize: number,
  radius: number,
  ahead?: Point,
): NativeTreeSourceTile[] {
  validateQuery(x, z, tileSize, radius);
  if (ahead && (![ahead.x, ahead.z].every(Number.isFinite))) {
    throw new RangeError('Native tree source tile ahead coordinate must be finite');
  }
  const actual = { x, z };
  const centers = ahead ? [actual, ahead] : [actual];
  const minX = Math.min(...centers.map((p) => p.x - radius));
  const maxX = Math.max(...centers.map((p) => p.x + radius));
  const minZ = Math.min(...centers.map((p) => p.z - radius));
  const maxZ = Math.max(...centers.map((p) => p.z + radius));
  // One-cell padding makes a circle tangent to a tile's max edge discover it.
  const firstX = Math.floor(minX / tileSize) - 1;
  const lastX = Math.floor(maxX / tileSize) + 1;
  const firstZ = Math.floor(minZ / tileSize) - 1;
  const lastZ = Math.floor(maxZ / tileSize) + 1;
  const result: Array<NativeTreeSourceTile & { aheadDistance: number }> = [];
  for (let tileZ = firstZ; tileZ <= lastZ; tileZ += 1) {
    for (let tileX = firstX; tileX <= lastX; tileX += 1) {
      const bounds = {
        minX: tileX * tileSize,
        maxX: (tileX + 1) * tileSize,
        minZ: tileZ * tileSize,
        maxZ: (tileZ + 1) * tileSize,
      };
      const actualDistance = pointToBoundsDistance(actual, bounds);
      const aheadDistance = ahead ? pointToBoundsDistance(ahead, bounds) : actualDistance;
      if (actualDistance > radius && aheadDistance > radius) continue;
      result.push({ key: `${tileX},${tileZ}`, bounds, distance: actualDistance, aheadDistance });
    }
  }
  result.sort((a, b) => a.distance - b.distance || a.aheadDistance - b.aheadDistance || a.key.localeCompare(b.key));
  return result.map(({ aheadDistance: _aheadDistance, ...tile }) => tile);
}

/** Predicts a short, bounded forward focus for source-tile admission. */
export class NativeTreeStreamMotion {
  private previous: { x: number; z: number; nowMs: number } | undefined;

  update(x: number, z: number, nowMs: number): Point {
    if (![x, z, nowMs].every(Number.isFinite)) throw new RangeError('Native tree stream motion requires finite values');
    const prior = this.previous;
    this.previous = { x, z, nowMs };
    if (!prior) return { x, z };
    const deltaMs = nowMs - prior.nowMs;
    if (deltaMs <= 0 || deltaMs > 2000) return { x, z };
    const dx = x - prior.x;
    const dz = z - prior.z;
    const seconds = deltaMs / 1000;
    const speed = Math.hypot(dx, dz) / seconds;
    if (speed <= 0 || speed > 250) return { x, z };
    const travel = Math.min(speed * 2, 450);
    return { x: x + (dx / Math.hypot(dx, dz)) * travel, z: z + (dz / Math.hypot(dx, dz)) * travel };
  }

  reset(): void {
    this.previous = undefined;
  }
}
