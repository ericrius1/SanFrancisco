// Code-level spawn registry. Baked spawns live in meta.json (map.meta.spawns);
// these sit on top of them and carry the extra per-location knobs that make a
// spawn cheap to boot: which heavy park regions must be ready when the cover
// lifts, versus which stream in afterwards while the player takes in the view.
//
// This is the abstraction the whole "optimize for a specific place" idea rests
// on: adding a great spawn is a few lines here, and its boot cost is whatever
// its own immediate surroundings cost — never the whole city's foliage.

import type { PlayerMode } from "../player/types";
import { OCEAN_BEACH_SURF, oceanBeachApproxShoreX } from "./oceanBeachWaves";
import { mdToWorldXZ, Z_ENTRANCE } from "./missionDolores/layout";

/** Lightweight gate metadata stays in the boot spawn registry; the restored
 * hall, pools, vegetation and effects remain wholly behind their dynamic import. */
export const SUTRO_BATHS_GATE = {
  centerX: -6125,
  centerZ: 1117,
  yaw: -0.077,
  halfWidth: 38.7,
  halfLength: 76.1
} as const;

/** The dry Point Lobos portal above the broad descending museum stair. */
export const SUTRO_BATHS_ARRIVAL = {
  x: -6086,
  z: 1184,
  heading: Math.PI / 2
} as const;

export function distanceToSutroBaths(x: number, z: number): number {
  const dxWorld = x - SUTRO_BATHS_GATE.centerX;
  const dzWorld = z - SUTRO_BATHS_GATE.centerZ;
  const c = Math.cos(SUTRO_BATHS_GATE.yaw);
  const s = Math.sin(SUTRO_BATHS_GATE.yaw);
  const localX = c * dxWorld - s * dzWorld;
  const localZ = s * dxWorld + c * dzWorld;
  const dx = Math.max(Math.abs(localX) - SUTRO_BATHS_GATE.halfWidth, 0);
  const dz = Math.max(Math.abs(localZ) - SUTRO_BATHS_GATE.halfLength, 0);
  return Math.hypot(dx, dz);
}

const MISSION_DOLORES_ENTRY = mdToWorldXZ(0, Z_ENTRANCE - 8);

/** Heavy park regions built lazily off the boot path (own Vite chunks). A spawn
 * either GATES a region (built before reveal) or lets it stream in after. */
export type RegionKey = "garden" | "wildlands" | "golf";

export const ALL_REGIONS: readonly RegionKey[] = ["garden", "wildlands", "golf"];

export type SpawnPoint = {
  key: string;
  label: string;
  x: number;
  z: number;
  /** Raw facing yaw (forward = (−sinθ, −cosθ)); the chase cam sits behind it. */
  heading: number;
  /** Embodiment to arrive in. Omit to keep the session default (START.mode). */
  mode?: PlayerMode;
  /** Regions that MUST finish before the loading cover lifts. Anything omitted
   * streams in after reveal (hidden → compileAsync → shown), so it never delays
   * first play. `undefined` = distance-based default (a region gates only when
   * the spawn sits within NEAR_GATE of its footprint). An explicit list — `[]`
   * included — overrides distance, which is how a scenic-but-treeless spot like
   * Corona Heights opts into the leanest possible boot. */
  gates?: readonly RegionKey[];
  /** Draw radius (m) loaded BEFORE reveal. Only the near district — baked tiles
   * AND procedural citygen cells, both keyed off CONFIG.tileLoadRadius — gates
   * the cover; the full draw distance is restored the instant it lifts and the
   * rest of the city streams in behind the distance fog. Omit for no cap (a
   * dense spawn then waits for its whole neighbourhood). This is the lever for
   * "load Mission/Castro in after you're already standing on the hill". */
  bootTileRadius?: number;
};

