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
  /** Architectural enclosure width; the streaming gate also covers the beach stair. */
  hallHalfWidth: 38.7,
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
    Math.abs(local.x) <= SUTRO_BATHS.hallHalfWidth + pad &&
    Math.abs(local.z) <= SUTRO_BATHS.halfLength + pad
  );
}

type SutroStairSurface = {
  minAcross: number;
  maxAcross: number;
  startAlong: number;
  endAlong: number;
  startY: number;
  endY: number;
  steps: number;
};

/** v5 gallery cascade: flights run along local X on constant-z lanes, so
 * `across` is local z and `along` is local x (the beach-stair axis swap). */
const MAIN_ENTRY_FLIGHTS: readonly SutroStairSurface[] = [
  { minAcross: 60.6, maxAcross: 65.6, startAlong: 36.6, endAlong: 20.2, startY: 31.02, endY: 24.83, steps: 24 },
  { minAcross: 54.6, maxAcross: 59.6, startAlong: 20.2, endAlong: 35.8, startY: 24.67, endY: 18.48, steps: 24 },
  { minAcross: 48.6, maxAcross: 53.6, startAlong: 35.8, endAlong: 20.2, startY: 18.32, endY: 12.13, steps: 24 },
  { minAcross: 42.6, maxAcross: 47.6, startAlong: 20.2, endAlong: 35.8, startY: 11.97, endY: 5.78, steps: 24 }
] as const;

const BEACH_ENTRY_STAIR: SutroStairSurface = {
  minAcross: 29.19,
  maxAcross: 37.39,
  startAlong: -62,
  endAlong: -39,
  startY: 1.75,
  endY: 5.83,
  steps: 29
};

const ROAD_APPROACH_STAIR: SutroStairSurface = {
  minAcross: 58.4,
  maxAcross: 67.8,
  startAlong: 55.05,
  endAlong: 59.05,
  startY: 31.44,
  endY: 32.48,
  steps: 5
};

// A capsule can move farther than a tread edge in one busy frame. Keep the
// recovery contract slightly wider than the visible slabs so it catches that
// edge crossing before the player falls to a lower hall surface.
const ENTRY_RECOVERY_PAD = 0.45;

function insideRect(x: number, z: number, minX: number, maxX: number, minZ: number, maxZ: number): boolean {
  return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
}

function stairSurfaceY(across: number, along: number, stair: SutroStairSurface): number | null {
  const treadHalfRun = Math.abs(stair.endAlong - stair.startAlong) / (stair.steps - 1) * 0.5 + 0.03;
  if (
    across < stair.minAcross - ENTRY_RECOVERY_PAD ||
    across > stair.maxAcross + ENTRY_RECOVERY_PAD ||
    along < Math.min(stair.startAlong, stair.endAlong) - treadHalfRun ||
    along > Math.max(stair.startAlong, stair.endAlong) + treadHalfRun
  ) return null;
  const progress = (along - stair.startAlong) / (stair.endAlong - stair.startAlong);
  const step = Math.round(Math.max(0, Math.min(1, progress)) * (stair.steps - 1));
  return stair.startY + (stair.endY - stair.startY) * step / (stair.steps - 1);
}

/** Walk surface for the rebuilt road switchback and lower beach entrance. */
export function sutroEntryWalkSurfaceY(x: number, z: number): number | null {
  const local = sutroWorldToLocal(x, z);

  // The road terrain is explicitly handed to a coherent pavilion floor.
  if (insideRect(local.x, local.z, 38.25, 55.05, 56.45, 69.75)) return 31.18;
  // Interior threshold slab carries the doorway onto the gallery's top flight.
  if (insideRect(local.x, local.z, 36.5, 39.65, 60.5, 65.7)) return 31.18;
  const roadY = stairSurfaceY(local.z, local.x, ROAD_APPROACH_STAIR);
  if (roadY !== null) return roadY;

  // Gallery flights run along local x, so swap the axes for the shared helper.
  for (const flight of MAIN_ENTRY_FLIGHTS) {
    const y = stairSurfaceY(local.z, local.x, flight);
    if (y !== null) return y;
  }
  if (insideRect(local.x, local.z, 16.6, 20.2, 54.6, 65.6)) return 24.83;
  if (insideRect(local.x, local.z, 35.8, 37.8, 48.6, 59.6)) return 18.48;
  if (insideRect(local.x, local.z, 16.6, 20.2, 44.4, 53.6)) return 12.13;
  if (insideRect(local.x, local.z, 35.8, 38.2, 42.6, 47.6)) return 5.78;

  // The beach stair runs along local x, so swap the axes for the shared helper.
  const beachY = stairSurfaceY(local.z, local.x, BEACH_ENTRY_STAIR);
  if (beachY !== null) return beachY;
  if (insideRect(local.x, local.z, -64.5, -62, 28.79, 37.79)) return 1.75;
  if (insideRect(local.x, local.z, -38.6, -33.9, 28.79, 37.79)) return 5.66;
  return null;
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
  const entrySurface = sutroEntryWalkSurfaceY(x, z);
  if (entrySurface !== null) return entrySurface;
  if (!inSutroBathsHall(x, z)) return null;
  const local = sutroWorldToLocal(x, z);
  return poolAtLocal(local.x, local.z) ? SUTRO_BATHS.basinY : SUTRO_BATHS.deckY;
}

/** True when a WORLD-space point sits inside any of the seven pool rectangles. */
export function isInsideSutroPool(x: number, z: number): boolean {
  const local = sutroWorldToLocal(x, z);
  return poolAtLocal(local.x, local.z) !== null;
}

/** Authored water plane at a pool point, or NaN outside every pool. */
export function poolWaterY(x: number, z: number): number {
  return isInsideSutroPool(x, z) ? SUTRO_BATHS.waterY : Number.NaN;
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
