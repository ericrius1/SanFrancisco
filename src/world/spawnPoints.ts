// Code-level spawn registry. Baked spawns live in meta.json (map.meta.spawns).
// Entries describe authored arrival poses only; loading policy is deliberately
// generic and proximity-driven, never customized per landmark.

import type { PlayerMode } from "../player/types";
import { OCEAN_BEACH_SURF, oceanBeachApproxShoreX } from "./oceanBeachWaves";
import { mdToWorldXZ, Z_ENTRANCE } from "./missionDolores/layout";

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
  // Ocean Beach surf pin — dry sand at the live waterline (approx until map
  // resolves the exact edge via oceanBeachShoreline), facing the swell.
  oceanBeach: {
    key: "oceanBeach",
    label: "Ocean Beach · Surf",
    x: oceanBeachApproxShoreX(OCEAN_BEACH_SURF.entryZ) + 4,
    z: OCEAN_BEACH_SURF.entryZ,
    heading: Math.PI / 2, // west into the break
    mode: "walk"
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
  }
};

/** A code spawn if one is registered for `key`, else null (fall back to the
 * baked meta.json spawn table). */
export function resolveSpawnPoint(key: string): SpawnPoint | null {
  return SPAWN_POINTS[key] ?? null;
}