export const SPAWN_POINTS: Record<string, SpawnPoint> = {
  // Exterior forecourt, eight metres before the open west doors. The museum's
  // dynamic proximity gate wakes immediately, while the player begins on real
  // park ground and walks naturally into the raised sanctuary floor.
  missionDolores: {
    key: "missionDolores",
    label: "Mission Dolores · Saint Francis",
    x: MISSION_DOLORES_ENTRY.x,
    z: MISSION_DOLORES_ENTRY.z,
    heading: Math.PI, // local +z, through the portal toward the apse
    mode: "walk",
    gates: [],
    bootTileRadius: 700
  },
  // Ocean Beach surf pin — dry sand at the live waterline (approx until map
  // resolves the exact edge via oceanBeachShoreline), facing the swell.
  oceanBeach: {
    key: "oceanBeach",
    label: "Ocean Beach · Surf",
    x: oceanBeachApproxShoreX(OCEAN_BEACH_SURF.entryZ) + 4,
    z: OCEAN_BEACH_SURF.entryZ,
    heading: Math.PI / 2, // west into the break
    mode: "walk",
    gates: [],
    bootTileRadius: 700
  },
  // Main entrance to the Japanese Tea Garden. The authored garden is coupled to
  // the Botanical Garden region so both designed landscapes are ready before a
  // direct-location boot reveals the world.
  japaneseTeaGarden: {
    key: "japaneseTeaGarden",
    label: "Japanese Tea Garden",
    x: -2239.8,
    z: 2196.5,
    heading: 0.78,
    mode: "walk",
    gates: ["garden"],
    bootTileRadius: 700
  },
  teaGardenGuide: {
    key: "teaGardenGuide",
    label: "Japanese Tea Garden · Tea House",
    x: -2282.4,
    z: 2171.4,
    heading: -1.57,
    mode: "walk",
    gates: ["garden"],
    bootTileRadius: 700
  },
  teaGardenPagoda: {
    key: "teaGardenPagoda",
    label: "Japanese Tea Garden · Pagoda Plaza",
    x: -2280,
    z: 2185,
    heading: 1.88,
    mode: "walk",
    gates: ["garden"],
    bootTileRadius: 700
  },
  teaGardenDrumBridge: {
    key: "teaGardenDrumBridge",
    label: "Japanese Tea Garden · Drum Bridge",
    x: -2280,
    z: 2195,
    heading: -1.25,
    mode: "walk",
    gates: ["garden"],
    bootTileRadius: 700
  },
  // Corona Heights summit — the busker trio on the SE rim, the dog park just
  // below, red-chert crags underfoot, and the whole downtown/Mission skyline
  // dropping away to the east. Nothing tree-heavy sits at the spawn itself (the
  // hill's own grass/crags/dog park are built with the world), so it gates
  // NOTHING: garden, wildlands and golf all stream in after reveal while the
  // player reads the name gate and looks at the view. The leanest boot we have.
  coronaHeights: {
    key: "coronaHeights",
    label: "Corona Heights",
    x: 398,
    z: 2752,
    heading: -2.1, // faces SE over the buskers toward the Mission and downtown
    mode: "walk",
    gates: [],
    // From 150 m up, the near hillside + immediate blocks are what reads; the
    // dense Mission/Castro grid beyond streams in over the next second or two.
    bootTileRadius: 700
  },
  // Palace of Fine Arts lagoon shore — blue-hour Reverie quest start.
  palaceReverie: {
    key: "palaceReverie",
    label: "Palace Reverie",
    x: -248,
    z: -1410,
    heading: -2.35,
    mode: "walk",
    gates: [],
    bootTileRadius: 800
  },
  // Lands End — the NW headland. Arrive on the cliff plateau beside the stone
  // Labyrinth, the open Pacific dropping away to the WNW. Treeless clifftop, so
  // it gates nothing: the city and parks stream in behind you after reveal.
  landsEnd: {
    key: "landsEnd",
    label: "Lands End",
    x: -5872,
    z: 792,
    heading: 2.0, // faces WNW over the labyrinth toward the open ocean
    mode: "walk",
    gates: [],
    bootTileRadius: 700
  },
  // Point Lobos entry terrace above the restored 1896 enclosure. The feature
  // chunk crosses its own first-approach gate after reveal; this dry exterior
  // spawn stays safe even if construction is still finishing below.
  sutroBaths: {
    key: "sutroBaths",
    label: "Sutro Baths · 1896",
    x: SUTRO_BATHS_ARRIVAL.x,
    z: SUTRO_BATHS_ARRIVAL.z,
    heading: SUTRO_BATHS_ARRIVAL.heading,
    mode: "walk",
    gates: [],
    bootTileRadius: 700
  }
};

/** A code spawn if one is registered for `key`, else null (fall back to the
 * baked meta.json spawn table). */
export function resolveSpawnPoint(key: string): SpawnPoint | null {
  return SPAWN_POINTS[key] ?? null;
}
