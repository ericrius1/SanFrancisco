import type { WorldMap } from "../heightmap";
import { CORONA_DOG_PARK, CORONA_HEIGHTS_SUMMIT, type CoronaXZ } from "./meta";

export const CORONA_HILL_RADIUS_X = 118;
export const CORONA_HILL_RADIUS_Z = 126;

/** Summit viewing platform — bare eroded dirt, no grass/flowers/legacy rocks. */
export const SUMMIT_PLATFORM = { x: 412, z: 2760, rx: 16, rz: 12 } as const;

const DOG_QUERY_LIFT = 0.14;
const CORONA_GROUND_LIFT = 0.38;
const preparedMaps = new WeakSet<WorldMap>();

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smooth01(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function pointInPolygon(x: number, z: number, polygon: readonly CoronaXZ[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Extra height the platform skin holds above WorldMap.groundTop at (x,z). */
export function summitPlatformLift(x: number, z: number): number {
  const q = ((x - SUMMIT_PLATFORM.x) / SUMMIT_PLATFORM.rx) ** 2 +
    ((z - SUMMIT_PLATFORM.z) / SUMMIT_PLATFORM.rz) ** 2;
  if (q >= 1) return 0;
  const edge = smooth01((q - 0.62) / 0.38);
  return 0.18 + 0.14 * (1 - edge);
}

/**
 * Keep Corona's authored surface and the map query carpet aligned. This tiny
 * data-only preparation stays in the core map path so a direct link can settle
 * safely before the optional park renderer/gameplay chunk is requested.
 */
export function prepareCoronaHeightsGround(map: WorldMap): void {
  if (preparedMaps.has(map)) return;
  preparedMaps.add(map);
  const { cellSize, width, height, minX, minZ } = map.meta.grid;
  const cx = CORONA_HEIGHTS_SUMMIT.x;
  const cz = CORONA_HEIGHTS_SUMMIT.z + 8;
  const minGX = Math.max(0, Math.floor((cx - CORONA_HILL_RADIUS_X * 1.12 - minX) / cellSize));
  const maxGX = Math.min(width - 1, Math.ceil((cx + CORONA_HILL_RADIUS_X * 1.12 - minX) / cellSize));
  const minGZ = Math.max(0, Math.floor((cz - CORONA_HILL_RADIUS_Z * 1.12 - minZ) / cellSize));
  const maxGZ = Math.min(height - 1, Math.ceil((cz + CORONA_HILL_RADIUS_Z * 1.12 - minZ) / cellSize));
  for (let gz = minGZ; gz <= maxGZ; gz++) {
    const z = minZ + gz * cellSize;
    for (let gx = minGX; gx <= maxGX; gx++) {
      const x = minX + gx * cellSize;
      const q = ((x - cx) / CORONA_HILL_RADIUS_X) ** 2 + ((z - cz) / CORONA_HILL_RADIUS_Z) ** 2;
      if (q >= 1.12) continue;
      const feather = 1 - smooth01((q - 0.9) / 0.22);
      map.groundTops[gz * width + gx] +=
        CORONA_GROUND_LIFT * feather +
        summitPlatformLift(x, z) +
        (pointInPolygon(x, z, CORONA_DOG_PARK) ? DOG_QUERY_LIFT : 0);
    }
  }
}
