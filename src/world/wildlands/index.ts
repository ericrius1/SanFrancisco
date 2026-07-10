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
  /** Resolves after the asynchronous SeedForest designs/chunks are attached. */
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
  /** Keep procedural trees off tees/fairways/greens while retaining rough trees. */
  trees?: (x: number, z: number) => boolean;
};

export function createWildlands(map: GardenTerrain, exclusions: WildlandsExclusions = {}): Wildlands {
  const treeSlots: WildTree[] = collectWildTrees(map, exclusions.trees);

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
        treeChunks: 0 // filled once seedForest finishes async build (see trees.stats)
      };
    }
  };
}
