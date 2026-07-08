// SF Botanical Garden — public surface. A self-contained, portable vegetation
// module: trees (SeedThree hero growth + near/far instanced LOD), procedural
// blade grass (terrain-clamped base layer + moving near-detail ring + trample),
// zone-paletted shrubs, ground flora, colliders, and a shared wind envelope.
//
// Drop the whole `garden/` folder into any three/webgpu project. The ONLY things
// it needs from the host are:
//   • a terrain sampler implementing `GardenTerrain` (groundHeight/surfaceType/isWater)
//   • the vendored SeedThree checkout at <repo>/vendor/SeedThree/src
//   • the staged tree textures at <public>/seedthree  (optional — trees fall back
//     to procedural materials if the PNGs 404)
//   • src/core/persist `tunables()` for the live-tunable grass sliders
//
// Everything else (layout math, LOD, wind) lives behind this index. Layout is in
// ./layout with NO three dependency, so a headless trainer can reconstruct the
// identical obstacle set.

import type * as THREE from "three/webgpu";
import { createGardenVegetation, type GardenVegetation } from "./gardenVegetation";
import {
  MAX_GRASS_DISPLACERS,
  setGrassDisplacers,
  type BotanicalGrassController,
  type BotanicalGrassStats,
  type GrassDisplacer
} from "./botanicalGrass";
import { updateWindGusts, windGustValue } from "./wind";
import {
  BOTANICAL_GARDEN_BOUNDS,
  GARDEN_MEADOW,
  inBotanicalGarden,
  type GardenCollider,
  type GardenTerrain
} from "./layout";

const NO_DISPLACERS: readonly GrassDisplacer[] = [];

export type BotanicalGarden = {
  /** Add to your scene. Trees stream in asynchronously; grass is live at once. */
  group: THREE.Group;
  /** Hidden trunk+canopy proxy mesh — register it with a surface raycaster if
   *  you want to stand/click on the garden trees. Optional. */
  proxy: THREE.Mesh;
  grass: BotanicalGrassController;
  /** Pure collider data (trunk boxes). Map onto the host physics for solid
   *  trunks, or ignore for walk-through decoration (matches how loose flora
   *  behaves). */
  colliders: GardenCollider[];
  stats: GardenVegetation["stats"];
  /**
   * Call once per frame.
   *  • advances the shared wind-gust envelope (grass sway + any wind audio)
   *  • moves the near-grass detail ring to `focus` (usually the camera/player)
   *  • writes trample displacers that flatten grass under the player/creatures
   * SeedThree tree LOD self-drives off the render loop — nothing else to tick.
   */
  update(dt: number, focus: { x: number; z: number }, displacers?: readonly GrassDisplacer[]): void;
};

/** Build the whole garden over a host terrain. Synchronous; trees populate as
 *  their textures + growth resolve (fire-and-forget inside). */
export function createBotanicalGarden(map: GardenTerrain): BotanicalGarden {
  const veg = createGardenVegetation(map);
  return {
    group: veg.group,
    proxy: veg.proxy,
    grass: veg.grass,
    colliders: veg.colliders,
    stats: veg.stats,
    update(dt, focus, displacers) {
      updateWindGusts(dt);
      veg.grass.updateFocus(focus);
      setGrassDisplacers(displacers ?? NO_DISPLACERS);
    }
  };
}

// Host wiring / debug helpers.
export {
  MAX_GRASS_DISPLACERS,
  setGrassDisplacers,
  updateWindGusts,
  windGustValue,
  BOTANICAL_GARDEN_BOUNDS,
  GARDEN_MEADOW,
  inBotanicalGarden
};
export { createGardenVegetation, type GardenVegetation } from "./gardenVegetation";
export { SEED_TREE_DESIGNS, type SeedTreeDesign } from "./seedTreeGarden";
export type { BotanicalGrassController, BotanicalGrassStats, GrassDisplacer, GardenCollider, GardenTerrain };
