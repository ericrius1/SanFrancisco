// SF Botanical Garden — public surface. A garden placement/controller module:
// shared trees (hero growth + near/far instanced LOD), shared curved blade grass
// (terrain-clamped base + moving near-detail ring + trample), shared leaf-spray
// shrubs and dimensional flowers, plus garden colliders. Sandbox-wide geometry,
// wind and interaction state live in ../vegetation; this module owns garden work.
//
// Its host contract is:
//   • a terrain sampler implementing `GardenTerrain` (groundHeight/surfaceType/isWater)
//   • the sandbox vegetation tree facade (which currently owns the transitional
//     generator adapter and its staged tree textures)
//   • src/core/persist `tunables()` for the live-tunable grass sliders
//
// Garden layout math and rendering live behind this index. Layout is in
// ./layout with NO three dependency, so a headless trainer can reconstruct the
// identical obstacle set.

import type * as THREE from "three/webgpu";
import { createGardenVegetation, type GardenVegetation } from "./gardenVegetation";
import {
  type BotanicalGrassController,
  type BotanicalGrassStats
} from "./botanicalGrass";
import {
  BOTANICAL_GARDEN_BOUNDS,
  GARDEN_MEADOW,
  inBotanicalGarden,
  type GardenCollider,
  type GardenTerrain
} from "./layout";

// Whole-garden visibility gate. The legacy garden far tier spans the full site,
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
  /** Resolves after the asynchronous shared trees are attached. */
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
   *  • moves the near-grass detail ring to `focus` (usually the camera/player)
   * Tree LOD self-drives off the render loop — nothing else to tick.
   */
  update(focus: { x: number; z: number }): void;
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
    update(focus) {
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
      veg.update(focus);
    }
  };
}

export {
  BOTANICAL_GARDEN_BOUNDS,
  GARDEN_MEADOW,
  inBotanicalGarden
};
export { createGardenVegetation, type GardenVegetation } from "./gardenVegetation";
export { SEED_TREE_DESIGNS, type SeedTreeDesign } from "./treeDesigns";
export type { BotanicalGrassController, BotanicalGrassStats, GardenCollider, GardenTerrain };
