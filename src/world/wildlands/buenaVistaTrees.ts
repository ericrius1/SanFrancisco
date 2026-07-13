import { createNativeTreeForest, type NativeTreeForest } from "../nativeTreeForest";
import type { GardenTerrain } from "../garden/layout";
import {
  collectWildTrees,
  WILD_TREE_DESIGNS,
  type WildRegionId,
  type WildTreeExclusion,
  type WildTreeRegionFilter
} from "./layout";

const BUENA_VISTA_ONLY: WildTreeRegionFilter = new Set<WildRegionId>(["buenavista"]);

/** Long-range Buena Vista canopy, isolated so Corona Heights can load it
 * without collecting or retaining the rest of the open-world forest. */
export function createBuenaVistaTrees(
  map: GardenTerrain,
  excluded?: WildTreeExclusion
): NativeTreeForest {
  const slots = collectWildTrees(map, excluded, BUENA_VISTA_ONLY);
  return createNativeTreeForest(WILD_TREE_DESIGNS, slots, {
    name: "buena_vista_trees",
    chunkSize: 150,
    visibleDistance: 1050,
    nearRadius: 96,
    nearExitRadius: 110,
    nearMax: 36
  });
}
