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

/**
 * A stretch of one pool's edge that is NOT an edge at all, because the water
 * carries on into a sibling rectangle of the same body.
 *
 * The great plunge is an L, and an L is two rectangles. Everything downstream
 * of this table works in rectangles — the swim volume, the walk surface, the
 * visual sheet — so the L is stored as two entries that share a heat and a
 * tone, and the join between them is named here rather than left to be
 * rediscovered. Without it the water sheet insets itself away from the join
 * (a 16 cm crack straight across the plunge) and the shoreline feather paints
 * a 5 m foam band through the middle of open water.
 *
 * `from`/`to` run along the named side: the z-range for an x side, the x-range
 * for a z side. Mirrored from `tools/rebuild-sutro-pools.py`, which suppresses
 * coping, tiled wall and waterline band over exactly the same spans.
 */
export type SutroPoolSeam = {
  side: "minX" | "maxX" | "minZ" | "maxZ";
  from: number;
  to: number;
};

export type SutroPoolSpec = {
  id: string;
  label: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 0 cold ocean pool .. 1 hottest thermal pool. */
  heat: number;
  /** Edges shared with a sibling rectangle of the same body of water. */
  seams?: readonly SutroPoolSeam[];
  /**
   * Per-pool tint/phase key, 0..1. Explicit rather than derived from the array
   * index so the two halves of the great plunge cannot drift apart in colour.
   */
  tone: number;
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

/**
 * Seven bodies of water in eight rectangles, laid out to the 1896 interior
 * print rather than to a tidy plan.
 *
 * The great salt-water plunge is an L and always was: it runs the whole west
 * side of the hall, then opens out into a full-width court across the south
 * end, so the water wraps the room and a visitor arriving on the deck is
 * looking at it before they see anything else. Its two rectangles share a heat
 * and a tone and declare their join in `seams`, so everything downstream reads
 * them as one sheet.
 *
 * The five graduated salt baths and the fresh-water plunge bank over to the
 * EAST as a stack of wide, shallow tanks on a 12.2 m pitch — 8.6 m of water,
 * 3.6 m of catwalk. The narrow catwalks are the point: they are what puts
 * springboards, handrails and ladders close enough together to read as one
 * dense bathing machine instead of six pools in a field of tile.
 *
 * MIRRORED from `tools/rebuild-sutro-pools.py`, which builds the basins, decks
 * and coping these rectangles sit in and prints them as SUTRO_POOL_CONTRACT on
 * every run. Retune the field there and copy the printed rectangles here in the
 * same commit, or the water will not sit in the basins that were built for it.
 */
/**
 * The plunge's long leg, named on its own because the drain and the sunken
 * gallery below hang off this exact rectangle (see SUTRO_DRAIN / SUTRO_GROTTO).
 * One definition, two readers, so the room can never stop being the plunge's
 * shadow.
 */
const GREAT_PLUNGE_LEG = { minX: -31, maxX: -10, minZ: -55, maxZ: 22 } as const;

export const SUTRO_POOLS: readonly SutroPoolSpec[] = [
  {
    id: "great-plunge",
    label: "Great salt-water plunge",
    ...GREAT_PLUNGE_LEG,
    heat: 0,
    tone: 0,
    seams: [{ side: "maxZ", from: GREAT_PLUNGE_LEG.minX, to: GREAT_PLUNGE_LEG.maxX }]
  },
  {
    id: "great-plunge-court",
    label: "Great salt-water plunge · south court",
    minX: -31,
    maxX: 19,
    minZ: 22,
    maxZ: 44,
    heat: 0,
    tone: 0,
    seams: [{ side: "minZ", from: -31, to: -10 }]
  },
  {
    id: "bath-one",
    label: "Temperate bath I",
    minX: -4,
    maxX: 19,
    minZ: -55,
    maxZ: -46.4,
    heat: 0.2,
    tone: 0.18
  },
  {
    id: "bath-two",
    label: "Temperate bath II",
    minX: -4,
    maxX: 19,
    minZ: -42.8,
    maxZ: -34.2,
    heat: 0.38,
    tone: 0.35
  },
  {
    id: "bath-three",
    label: "Warm bath III",
    minX: -4,
    maxX: 19,
    minZ: -30.6,
    maxZ: -22,
    heat: 0.58,
    tone: 0.52
  },
  {
    id: "bath-four",
    label: "Hot bath IV",
    minX: -4,
    maxX: 19,
    minZ: -18.4,
    maxZ: -9.8,
    heat: 0.78,
    tone: 0.69
  },
  {
    id: "bath-five",
    label: "Hot bath V",
    minX: -4,
    maxX: 19,
    minZ: -6.2,
    maxZ: 2.4,
    heat: 1,
    tone: 0.86
  },
  {
    id: "fresh-plunge",
    label: "Fresh-water plunge",
    minX: -4,
    maxX: 19,
    minZ: 6,
    maxZ: 14.6,
    heat: 0.12,
    tone: 1
  }
] as const;

/** True when `along` falls on a stretch of `side` that is a join, not an edge. */
export function sutroPoolSeamCovers(
  pool: SutroPoolSpec,
  side: SutroPoolSeam["side"],
  along: number
): boolean {
  const seams = pool.seams;
  if (!seams) return false;
  for (const seam of seams) {
    if (seam.side === side && along >= seam.from && along <= seam.to) return true;
  }
  return false;
}

/**
 * Metres from a point inside `pool` to the nearest REAL edge of its body of
 * water — the join with a sibling rectangle does not count as one.
 *
 * This is the shoreline term: the water darkens and foams within a couple of
 * metres of a coping. Measuring it per rectangle instead would draw that band
 * across the middle of the great plunge, where there is nothing but water.
 */
export function sutroPoolEdgeDistance(pool: SutroPoolSpec, x: number, z: number): number {
  let best = Number.POSITIVE_INFINITY;
  if (!sutroPoolSeamCovers(pool, "minX", z)) best = Math.min(best, x - pool.minX);
  if (!sutroPoolSeamCovers(pool, "maxX", z)) best = Math.min(best, pool.maxX - x);
  if (!sutroPoolSeamCovers(pool, "minZ", x)) best = Math.min(best, z - pool.minZ);
  if (!sutroPoolSeamCovers(pool, "maxZ", x)) best = Math.min(best, pool.maxZ - z);
  return best;
}

/** True when any part of `side` is a join rather than an edge. */
export function sutroPoolSideIsSeamed(
  pool: SutroPoolSpec,
  side: SutroPoolSeam["side"]
): boolean {
  return (pool.seams ?? []).some((seam) => seam.side === side);
}

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

/**
 * The drain in the floor of the great plunge, and the room it falls into.
 *
 * WHY THE ROOM IS EXACTLY UNDER THE PLUNGE. Three things had to be true at
 * once, and the plunge's own footprint is the only place all three are:
 *
 *  - The room must be UNDER the authored region's `hall` footprint, whose
 *    terrain overlay pins groundTop to 2.07 m and whose surface map contains no
 *    water cell at all. That is what keeps a visitor 31 m below it from being
 *    classified as swimming in the open bay: `effectiveGround` down there reads
 *    2.07, sea level is 0, and `bed < waterY - 1` is simply false.
 *  - It must be under the great plunge specifically, because the drain is a
 *    real shaft and the water that goes down it has to land somewhere the
 *    player can follow it.
 *  - The plunge's own swim volume must stop at the tiles, or a dry room inside
 *    its 2D footprint would float its visitors thirty metres up. That is what
 *    `SwimVolume.bottomY` (world/swimVolumes.ts) is for.
 *
 * The room is the plunge's shadow: same centre, a little wider, and half the
 * hall's length. Which puts its inland wall under the hall's own timber
 * gallery, so the boards and the pictures repeat one level down, and its glazed
 * wall under the hall's glass — except that what is beyond this glass is the
 * sea floor itself.
 */
// DERIVED from the leg's own rectangle, never written out again. These two were
// the literals `(-31 + -10) * 0.5` and `(-55 + 29) * 0.5`, and when the pool
// field was rebuilt to the 1896 print the leg's south end moved from z 29 to
// z 22 — while that second expression merged through without a conflict. A
// stale centre here does not fail loudly: it slides the drain 3.5 m off the
// middle of the plunge and hangs the end of the room out past the water it is
// supposed to be the shadow of.
const PLUNGE_CENTRE_X = (GREAT_PLUNGE_LEG.minX + GREAT_PLUNGE_LEG.maxX) * 0.5;
const PLUNGE_CENTRE_Z = (GREAT_PLUNGE_LEG.minZ + GREAT_PLUNGE_LEG.maxZ) * 0.5;

export const SUTRO_DRAIN = {
  /** Centre of the great plunge's rectangle. */
  x: PLUNGE_CENTRE_X,
  z: PLUNGE_CENTRE_Z,
  /** The tile plane the collar is set into. */
  y: SUTRO_BATHS.basinY,
  /** Clear bore of the shaft. */
  radius: 2.5,
  /** The bronze collar standing proud of the tiles around it. */
  collarRadius: 3.35,
  collarHeight: 0.34,
  /**
   * Swim inside this of the bore, and low enough that you had to dive for it,
   * and the drain has you. The plunge is 2.56 m deep and buoyancy holds a
   * resting swimmer near the surface, so nobody arrives here by drifting.
   */
  grabRadius: 2.3,
  grabY: SUTRO_BATHS.basinY + 1.45,
  /** Where the room starts loading: in the water, this near the collar. */
  primeRadius: 30
} as const;

export const SUTRO_GROTTO = {
  /** Inner faces of the room (site-local). */
  floorY: -28.4,
  ceilingY: -16.6,
  /** The hung wall — under the hall's own gallery wall. Faces -x. */
  artFaceX: -9,
  /** The glazed wall, facing the open water. Faces +x. */
  glassFaceX: -32,
  /** The room runs 75.6 m of z, centred under the plunge. */
  centreZ: PLUNGE_CENTRE_Z,
  halfLength: 37.8,
  /** Twelve bays of 6.3 m; the art hangs on their centres. */
  bays: 12,
  bayPitch: 6.3,
  /** Structural thickness the collision shell and the visible slabs share. */
  shell: 1.1,
  /** The catch basin under the fall: an octagon, so its collision is exact. */
  poolRadius: 6.6,
  /** Coping 0.42 m above the water, the same step the baths above use. */
  poolSurfaceY: -28.82,
  poolFloorY: -31.9,
  /** The aperture the water comes through, and the column it falls as. */
  apertureRadius: 2.5
} as const;

/** Centre of the room in site-local x/z — the plunge's centre, one floor down. */
export const SUTRO_GROTTO_CENTRE = { x: PLUNGE_CENTRE_X, z: PLUNGE_CENTRE_Z } as const;

/**
 * Where a swimmer taken by the drain re-enters the world: inside the falling
 * column, just under the room's ceiling, still going down. They finish the trip
 * the way they started it — falling with the water — and land in the basin.
 */
export const SUTRO_GROTTO_DROP = {
  x: PLUNGE_CENTRE_X,
  z: PLUNGE_CENTRE_Z,
  y: SUTRO_GROTTO.ceilingY - 1.6,
  /** yaw + π looks along local +z, down the long axis of the room. */
  heading: SUTRO_BATHS.yaw + Math.PI
} as const;

/** …and where the upwelling in the middle of the basin puts them back. */
export const SUTRO_GROTTO_RISE = {
  x: PLUNGE_CENTRE_X,
  z: PLUNGE_CENTRE_Z,
  y: SUTRO_BATHS.basinY + 1.7,
  heading: SUTRO_BATHS.yaw + Math.PI,
  /**
   * Get this far into the middle of the basin — into the ring of falling water
   * itself — and E rides it back up. A shade wider than the column (2.5 m) so
   * being "in the fall" is judged by what it looks like rather than by hitting
   * a radius you cannot see.
   */
  radius: 3
} as const;

/** Distance (m) from the drain's axis, for a WORLD-space point. */
export function distanceToSutroDrain(x: number, z: number): number {
  const local = sutroWorldToLocal(x, z);
  return Math.hypot(local.x - SUTRO_DRAIN.x, local.z - SUTRO_DRAIN.z);
}

/** True when a WORLD-space point is inside the sunken gallery's clear volume. */
export function sutroGrottoContains(x: number, y: number, z: number, pad = 0): boolean {
  if (y < SUTRO_GROTTO.poolFloorY - pad || y > SUTRO_GROTTO.ceilingY + pad) return false;
  const local = sutroWorldToLocal(x, z);
  return (
    local.x >= SUTRO_GROTTO.glassFaceX - pad &&
    local.x <= SUTRO_GROTTO.artFaceX + pad &&
    Math.abs(local.z - SUTRO_GROTTO.centreZ) <= SUTRO_GROTTO.halfLength + pad
  );
}

/**
 * The catch basin, as the regular octagon its collision shell is actually built
 * from — so the water's edge and the stone under it can never disagree.
 * `poolRadius` is the octagon's INRADIUS: the distance to each flat.
 */
export function sutroGrottoPoolContains(x: number, z: number, inset = 0): boolean {
  const local = sutroWorldToLocal(x, z);
  const dx = local.x - SUTRO_GROTTO_CENTRE.x;
  const dz = local.z - SUTRO_GROTTO_CENTRE.z;
  const limit = SUTRO_GROTTO.poolRadius - inset;
  if (limit <= 0) return false;
  const diagonal = (Math.abs(dx) + Math.abs(dz)) * Math.SQRT1_2;
  return Math.abs(dx) <= limit && Math.abs(dz) <= limit && diagonal <= limit;
}

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
 * Collision is a continuous helical ramp (see tools/patch-sutro-stair-ramps.mjs),
 * so recovery returns the same continuous height rather than a discrete tread.
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
    return SPIRAL.topY + (SPIRAL.botY - SPIRAL.topY) * progress;
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
  const runPad = 0.12;
  if (
    across < stair.minAcross - ENTRY_RECOVERY_PAD ||
    across > stair.maxAcross + ENTRY_RECOVERY_PAD ||
    along < Math.min(stair.startAlong, stair.endAlong) - runPad ||
    along > Math.max(stair.startAlong, stair.endAlong) + runPad
  ) return null;
  const progress = Math.max(0, Math.min(1, (along - stair.startAlong) / (stair.endAlong - stair.startAlong)));
  return stair.startY + (stair.endY - stair.startY) * progress;
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
