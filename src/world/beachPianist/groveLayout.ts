// Deterministic Beach Pianist grove layout, shared by the vegetation adapter
// (which plants the trees) and the bird layer (which lands on them). Pure math
// over the WorldMap — no vegetation-runtime imports, so the birds chunk stays
// light and both consumers always agree on where every tree stands.

import type { WorldMap } from "../heightmap";
import type { AuthoredTreePlacement } from "../vegetation/authoredTrees";
import { BEACH_PIANIST_BRIDGE_AIM, BEACH_PIANIST_SITE } from "./meta";

export type GroveArchetypeId = "pianist-cypress-elder" | "pianist-cypress-shelf" | "pianist-pine";

/** Authored trunk-to-tip heights per archetype (mirrored by vegetation.ts). */
export const GROVE_TREE_HEIGHTS: Record<GroveArchetypeId, number> = {
  "pianist-cypress-elder": 11.5,
  "pianist-cypress-shelf": 8.8,
  "pianist-pine": 10.2
};

export const GROVE_TREE_LIMIT = 24;

const SITE_X = BEACH_PIANIST_SITE.x;
const SITE_Z = BEACH_PIANIST_SITE.z;
const BRIDGE_DX = BEACH_PIANIST_BRIDGE_AIM.x - SITE_X;
const BRIDGE_DZ = BEACH_PIANIST_BRIDGE_AIM.z - SITE_Z;
const BRIDGE_INV_LENGTH = 1 / Math.hypot(BRIDGE_DX, BRIDGE_DZ);
const SIGHT_X = BRIDGE_DX * BRIDGE_INV_LENGTH;
const SIGHT_Z = BRIDGE_DZ * BRIDGE_INV_LENGTH;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function groveHash(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/** Signed metres to the screen-right of the arrival→bridge sightline. */
function rightOfBridgeSightline(x: number, z: number): number {
  const dx = x - SITE_X;
  const dz = z - SITE_Z;
  return dx * SIGHT_Z - dz * SIGHT_X;
}

function alongBridgeSightline(x: number, z: number): number {
  const dx = x - SITE_X;
  const dz = z - SITE_Z;
  return dx * SIGHT_X + dz * SIGHT_Z;
}

/**
 * Keep the arrival postcard clear: no trunks in a crown-wide aisle from the
 * pad out toward the Golden Gate deck. The old 24 m cutoff left a pine/elder
 * pair sitting ~1.4 m off-axis at ~30 m — exactly on the south tower. Bias
 * the cut wider on screen-right, where the bridge span reads in that shot.
 */
function blocksBridgeSightline(x: number, z: number): boolean {
  const along = alongBridgeSightline(x, z);
  if (along <= 0 || along >= 42) return false;
  const right = rightOfBridgeSightline(x, z);
  return right >= 0 ? right < 12 : -right < 9;
}

/** Reject wet or steep roots so trees (and landing birds) sit on stable ground. */
export function groveDryRoot(map: WorldMap, x: number, z: number, radius: number): number | null {
  if (map.isWater(x, z)) return null;
  const center = map.groundTop(x, z);
  let minY = center;
  let maxY = center;
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI * 0.25 + i * Math.PI * 0.5;
    const sx = x + Math.cos(angle) * radius;
    const sz = z + Math.sin(angle) * radius;
    if (map.isWater(sx, sz)) return null;
    const y = map.groundTop(sx, sz);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return maxY - minY <= Math.max(0.45, radius * 0.34) ? center : null;
}

export type GroveTreePlacement = AuthoredTreePlacement & { archetype: GroveArchetypeId };

/**
 * Evenly inspect the whole ring, then nudge/radially retry each sector. The
 * shoreline naturally rejects seaward candidates while retaining a grove on
 * every dry side of the performance. A clear axial aisle preserves the
 * authored arrival shot from the player through the piano to the bridge.
 */
export function collectGroveTrees(map: WorldMap): GroveTreePlacement[] {
  const placements: GroveTreePlacement[] = [];
  for (let sector = 0; sector < 38 && placements.length < GROVE_TREE_LIMIT; sector++) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const angle = sector * GOLDEN_ANGLE + (groveHash(sector, 17 + attempt) - 0.5) * 0.34;
      const radius = 9.5 + groveHash(sector, 31 + attempt) * 20.5 + attempt * 0.55;
      const x = SITE_X + Math.cos(angle) * radius;
      const z = SITE_Z + Math.sin(angle) * radius;
      if (blocksBridgeSightline(x, z)) continue;
      const y = groveDryRoot(map, x, z, 2);
      if (y === null) continue;
      const archetype: GroveArchetypeId = sector % 5 === 0
        ? "pianist-pine"
        : sector % 3 === 0
          ? "pianist-cypress-shelf"
          : "pianist-cypress-elder";
      placements.push({
        x,
        y,
        z,
        yaw: 0.88 + groveHash(sector, 53) * 0.8,
        scale: 0.78 + groveHash(sector, 71) * 0.34,
        archetype,
        nearDetail: true
      });
      break;
    }
  }
  return placements;
}

export type GrovePerch = {
  /** World-space crown landing point. */
  x: number;
  y: number;
  z: number;
  /** Facing for a settled bird (radians, heading convention `atan2(x, z)`). */
  yaw: number;
};

/**
 * Crown-top landing points spread around the grove — at most `limit`, strided
 * across the sector-ordered placements so perches cover every side rather than
 * clustering in the first few sectors.
 */
export function collectGrovePerches(trees: GroveTreePlacement[], limit: number): GrovePerch[] {
  if (trees.length === 0 || limit <= 0) return [];
  const stride = Math.max(1, Math.floor(trees.length / limit));
  const perches: GrovePerch[] = [];
  for (let i = 0; i < trees.length && perches.length < limit; i += stride) {
    const tree = trees[i];
    // Sit clearly ON the canopy silhouette, not inside it: a settled bird at
    // nine-tenths height disappears into the needle cards from every angle.
    const crown = tree.y + GROVE_TREE_HEIGHTS[tree.archetype as GroveArchetypeId] * tree.scale + 0.35;
    // Settled birds face roughly away from the site centre, with a hashed
    // scatter so the row of silhouettes never reads as parade-ground aligned.
    const outward = Math.atan2(tree.x - SITE_X, tree.z - SITE_Z);
    perches.push({
      x: tree.x,
      y: crown,
      z: tree.z,
      yaw: outward + (groveHash(i, 173) - 0.5) * 1.6
    });
  }
  return perches;
}
