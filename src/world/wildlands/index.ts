// Wildlands — designed unified foliage across Golden Gate Park, the Presidio,
// and the Marin Headlands. Groves, cypress windrows, oak savannas, and
// noise-banded wildflower drifts, all deterministic (layout.ts) and rendered
// through the chunked nativeTreeForest engine + a player-following flower ring.
//
// Public surface mirrors the botanical garden: hand it a terrain sampler, add
// the groups, tick update() with a focus point. All outdoor tree beauty uses the
// same NativeTreeForest runtime; layout owns only deterministic planting intent.

import type * as THREE from "three/webgpu";
import { createNativeTreeForest, type NativeTreeForest } from "../nativeTreeForest";
import { createFlowerRing, type FlowerRing } from "./flowerRing";
import { createWildGrass, type WildGrass } from "./grassField";
import { collectWildTrees, WILD_TREE_DESIGNS, type WildRegionId } from "./layout";
import type { GardenTerrain } from "../garden/layout";

export { wildRegionAt, WILD_REGIONS } from "./layout";

// The three wildlands layers stay separate + independently toggleable (each owns
// its group); they only share the ground-cover infra (wind, displacers, chunked
// LOD). Toggle a layer via `wildlands.<layer>.group.visible`.
export type Wildlands = {
  trees: NativeTreeForest;
  flowers: FlowerRing;
  grass: WildGrass;
  /** Resolves after the asynchronous NativeTreeForest designs/chunks are attached. */
  ready: Promise<void>;
  /** add all layer groups to the scene */
  groups: THREE.Group[];
  /**
   * Per-frame update. `ringFocus` anchors the player-following grass + flower
   * rings — it MUST be the player, not the camera: the chase camera orbits the
   * player when you look around, so anchoring the rings to it slides the whole
   * field around you (grass swims / detaches from the ground). `cullFocus`
   * (defaults to ringFocus) drives the tree distance-culling and legitimately
   * wants the camera so off-screen groves drop.
   */
  update(ringFocus: { x: number; z: number }, cullFocus?: { x: number; z: number }): void;
  stats: { trees: number; flowers: number; treeChunks: number };
};

export type WildlandsExclusions = {
  /** Keep animated blades and flowers off authored play surfaces. */
  groundcover?: (x: number, z: number) => boolean;
  /** Keep authored trees off tees/fairways/greens while retaining rough trees. */
  trees?: (x: number, z: number) => boolean;
};

const PRIMARY_WILD_REGIONS: ReadonlySet<WildRegionId> = new Set([
  "ggpark",
  "presidio",
  "marin",
  "twinpeaks"
]);

export function createWildlands(map: GardenTerrain, exclusions: WildlandsExclusions = {}): Wildlands {
  // Buena Vista is a separate first-approach owner because it is visible from
  // Corona Heights while every primary Wildlands region is still distant.
  // Keeping that canopy out of this owner prevents either side from waking the
  // other's compiler prototypes and material sets.
  const treeSlots = collectWildTrees(map, exclusions.trees, PRIMARY_WILD_REGIONS);
  const trees = createNativeTreeForest(WILD_TREE_DESIGNS, treeSlots, {
    name: "wildlands_trees",
    chunkSize: 176,
    visibleDistance: 380, // small trees at range read as noise; cull tighter for GPU
    // Keep enough individually selected close trees beyond the landscape handoff
    // for a stable crown silhouette. Both the near pool and chunk tier are native
    // whole-tree batches; entry/exit hysteresis prevents boundary flicker.
    nearRadius: 96,
    nearExitRadius: 110,
    nearMax: 46
  });
  const flowers = createFlowerRing(map, exclusions.groundcover); // player-following ring, like the grass
  const grass = createWildGrass(map, exclusions.groundcover); // player-following ring; free off green (grows in city parks too)

  return {
    trees,
    flowers,
    grass,
    ready: trees.ready,
    groups: [trees.group, flowers.group, grass.group],
    update(ringFocus, cullFocus = ringFocus) {
      trees.update(cullFocus); // distance-cull to what the camera sees
      flowers.update(ringFocus); // rings stay centred on the player, not the camera
      grass.update(ringFocus);
    },
    get stats() {
      return {
        trees: treeSlots.length,
        flowers: flowers.stats.count, // live: the ring re-scatters as the player moves
        treeChunks: trees.stats.chunks
      };
    }
  };
}
