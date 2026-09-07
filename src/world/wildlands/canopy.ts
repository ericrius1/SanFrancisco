// The landscape canopy has its own lazy boundary. Importing it never constructs
// the player-following grass/flower fields or a golf/gameplay renderer.
import {
  createNativeTreeForest,
  type NativeTreeForest,
  type NativeTreePrepareUnit,
} from "../nativeTreeForest";
import { collectWildTrees, WILD_TREE_DESIGNS, type WildRegionId } from "./layout";
import type { GardenTerrain } from "../garden/layout";
import { WILDLANDS_CANOPY_VISIBLE_DISTANCE } from "./regions";
import { copyTreeCullFocus, type TreeCullFocus } from "../vegetation/treeCullFocus";

const PRIMARY_WILD_REGIONS: ReadonlySet<WildRegionId> = new Set([
  "ggpark", "presidio", "marin", "twinpeaks",
]);

export type WildlandsCanopy = {
  trees: NativeTreeForest;
  readonly focus: Readonly<TreeCullFocus>;
  update(focus: Readonly<TreeCullFocus>, force?: boolean): void;
  prepareAt(
    focus: Readonly<TreeCullFocus>,
    prepare?: NativeTreePrepareUnit,
    signal?: AbortSignal,
  ): Promise<void>;
  dispose(): void;
};

export function createWildlandsCanopy(
  map: GardenTerrain,
  excludeTree?: (x: number, z: number) => boolean,
): WildlandsCanopy {
  // Buena Vista owns an independent forest; it does not wake these prototypes.
  const trees = createNativeTreeForest(WILD_TREE_DESIGNS, {
    tileSize: 704,
    load: bounds => collectWildTrees(map, excludeTree, PRIMARY_WILD_REGIONS, bounds),
  }, {
    name: "wildlands_trees",
    chunkSize: 176,
    visibleDistance: WILDLANDS_CANOPY_VISIBLE_DISTANCE,
    horizonDistance: 220,
    impostorDistance: 420,
    nearRadius: 96,
    nearExitRadius: 110,
    nearMax: 72,
  });
  let focus: TreeCullFocus = { x: 0, z: 0 };
  let disposed = false;
  return {
    trees,
    get focus() { return focus; },
    update(next, force) {
      if (disposed) return;
      focus = copyTreeCullFocus(next);
      trees.update(focus, force);
    },
    prepareAt(next, prepare, signal) {
      if (disposed) return Promise.reject(new DOMException("Canopy disposed", "AbortError"));
      focus = copyTreeCullFocus(next);
      return trees.prepareAt(focus, prepare, signal);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      trees.group.removeFromParent();
      trees.dispose();
    },
  };
}
