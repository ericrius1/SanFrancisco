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

/**
 * The inland gallery wall — the long east side, and the one surface a visitor on
 * the deck is always looking at.
 *
 * MIRRORED from tools/rebuild-sutro-inland-gallery.py, which asserts every one
 * of these numbers against the Blender source on each bake and prints them as
 * SUTRO_WALL_CONTRACT. The authored wall is a plain plate with a colonnade of
 * pilasters standing proud of it; timberGallery.ts clads the bays between those
 * pilasters and hangs the pictures, so if the wall ever moves in Blender the
 * bake fails rather than the boards drifting off it.
 *
 * Bay k spans z = pitch * k .. pitch * (k + 1), so its centre is
 * pitch * (k + 0.5). Bays `firstBay`..`lastBay` are the run of full-height wall;
 * past that the road pavilion and the grand spiral own the corner.
 */
export const SUTRO_WALL = {
  /** Inner face of the wall plate (local x). */
  faceX: 38.09,
  /** Pilasters stand this far into the hall — the depth budget for cladding. */
  pilasterFaceX: 37.7,
  /** Pilaster spacing, centred on z 0. */
  pitch: 9.5125,
  /** Half width of one pilaster. */
  pilasterHalf: 0.175,
  /** The authored mid-height panel band, which the art band follows. */
  bandLowY: 8.42,
  bandHighY: 17.22,
  firstBay: -8,
  lastBay: 5
} as const;

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

/**
 * Signed metres to the nearest wall plane of the hall: positive inside the
 * enclosure, negative outside it.
 *
 * The single source of truth for "am I in the building", and deliberately a
 * DISTANCE rather than a boolean or a feathered 0..1. Everything that latches on
 * the interior — the out-of-time sky pocket, the indoor camera rig — wants to
 * say "not until I am a few metres clear of the wall", and only metres can
 * express that. A feathered blend cannot: its value collapses well inside the
 * room (and collapses twice as fast in a corner, where two feathers multiply),
 * which is exactly how the sky used to hand back and the camera used to swing
 * out to third person while the visitor was still walking the deck.
 *
 * `min` of the two axes, not a product: the distance to the nearest wall is the
 * nearest wall's distance, and a corner is no more "outside" than a long edge.
 */
