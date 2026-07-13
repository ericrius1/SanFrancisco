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
import { updateWindGusts, windGustValue } from "../vegetation/wind";
import {
  BOTANICAL_GARDEN_BOUNDS,
  GARDEN_MEADOW,
  inBotanicalGarden,
  type GardenCollider,
  type GardenTerrain
} from "./layout";

const NO_DISPLACERS: readonly GrassDisplacer[] = [];

// Whole-garden visibility gate. The SeedThree far tier is frustumCulled=false
// (its instanced bounds span the whole garden), so those triangles would draw from
// ANYWHERE in the city without this. Gate the ENTIRE garden group by distance to
// the garden's bounding circle — Corona Heights / downtown must never pay for GG
// Park grass or trees. Hidden past ~900 m outside the circle, with ~100 m
// hysteresis so it never flickers at the boundary.
const GARDEN_GATE = (() => {
  const b = BOTANICAL_GARDEN_BOUNDS;
  return {
    cx: (b.minX + b.maxX) / 2,
    cz: (b.minZ + b.maxZ) / 2,
    radius: Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2,
    hideDist: 900, // hide once the player is this far OUTSIDE the bounding circle
    showDist: 800 // re-show when back within this (100 m hysteresis band)
  };
})();

export type BotanicalGarden = {
  /** Add to your scene. Trees stream in asynchronously; grass is live at once. */
  group: THREE.Group;
  /** Resolves after the asynchronous SeedThree trees are attached. */
  ready: Promise<void>;
  /** Combine the master foliage switch with the garden's distance gate. */
  setVisible(visible: boolean, focus: { x: number; z: number }): void;
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
  // Are we currently forcing the garden hidden by distance? Tracked so we only
  // write group.visible when CROSSING a threshold — an external foliage on/off
  // toggle (host debug panel) then still wins while the player is in range.
  let gatedOut = false;
  let enabled = true;
  const updateGate = (focus: { x: number; z: number }) => {
    const edge = Math.hypot(focus.x - GARDEN_GATE.cx, focus.z - GARDEN_GATE.cz) - GARDEN_GATE.radius;
    if (!gatedOut && edge > GARDEN_GATE.hideDist) gatedOut = true;
    else if (gatedOut && edge < GARDEN_GATE.showDist) gatedOut = false;
  };
  const applyVisibility = () => {
    veg.group.visible = enabled && !gatedOut;
  };
  return {
    group: veg.group,
    ready: veg.ready,
    setVisible(visible, focus) {
      enabled = visible;
      updateGate(focus);
      applyVisibility();
    },
    proxy: veg.proxy,
    grass: veg.grass,
    colliders: veg.colliders,
    stats: veg.stats,
    update(dt, focus, displacers) {
      // Shared ground-cover meta-modules must advance regardless of the garden's
      // own visibility: the wind-gust envelope also drives the wildlands foliage
      // sway + the nature soundscape, and the trample field is read by the
      // wildlands grass/flowers too — and the garden is their sole per-frame
      // driver. Freezing them here would stall wind/trample across the whole city.
      updateWindGusts(dt);
      setGrassDisplacers(displacers ?? NO_DISPLACERS);

      // Whole-garden distance gate (see GARDEN_GATE). Hiding the group stops the
      // far-tier trees from rendering AND parks the self-driven tree LOD rebin
      // (its driver meshes no longer render, so onBeforeRender stops firing); the
      // rebin resumes cleanly on re-entry off the live camera. Also zero grass
      // draw ranges so a stale visible flag can't leak tris while gated out
      // (Corona Heights / FiDi must never pay for GG Park blades).
      updateGate(focus);
      applyVisibility();
      if (!enabled || gatedOut) {
        veg.grass.park();
        return;
      }

      veg.grass.updateFocus(focus);
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
