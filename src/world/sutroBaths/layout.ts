import {
  SUTRO_BATHS_ARRIVAL,
  SUTRO_BATHS_GATE,
  distanceToSutroBaths
} from "../spawnPoints";

/**
 * Restored Sutro Baths, fitted to the surveyed pool basin below Point Lobos.
 *
 * The NPS records the enclosure at 499.5 by 254.1 feet. The authored hall keeps
 * that grand 2:1 proportion and follows the surviving basin's 4.4 degree skew.
 * Local +x points inland/east and local +z runs south toward the historic entry.
 */

export type SutroPoolSpec = {
  id: string;
  label: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 0 cold ocean pool .. 1 hottest thermal pool. */
  heat: number;
};

export const SUTRO_BATHS = {
  ...SUTRO_BATHS_GATE,
  /** Local +z (south) rotated so the north end sits slightly farther east. */
  deckY: 5.62,
  waterY: 5.18,
  basinY: 2.62,
  roofSpringY: 25.5,
  roofApexY: 43.5
} as const;

/** Seven pools: the 275-foot salt-water plunge, five 28-by-75-foot graduated
 * salt baths, and the smaller fresh-water pool described in period accounts.
 * The great plunge's historical L is simplified to its long primary rectangle. */
export const SUTRO_POOLS: readonly SutroPoolSpec[] = [
  {
    id: "great-plunge",
    label: "Great salt-water plunge",
    minX: -31,
    maxX: -10,
    minZ: -55,
    maxZ: 29,
    heat: 0
  },
  {
    id: "bath-one",
    label: "Temperate bath I",
    minX: -4,
    maxX: 19,
    minZ: -55,
    maxZ: -46,
    heat: 0.2
  },
  {
    id: "bath-two",
    label: "Temperate bath II",
    minX: -4,
    maxX: 19,
    minZ: -37,
    maxZ: -28,
    heat: 0.38
  },
  {
    id: "bath-three",
    label: "Warm bath III",
    minX: -4,
    maxX: 19,
    minZ: -19,
    maxZ: -10,
    heat: 0.58
  },
  {
    id: "bath-four",
    label: "Hot bath IV",
    minX: -4,
    maxX: 19,
    minZ: -1,
    maxZ: 8,
    heat: 0.78
  },
  {
    id: "bath-five",
    label: "Hot bath V",
    minX: -4,
    maxX: 19,
    minZ: 17,
    maxZ: 26,
    heat: 1
  },
  {
    id: "fresh-plunge",
    label: "Fresh-water plunge",
    minX: -4,
    maxX: 19,
    minZ: 35,
    maxZ: 44,
    heat: 0.12
  }
] as const;

export function sutroLocalToWorld(x: number, z: number): { x: number; z: number } {
  const c = Math.cos(SUTRO_BATHS.yaw);
  const s = Math.sin(SUTRO_BATHS.yaw);
  return {
    x: SUTRO_BATHS.centerX + c * x + s * z,
    z: SUTRO_BATHS.centerZ - s * x + c * z
  };
}

export function sutroWorldToLocal(x: number, z: number): { x: number; z: number } {
  const dx = x - SUTRO_BATHS.centerX;
  const dz = z - SUTRO_BATHS.centerZ;
  const c = Math.cos(SUTRO_BATHS.yaw);
  const s = Math.sin(SUTRO_BATHS.yaw);
  return { x: c * dx - s * dz, z: s * dx + c * dz };
}

export function inSutroBathsHall(x: number, z: number, pad = 0): boolean {
  const local = sutroWorldToLocal(x, z);
  return (
    Math.abs(local.x) <= SUTRO_BATHS.halfWidth + pad &&
    Math.abs(local.z) <= SUTRO_BATHS.halfLength + pad
  );
}

export { SUTRO_BATHS_ARRIVAL, distanceToSutroBaths };

export function poolAtLocal(x: number, z: number, inset = 0): SutroPoolSpec | null {
  for (const pool of SUTRO_POOLS) {
    if (
      x >= pool.minX + inset &&
      x <= pool.maxX - inset &&
      z >= pool.minZ + inset &&
      z <= pool.maxZ - inset
    ) return pool;
  }
  return null;
}

/**
 * Returns the lowest authored walk surface beneath a visitor inside the hall.
 *
 * The streamed Box3D colliders remain the primary collision source. This is a
 * recovery contract for the frame in which those bodies replace the old
 * terrain, or for an unusually fast capsule that crosses a thin floor slab.
 * Pool footprints deliberately resolve to the basin instead of the deck so a
 * visitor can still step into and wade through every bath.
 */
export function sutroWalkSurfaceY(x: number, z: number): number | null {
  if (!inSutroBathsHall(x, z)) return null;
  const local = sutroWorldToLocal(x, z);
  return poolAtLocal(local.x, local.z) ? SUTRO_BATHS.basinY : SUTRO_BATHS.deckY;
}

export function distanceToSutroWater(x: number, z: number): number {
  const local = sutroWorldToLocal(x, z);
  let best = Number.POSITIVE_INFINITY;
  for (const pool of SUTRO_POOLS) {
    const dx = Math.max(pool.minX - local.x, 0, local.x - pool.maxX);
    const dz = Math.max(pool.minZ - local.z, 0, local.z - pool.maxZ);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}