export function sutroHallWallInset(x: number, z: number): number {
  const local = sutroWorldToLocal(x, z);
  return Math.min(
    SUTRO_BATHS.hallHalfWidth - Math.abs(local.x),
    SUTRO_BATHS.halfLength - Math.abs(local.z)
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

/**
 * The road pavilion floor and the doorway sill, MIRRORED from the built
 * colliders (centres local (46.65, 63.1) 15.9 × 12.4 m and (37.6, 63.1)
 * 2.2 × 5.0 m). They meet edge to edge at x 38.7, so the walk from the road
 * doors to the head of the spiral is one continuous authored surface.
 *
 * Deliberately EXACT rather than padded. These two rectangles used to carry the
 * recovery pad in their literals, which put a phantom 31.18 m floor over half a
 * metre of open hillside on every side — and the terrace out there sits at
 * 30 m, so the contract lifted anyone standing on it 1.2 m into the air, let
 * them fall, and lifted them again.
 */
const ROAD_PAVILION_FLOOR = { minX: 38.7, maxX: 54.6, minZ: 56.9, maxZ: 69.3 } as const;
const ROAD_THRESHOLD_SLAB = { minX: 36.5, maxX: 38.7, minZ: 60.6, maxZ: 65.6 } as const;
const ROAD_LEVEL_Y = 31.18;

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

// A capsule can move farther than a tread edge in one busy frame, so the
// recovery contract stays a hair wider than the built slabs — but only a hair.
// This used to be 0.45 m, which hung the stair's walk surface half a metre out
// over the open stairwell and the terrace beside the road steps; standing under
// one of those overhangs is what threw visitors into the air.
const ENTRY_RECOVERY_PAD = 0.12;

/**
 * How far the recovery contract may lift a visitor, in metres.
 *
 * The deepest LEGITIMATE strand is the terrain handoff: the hall footprint
 * lowers the ground to 2.07 while the built deck stands at 5.62, so a capsule
 * caught in that frame is 3.55 m under its floor. A capsule further below an
 * authored surface than that is not stranded beneath it — it is standing
 * somewhere else entirely, on the deck under the spiral or on the terrace
 * beside the pavilion — and hoisting it there is a teleport, not a rescue.
 */
const MAX_RECOVERY_LIFT = 4;

/**
 * A surface within this much of the feet counts as the one being stood on. The
 * solver rests a capsule a skin width around its contact point, so the computed
 * foot height wanders a few millimetres either side of the slab it is on.
 */
const SUPPORT_TOLERANCE = 0.06;

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

/**
 * Surface picking, in two buckets.
 *
 * The hall is a MULTI-LEVEL room and the point that proves it is the grand
 * spiral: it crosses the deck it lands on, so almost every square metre of its
 * annulus has two authored floors — a tread up to 25 m overhead and the deck
 * underneath. Answering such a point with the topmost surface is what threw
 * anyone walking beneath the stair onto the stair, and the same shape (a road
 * slab over a hall floor) repeats at the doorway.
 *
 * So candidates are sorted against the visitor's feet: the highest surface AT
 * OR BELOW them is what they are standing on, and only when nothing is under
 * them at all does the lowest surface ABOVE them count as a floor they have
 * been stranded beneath. Module-scope accumulators keep the per-frame query
 * allocation-free; the resolver is synchronous and non-reentrant.
 */
let surfaceSupport = Number.NEGATIVE_INFINITY;
let surfaceLedge = Number.POSITIVE_INFINITY;
let surfaceFeetY: number | null = null;

function beginSurfaceQuery(feetY: number | null): void {
  surfaceSupport = Number.NEGATIVE_INFINITY;
  surfaceLedge = Number.POSITIVE_INFINITY;
  surfaceFeetY = feetY;
}

function considerSurface(surface: number | null): void {
  if (surface === null) return;
  // No visitor to sort against (the pool climb-out probes a bare point): keep
  // the highest authored surface, which is the historic answer.
  if (surfaceFeetY === null || surface <= surfaceFeetY + SUPPORT_TOLERANCE) {
    if (surface > surfaceSupport) surfaceSupport = surface;
  } else if (surface < surfaceLedge) {
    surfaceLedge = surface;
  }
}

function resolveSurface(): number | null {
  if (surfaceSupport > Number.NEGATIVE_INFINITY) return surfaceSupport;
  if (surfaceFeetY === null || surfaceLedge === Number.POSITIVE_INFINITY) return null;
  return surfaceLedge - surfaceFeetY <= MAX_RECOVERY_LIFT ? surfaceLedge : null;
}

/**
 * Walk surface for the rebuilt road switchback and lower beach entrance.
 *
 * `feetY` is the WORLD height of the visitor's soles; omit it to ask for the
 * highest authored entry surface at the point regardless of who is there.
 */
export function sutroEntryWalkSurfaceY(x: number, z: number, feetY: number | null = null): number | null {
  beginSurfaceQuery(feetY);
  addEntrySurfaces(sutroWorldToLocal(x, z));
  return resolveSurface();
}

/** Offer every authored entry surface at a LOCAL point to the open query. */
function addEntrySurfaces(local: { x: number; z: number }): void {
  // The road terrain is explicitly handed to a coherent pavilion floor, and the
  // interior threshold slab carries the doorway onto the gallery's top flight.
  if (insideRect(local.x, local.z, ROAD_PAVILION_FLOOR.minX, ROAD_PAVILION_FLOOR.maxX, ROAD_PAVILION_FLOOR.minZ, ROAD_PAVILION_FLOOR.maxZ)) {
    considerSurface(ROAD_LEVEL_Y);
  }
  if (insideRect(local.x, local.z, ROAD_THRESHOLD_SLAB.minX, ROAD_THRESHOLD_SLAB.maxX, ROAD_THRESHOLD_SLAB.minZ, ROAD_THRESHOLD_SLAB.maxZ)) {
    considerSurface(ROAD_LEVEL_Y);
  }
  considerSurface(stairSurfaceY(local.z, local.x, ROAD_APPROACH_STAIR));
  // The single helical descent. Offered alongside the flat slabs it passes
  // under rather than after them, so a visitor on the top treads resolves to
  // the tread they are on and not to the threshold sill a metre above it.
  considerSurface(sutroSpiralWalkSurfaceY(local.x, local.z));
  // Foot apron butting the fan onto the deck (authored 2 cm under the fan).
  if (insideRect(local.x, local.z, 18.51, 25.52, 41.58, 49.98)) considerSurface(5.76);

  // The beach stair runs along local x, so swap the axes for the shared helper.
  considerSurface(stairSurfaceY(local.z, local.x, BEACH_ENTRY_STAIR));
  if (insideRect(local.x, local.z, -64.5, -62, 28.79, 37.79)) considerSurface(1.75);
  if (insideRect(local.x, local.z, -38.6, -33.9, 28.79, 37.79)) considerSurface(5.66);
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
 * The authored walk surface a visitor at (x, z) is standing on — or, when
 * nothing is under them, the one they have been stranded just beneath.
 *
 * The streamed Box3D colliders remain the primary collision source. This is a
 * recovery contract for the frame in which those bodies replace the old
 * terrain, or for an unusually fast capsule that crosses a thin floor slab.
 * Pool footprints deliberately resolve to the basin instead of the deck so a
 * visitor can still step into and wade through every bath.
 *
 * `feetY` is the WORLD height of the visitor's soles. Pass it: without it the
 * query cannot tell the deck from the stair 25 m above the same spot, and
 * answers with the stair. Omitting it (the pool climb-out, which probes a bare
 * point beside a bath) keeps the plain highest-surface answer.
 */
export function sutroWalkSurfaceY(x: number, z: number, feetY: number | null = null): number | null {
  const local = sutroWorldToLocal(x, z);
  beginSurfaceQuery(feetY);
  addEntrySurfaces(local);
  if (
    Math.abs(local.x) <= SUTRO_BATHS.hallHalfWidth &&
    Math.abs(local.z) <= SUTRO_BATHS.halfLength
  ) {
    considerSurface(poolAtLocal(local.x, local.z) ? SUTRO_BATHS.basinY : SUTRO_BATHS.deckY);
  }
  return resolveSurface();
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
