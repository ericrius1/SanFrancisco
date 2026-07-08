// Wildlands — designed SeedThree foliage across Golden Gate Park, the Presidio,
// and the Marin Headlands. Groves, cypress windrows, oak savannas, and
// noise-banded wildflower drifts, all deterministic (layout.ts) and rendered
// through the chunked seedForest engine + flowerField.
//
// Public surface mirrors the botanical garden: hand it a terrain sampler, add
// the group, tick update() with a focus point. The old stylized trees suppress
// themselves inside these regions via wildlandsSuppressesTree (see wiring in
// main.ts / flora.ts / forest.ts).

import type * as THREE from "three/webgpu";
import { createSeedForest, type SeedForest } from "../seedForest";
import { createFlowerField, type FlowerField } from "./flowerField";
import {
  collectWildFlowers,
  collectWildTrees,
  WILD_TREE_DESIGNS,
  type WildFlower,
  type WildTree
} from "./layout";
import type { GardenTerrain } from "../garden/layout";

export { wildlandsSuppressesTree, wildRegionAt, WILD_REGIONS } from "./layout";

export type Wildlands = {
  trees: SeedForest;
  flowers: FlowerField;
  /** add both to the scene */
  groups: THREE.Group[];
  /** per-frame: chunk culling for trees + flowers, from a focus point */
  update(focus: { x: number; z: number }): void;
  stats: { trees: number; flowers: number; treeChunks: number; flowerChunks: number };
};

export function createWildlands(map: GardenTerrain): Wildlands {
  const treeSlots: WildTree[] = collectWildTrees(map);
  const flowerList: WildFlower[] = collectWildFlowers(map);

  const trees = createSeedForest(WILD_TREE_DESIGNS, treeSlots, {
    name: "wildlands_trees",
    chunkSize: 176,
    visibleDistance: 380, // small trees at range read as noise; cull tighter for GPU
    farCastShadow: false
  });
  const flowers = createFlowerField(flowerList);

  return {
    trees,
    flowers,
    groups: [trees.group, flowers.group],
    update(focus) {
      trees.update(focus);
      flowers.update(focus);
    },
    stats: {
      trees: treeSlots.length,
      flowers: flowerList.length,
      treeChunks: 0, // filled once seedForest finishes async build (see trees.stats)
      flowerChunks: flowers.stats.chunks
    }
  };
}
