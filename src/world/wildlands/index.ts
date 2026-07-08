// Wildlands — designed SeedThree foliage across Golden Gate Park, the Presidio,
// and the Marin Headlands. Groves, cypress windrows, oak savannas, and
// noise-banded wildflower drifts, all deterministic (layout.ts) and rendered
// through the chunked seedForest engine + a player-following flower ring.
//
// Public surface mirrors the botanical garden: hand it a terrain sampler, add
// the group, tick update() with a focus point. The old stylized trees suppress
// themselves inside these regions via wildlandsSuppressesTree (see wiring in
// main.ts / flora.ts / forest.ts).

import type * as THREE from "three/webgpu";
import { createSeedForest, type SeedForest } from "../seedForest";
import { createFlowerRing, type FlowerRing } from "./flowerRing";
import { createWildGrass, type WildGrass } from "./grassField";
import { collectWildTrees, WILD_TREE_DESIGNS, type WildTree } from "./layout";
import type { GardenTerrain } from "../garden/layout";

export { wildlandsSuppressesTree, wildRegionAt, WILD_REGIONS } from "./layout";

// The three wildlands layers stay separate + independently toggleable (each owns
// its group); they only share the ground-cover infra (wind, displacers, chunked
// LOD). Toggle a layer via `wildlands.<layer>.group.visible`.
export type Wildlands = {
  trees: SeedForest;
  flowers: FlowerRing;
  grass: WildGrass;
  /** add all layer groups to the scene */
  groups: THREE.Group[];
  /** per-frame: LOD/culling + the player-following grass & flower rings, from a focus point */
  update(focus: { x: number; z: number }): void;
  stats: { trees: number; flowers: number; treeChunks: number };
};

export function createWildlands(map: GardenTerrain): Wildlands {
  const treeSlots: WildTree[] = collectWildTrees(map);

  const trees = createSeedForest(WILD_TREE_DESIGNS, treeSlots, {
    name: "wildlands_trees",
    chunkSize: 176,
    visibleDistance: 380, // small trees at range read as noise; cull tighter for GPU
    farCastShadow: false,
    // Kill LOD pop: the near hero clones reach OUT PAST lod2Dist (78 m), so by
    // the time a clone hands off to the instanced far tier it is already showing
    // the same LOD2 geometry — the swap is invisible. Clones on LOD2 are cheap
    // (flat cards), so a big budget is affordable; only the few within ~46 m are
    // full geometry. Hysteresis on the exit radius stops boundary flicker.
    nearRadius: 96,
    nearExitRadius: 110,
    nearMax: 46
  });
  const flowers = createFlowerRing(map); // player-following ring, like the grass
  const grass = createWildGrass(map); // player-following ring; free outside the regions

  return {
    trees,
    flowers,
    grass,
    groups: [trees.group, flowers.group, grass.group],
    update(focus) {
      trees.update(focus);
      flowers.update(focus);
      grass.update(focus);
    },
    get stats() {
      return {
        trees: treeSlots.length,
        flowers: flowers.stats.count, // live: the ring re-scatters as the player moves
        treeChunks: 0 // filled once seedForest finishes async build (see trees.stats)
      };
    }
  };
}
