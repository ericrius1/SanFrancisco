// Code-level spawn registry. Baked spawns live in meta.json (map.meta.spawns).
// Entries describe authored arrival poses only; loading policy is deliberately
// generic and proximity-driven, never customized per landmark.

import type { PlayerMode } from "../player/types";
import { oceanBeachSurfShackApproxPose } from "../gameplay/surfing/shack";
import { mdToWorldXZ, Z_ENTRANCE } from "./missionDolores/layout";

/** Lightweight gate metadata stays in the boot spawn registry; the restored
 * hall, pools, vegetation and effects remain wholly behind their dynamic import. */
export const SUTRO_BATHS_GATE = {
  centerX: -6125,
  centerZ: 1117,
  yaw: -0.077,
  /** Includes the lower beach approach; the architectural hall remains 38.7 m wide. */
  halfWidth: 55.5,
  halfLength: 76.1
} as const;

/** The dry Point Lobos portal above the broad descending museum stair. */
export const SUTRO_BATHS_ARRIVAL = {
  x: -6084.38916,
  z: 1183.420776,
  heading: 1.942
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

export type SpawnPoint = {
  key: string;
  label: string;
  x: number;
  z: number;
  /** Raw facing yaw (forward = (−sinθ, −cosθ)); the chase cam sits behind it. */
  heading: number;
  /** Embodiment to arrive in. Omit to keep the session default (START.mode). */
  mode?: PlayerMode;
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
    mode: "walk"
  },
  // Ocean Beach surf shack apron — dry sand facing the racked boards (refined
  // at boot via oceanBeachSurfShackPose once the shoreline is known).
  oceanBeach: (() => {
    const pose = oceanBeachSurfShackApproxPose();
    return {
      key: "oceanBeach",
      label: "Ocean Beach · Surf",
      x: pose.x,
      z: pose.z,
      heading: pose.heading,
      mode: "walk" as const
    };
  })(),
  // Main entrance to the Japanese Tea Garden. The authored garden is coupled to
  // the Botanical Garden region so both designed landscapes are ready before a
  // direct-location boot reveals the world.
  japaneseTeaGarden: {
    key: "japaneseTeaGarden",
    label: "Japanese Tea Garden",
    x: -2239.8,
    z: 2196.5,
    heading: 0.78,
    mode: "walk"
  },
  teaGardenGuide: {
    key: "teaGardenGuide",
    label: "Japanese Tea Garden · Tea House",
    x: -2282.4,
    z: 2171.4,
    heading: -1.57,
    mode: "walk"
  },
  teaGardenPagoda: {
    key: "teaGardenPagoda",
    label: "Japanese Tea Garden · Pagoda Plaza",
    x: -2280,
    z: 2185,
    heading: 1.88,
    mode: "walk"
  },
  teaGardenDrumBridge: {
    key: "teaGardenDrumBridge",
    label: "Japanese Tea Garden · Drum Bridge",
    x: -2280,
    z: 2195,
    heading: -1.25,
    mode: "walk"
  },
  // Corona Heights summit — the busker trio on the SE rim, the dog park just
  // below, red-chert crags underfoot, and the whole downtown/Mission skyline
  // dropping away to the east.
  coronaHeights: {
    key: "coronaHeights",
    label: "Corona Heights",
    x: 398,
    z: 2752,
    heading: -2.1, // faces SE over the buskers toward the Mission and downtown
    mode: "walk"
  },
  // Palace of Fine Arts lagoon shore — blue-hour Reverie quest start.
  palaceReverie: {
    key: "palaceReverie",
    label: "Palace Reverie",
    x: -248,
    z: -1410,
    heading: -2.35,
    mode: "walk"
  },
  // Lands End — the NW headland. Arrive on the cliff plateau beside the stone
  // Labyrinth, the open Pacific dropping away to the WNW.
  landsEnd: {
    key: "landsEnd",
    label: "Lands End",
    x: -5872,
    z: 792,
    heading: 2.0, // faces WNW over the labyrinth toward the open ocean
    mode: "walk"
  },
  // Point Lobos entry terrace above the restored 1896 enclosure. The feature
  // chunk crosses its own first-approach gate after reveal.
  sutroBaths: {
    key: "sutroBaths",
    label: "Sutro Baths · 1896",
    x: SUTRO_BATHS_ARRIVAL.x,
    z: SUTRO_BATHS_ARRIVAL.z,
    heading: SUTRO_BATHS_ARRIVAL.heading,
    mode: "walk"
  },

  // --- Iconic landmark arrivals for the random boot pool (LANDMARK_POOL) ------
  // Several mirror authored baked poses in map.meta.spawns so the whole pool is
  // resolvable through resolveSpawnPoint alone (the default-arrival path never
  // consults the baked table). Headings computed to look at the landmark:
  // forward = (−sinθ, −cosθ), so θ = atan2(−dx, −dz) toward the target.
  goldenGate: {
    key: "goldenGate",
    label: "Golden Gate Bridge",
    x: -2982,
    z: -2798,
    heading: 0.07, // onto the deck toward the north tower
    mode: "walk"
  },
  coit: {
    key: "coit",
    label: "Coit Tower",
    x: 3366,
    z: -1405,
    heading: Math.PI, // up Telegraph Hill toward the tower
    mode: "walk"
  },
  transamerica: {
    key: "transamerica",
    label: "Transamerica Pyramid",
    x: 3680,
    z: 120,
    heading: 0, // north up the block at the pyramid
    mode: "walk"
  },
  salesforce: {
    key: "salesforce",
    label: "Salesforce Tower",
    x: 4117,
    z: 130,
    heading: 0, // north toward the tower + its crown
    mode: "walk"
  },
  embarcadero: {
    key: "embarcadero",
    label: "Ferry Building · Embarcadero",
    x: 4340,
    z: -380,
    heading: 1.8,
    mode: "walk"
  },
  downtown: {
    key: "downtown",
    label: "Downtown · Financial District",
    x: 3900,
    z: 200,
    heading: 0.5,
    mode: "walk"
  },
  bayfront: {
    key: "bayfront",
    label: "Bayfront",
    x: 3000,
    z: -2600,
    heading: 2.4,
    mode: "walk"
  },
  marinaGreen: {
    key: "marinaGreen",
    label: "Marina Green",
    x: -700,
    z: -2350,
    heading: 0,
    mode: "walk"
  },
  presidio: {
    key: "presidio",
    label: "The Presidio",
    x: -2275,
    z: -640,
    heading: 1.22,
    mode: "walk"
  },
  // Mount Sutro summit at the foot of the tower's tripod; findOpenSpawn spirals
  // out to the nearest cleared pad through the eucalyptus.
  sutroTower: {
    key: "sutroTower",
    label: "Sutro Tower",
    x: -720,
    z: 3846,
    heading: Math.PI / 2, // west, up at the three-legged mast
    mode: "walk"
  },
  botanicalGarden: {
    key: "botanicalGarden",
    label: "SF Botanical Garden",
    x: -2290,
    z: 2470,
    heading: -0.72,
    mode: "walk"
  },
  archeryRange: {
    key: "archeryRange",
    label: "Golden Gate Park · Archery",
    x: -5547,
    z: 2079,
    heading: -Math.PI / 2, // downrange, east along the dune shelf
    mode: "walk"
  },
  // North across the bridge — the Marin redwood grove with its rideable bears.
  marinRedwoods: {
    key: "marinRedwoods",
    label: "Marin Redwoods",
    x: -3150,
    z: -5100,
    heading: 0.81, // SW into the grove toward the herd
    mode: "walk"
  }
};

