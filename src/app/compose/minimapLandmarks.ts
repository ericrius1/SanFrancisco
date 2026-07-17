// Static minimap landmark pins (activity sites + parks). Extracted from
// main.ts per docs/MAIN_DECOMPOSITION.md: pure pin data + registration, split
// into the same two boot moments main.ts always used (activity pins right
// after the minimap exists, park pins beside the region proximity gates).
import { GOLDMAN_GAMEPLAY_LANDMARK } from "../../world/goldenGateTennis/meta";
import { ARCHERY_CENTER } from "../../gameplay/archery/meta";
import { PUP_CENTER } from "../../gameplay/pup/meta";
import { FORT_MASON_ENSEMBLE_CENTER } from "../../gameplay/fortMasonEnsemble/meta";
import { REVERIE_CENTER } from "../../gameplay/palaceReverie/meta";
import { GHOST_SHIP_LANDMARK_NAME } from "../../world/ghostShip/route";
import { LANDS_END_CENTER } from "../../world/landsEnd/meta";
import { WAVE_ORGAN_CENTER } from "../../world/waveOrgan/meta";
import { BEACH_PIANIST_CENTER } from "../../world/beachPianist/meta";
import { JAPANESE_TEA_GARDEN_ENTRANCE } from "../../world/japaneseTeaGarden/layout";
import { CORONA_HEIGHTS_SUMMIT } from "../../world/coronaHeights/meta";
import { AFTERLIGHT_ARRIVAL } from "../../gameplay/afterlight/meta";
import { BOTANICAL_GARDEN_BOUNDS } from "../../world/garden/layout";
import { SPAWN_POINTS } from "../../world/spawnPoints";
import { oceanBeachSurfShackPose } from "../../gameplay/surfing/shack";
import type { Minimap } from "../../ui/minimap";
import type { AuthoredRegionStreamer } from "../../world/authoredRegions";

/** Botanical Garden centroid — shared by the map pin and the region NEAR gate. */
export const GARDEN_XZ = {
  x: (BOTANICAL_GARDEN_BOUNDS.minX + BOTANICAL_GARDEN_BOUNDS.maxX) / 2,
  z: (BOTANICAL_GARDEN_BOUNDS.minZ + BOTANICAL_GARDEN_BOUNDS.maxZ) / 2
};
export const GOLF_XZ = { x: -1979, z: -194 }; // Presidio course centroid (golf.json tee coords)

/** Activity-site pins, registered the moment the minimap exists. */
export function registerActivityLandmarks(
  minimap: Minimap,
  map: { isWater(x: number, z: number): boolean },
  ghostShipPose: Readonly<{ x: number; z: number }>,
  ensureSurfShack: () => void
): void {
  minimap.addLandmark(GOLDMAN_GAMEPLAY_LANDMARK.x, GOLDMAN_GAMEPLAY_LANDMARK.z, "Goldman Tennis & Pickleball");
  // Archery range — NW corner of Golden Gate Park. Static known coords (the
  // site builds hidden behind its gate), so the pin is safe to drop even when
  // the range is asleep. Marks the field + gives a teleport like golf/tennis.
  minimap.addLandmark(ARCHERY_CENTER.x, ARCHERY_CENTER.z, "Archery Range");
  minimap.addLandmark(PUP_CENTER.x, PUP_CENTER.z, "Puppy Nursery");
  minimap.addLandmark(FORT_MASON_ENSEMBLE_CENTER.x, FORT_MASON_ENSEMBLE_CENTER.z, "Fort Mason Jam");
  minimap.addLandmark(REVERIE_CENTER.x, REVERIE_CENTER.z, "Palace Reverie");
  minimap.addLandmark(ghostShipPose.x, ghostShipPose.z, GHOST_SHIP_LANDMARK_NAME);
  // Ocean Beach surf shack. Teleporting arrives on foot at the apron;
  // one E press on a racked board enters the live face already standing and moving.
  {
    const apron = oceanBeachSurfShackPose(map);
    minimap.addLandmark(apron.x, apron.z, "Ocean Beach · Surf");
    ensureSurfShack();
  }
  minimap.addLandmark(LANDS_END_CENTER.x, LANDS_END_CENTER.z, "Lands End · Labyrinth");
  // The Marina breakwater sculpture. The pin is just the place's name — what
  // sleeps out there is for the walker to find.
  minimap.addLandmark(WAVE_ORGAN_CENTER.x, WAVE_ORGAN_CENTER.z, "Wave Organ");
  // Marshall's Beach grand piano, framed by the Golden Gate Bridge.
  minimap.addLandmark(BEACH_PIANIST_CENTER.x, BEACH_PIANIST_CENTER.z, "Beach Pianist");
}

/**
 * Park + authored-region pins. Landmark + minigame map pins are registered
 * EAGERLY at boot from static coords, independent of the lazy region builds —
 * the pin is always on the map and clickable (teleport), while the heavy
 * assets stream in only when you approach or teleport there. Names dedupe, so
 * a lazy build re-adding the same name just refines the pin's coords (e.g.
 * golf snaps to the first tee on load).
 */
export function registerParkLandmarks(
  minimap: Minimap,
  authoredRegions: AuthoredRegionStreamer
): void {
  minimap.addLandmark(JAPANESE_TEA_GARDEN_ENTRANCE.x, JAPANESE_TEA_GARDEN_ENTRANCE.z, "Japanese Tea Garden");
  minimap.addLandmark(GARDEN_XZ.x, GARDEN_XZ.z, "Botanical Garden");
  minimap.addLandmark(GOLF_XZ.x, GOLF_XZ.z, "Presidio Golf");
  minimap.addLandmark(CORONA_HEIGHTS_SUMMIT.x, CORONA_HEIGHTS_SUMMIT.z, "Corona Heights");
  // Buena Vista summit clearing — west of Corona Heights. Plain park name so
  // the pin reads as a place, not a secret quest.
  minimap.addLandmark(AFTERLIGHT_ARRIVAL.x, AFTERLIGHT_ARRIVAL.z, "Buena Vista");
  const missionDoloresSpawn = SPAWN_POINTS.missionDolores;
  minimap.addLandmark(missionDoloresSpawn.x, missionDoloresSpawn.z, missionDoloresSpawn.label);
  for (const arrival of authoredRegions.landmarkArrivals()) {
    minimap.addLandmark(arrival.x, arrival.z, arrival.label);
  }
}
