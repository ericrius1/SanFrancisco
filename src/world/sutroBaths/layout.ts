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

/**
 * Transparent draw order for the pools and their steam. Keep these two together.
 *
 * The renderer runs a REVERSED depth buffer (app/renderCore.ts), and three's
 * RenderList reverses the whole sorted transparent list when it does — which
 * flips the renderOrder key along with the depth key. So inside this renderer a
 * HIGHER renderOrder is drawn EARLIER, the opposite of the usual reading.
 *
 * The pool sheet is an alpha-1 surface (its transparency is carried by an
 * emissive refraction term, not by coverage), so it has to be laid down BEFORE
 * the steam that rises off it. With the sheet at 7 and the steam at 12 the
 * sheet landed last and repainted every plume back out of the frame: the halls
 * kept their distant steam banks, and every pool you actually stood at was
 * mirror-clean.
 */
export const SUTRO_WATER_RENDER_ORDER = 13;
export const SUTRO_STEAM_RENDER_ORDER = 12;

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

/**
 * The grand spiral descent (revision 9, `tools/rebuild-sutro-grand-spiral.py`).
 *
 * One continuous helical flight from the glazed road doors down to the bath
 * deck, replacing the v5 four-flight switchback cascade whose lowest flight
 * finished against a blank wall. These numbers MIRROR the Blender authority —
 * that script prints a `SPIRAL_CONTRACT` line on every run; if you retune the
 * helix there, copy the printed values here in the same commit.
 */
const SPIRAL = {
  cx: 24.6,
  cz: 58.2,
  radius: 11.6,
  inner: 9.0,
  outer: 14.2,
  startDeg: 20.66,
  sweepDeg: 249.34,
  topY: 31.18,
  botY: 5.78,
  steps: 128,
  headSpanDeg: 15,
  footSpanDeg: 20
} as const;

/** The foot fan widens past the last tread by this much on each radial side. */
const SPIRAL_FOOT_RADIAL_PAD = 0.8;

/**
 * Walk surface for the helix, or null when the point is off it.
 *
 * Resolves to the same discrete tread the authored slabs occupy, so the
 * recovery contract and the streamed colliders agree on which step a capsule is
 * standing on rather than disagreeing by half a riser.
 */
function sutroSpiralWalkSurfaceY(localX: number, localZ: number): number | null {
  const dx = localX - SPIRAL.cx;
  const dz = localZ - SPIRAL.cz;
  const radius = Math.hypot(dx, dz);
  // Head, flight and fan all share one angular sweep, so resolve the angle once
  // and let the radial test widen only for the fan.
  const degrees = (Math.atan2(dz, dx) * 180) / Math.PI;
  let along = degrees - SPIRAL.startDeg;
  while (along < -180) along += 360;
  while (along > 180) along += -360;
  // `along` is now -180..180 relative to the head. The descent occupies
  // 0..sweep, the head landing -headSpan..0, the fan sweep..sweep+footSpan —
  // and sweep + footSpan is 269.34, so re-wrap the far side into that range.
  if (along < -SPIRAL.headSpanDeg) along += 360;

  const onFlightRadius = radius >= SPIRAL.inner - ENTRY_RECOVERY_PAD &&
    radius <= SPIRAL.outer + ENTRY_RECOVERY_PAD;

  if (along >= -SPIRAL.headSpanDeg && along < 0) {
    return onFlightRadius ? SPIRAL.topY : null;
  }
  if (along >= 0 && along <= SPIRAL.sweepDeg) {
    if (!onFlightRadius) return null;
    const progress = along / SPIRAL.sweepDeg;
    const step = Math.round(progress * (SPIRAL.steps - 1));
    return SPIRAL.topY + (SPIRAL.botY - SPIRAL.topY) * step / (SPIRAL.steps - 1);
  }
  if (along > SPIRAL.sweepDeg && along <= SPIRAL.sweepDeg + SPIRAL.footSpanDeg) {
    const onFanRadius = radius >= SPIRAL.inner - SPIRAL_FOOT_RADIAL_PAD - ENTRY_RECOVERY_PAD &&
      radius <= SPIRAL.outer + SPIRAL_FOOT_RADIAL_PAD + ENTRY_RECOVERY_PAD;
    return onFanRadius ? SPIRAL.botY : null;
  }
  return null;
}

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

  // The single helical descent. Checked before the flat aprons below so a
  // capsule on a tread resolves to that tread, not to the deck beneath it.
  const spiralY = sutroSpiralWalkSurfaceY(local.x, local.z);
  if (spiralY !== null) return spiralY;
  // Foot apron butting the fan onto the deck (authored 2 cm under the fan).
  if (insideRect(local.x, local.z, 18.51, 25.52, 41.58, 49.98)) return 5.76;

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

/**
 * World-space AABB around every pool rectangle — the cheap reject in front of
 * `isInsideSutroPool` for callers that ask on every frame (swimVolumes.ts).
 * The site yaw is small but real, so the corners are rotated rather than
 * assumed axis-aligned.
 */
export function sutroPoolBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const pool of SUTRO_POOLS) {
    for (const [lx, lz] of [
      [pool.minX, pool.minZ],
      [pool.minX, pool.maxZ],
      [pool.maxX, pool.minZ],
      [pool.maxX, pool.maxZ]
    ]) {
      const world = sutroLocalToWorld(lx, lz);
      minX = Math.min(minX, world.x);
      maxX = Math.max(maxX, world.x);
      minZ = Math.min(minZ, world.z);
      maxZ = Math.max(maxZ, world.z);
    }
  }
  return { minX, maxX, minZ, maxZ };
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