/**
 * The curated "coolest landmarks" pool. A fresh session with no resumable
 * localStorage position drops the player at a random one of these (see
 * main.ts boot + START_DEFAULTS.spawn). Every key must exist in SPAWN_POINTS.
 * Spread from the Golden Gate NW to Sutro/Corona SE, mixing real icons with our
 * own gameplay spots (buskers, archery, garden, Marin bears).
 */
export const LANDMARK_POOL = [
  "goldenGate",
  "coit",
  "transamerica",
  "salesforce",
  "embarcadero",
  "downtown",
  "bayfront",
  "marinaGreen",
  "palaceReverie",
  "presidio",
  "missionDolores",
  "coronaHeights",
  "sutroTower",
  "oceanBeach",
  "landsEnd",
  "japaneseTeaGarden",
  "teaGardenDrumBridge",
  "botanicalGarden",
  "archeryRange",
  "marinRedwoods"
] as const;

/** A guaranteed-open spawn used if a random landmark has no movement-safe
 *  ground nearby (findOpenSpawn throws) — an open hilltop that always clears. */
export const SAFE_SPAWN_FALLBACK = "coronaHeights";

/** Pick a random landmark spawn key from LANDMARK_POOL. */
export function pickLandmarkSpawn(): string {
  return LANDMARK_POOL[Math.floor(Math.random() * LANDMARK_POOL.length)];
}

/** A code spawn if one is registered for `key`, else null (fall back to the
 * baked meta.json spawn table). */
export function resolveSpawnPoint(key: string): SpawnPoint | null {
  return SPAWN_POINTS[key] ?? null;
}
