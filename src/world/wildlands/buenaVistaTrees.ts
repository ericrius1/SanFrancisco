import * as THREE from "three/webgpu";
import {
  createNativeTreeForest,
  type NativeTreeForest,
  type NativeTreePrepareUnit
} from "../nativeTreeForest";
import type { GardenTerrain } from "../garden/layout";
import { distanceToBuenaVistaPark } from "../buenaVista";
import {
  collectWildTrees,
  BUENA_VISTA_TREE_DESIGNS,
  type WildRegionId,
  type WildTreeExclusion,
  type WildTreeRegionFilter
} from "./layout";

const BUENA_VISTA_ONLY: WildTreeRegionFilter = new Set<WildRegionId>(["buenavista"]);
const UNDERSTORY_LOAD_DISTANCE = 140;
const UNDERSTORY_VISIBLE_DISTANCE = 230;

type BuenaVistaUnderstory = import("./buenaVistaUnderstory").BuenaVistaUnderstory;

export type BuenaVistaFoliage = {
  group: THREE.Group;
  ready: Promise<void>;
  update(focus: { x: number; z: number }): void;
  prepareVisible(prepare: NativeTreePrepareUnit): Promise<void>;
  dispose(): void;
  /** Tree diagnostics retain the historical shape used by the foliage probes. */
  stats: NativeTreeForest["stats"];
  understoryStats(): BuenaVistaUnderstory["stats"] | null;
};

/**
 * Long-range Buena Vista canopy plus a nested close-only scrub stage. Corona
 * Heights can load the skyline trees without collecting the rest of Wildlands
 * or fetching shrub code; the retained prepare callback admits the understory
 * without exposing an uncompiled WebGPU pipeline on first approach.
 */
export function createBuenaVistaTrees(
  map: GardenTerrain,
  excluded?: WildTreeExclusion
): BuenaVistaFoliage {
  const slots = collectWildTrees(map, excluded, BUENA_VISTA_ONLY);
  const trees = createNativeTreeForest(BUENA_VISTA_TREE_DESIGNS, slots, {
    name: "buena_vista_trees",
    chunkSize: 150,
    visibleDistance: 1050,
    nearRadius: 96,
    nearExitRadius: 110,
    nearMax: 36
  });
  const group = new THREE.Group();
  group.name = "buena_vista_foliage";
  group.add(trees.group);

  let prepareUnit: NativeTreePrepareUnit | null = null;
  let understory: BuenaVistaUnderstory | null = null;
  let understoryLoad: Promise<void> | null = null;
  let understoryFailed = false;
  let disposed = false;
  let focus = { x: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY };

  const ensureUnderstory = (): Promise<void> => {
    if (disposed || understory || understoryFailed) return Promise.resolve();
    if (understoryLoad) return understoryLoad;
    understoryLoad = (async () => {
      const { createBuenaVistaUnderstory } = await import("./buenaVistaUnderstory");
      const patch = createBuenaVistaUnderstory(map, excluded);
      patch.group.visible = false;
      if (disposed) {
        patch.dispose();
        return;
      }
      // Compile detached and locally visible. compileAsync skips invisible
      // roots, while attaching before the promise resolves would expose a live
      // frame to an unprepared pipeline.
      patch.group.visible = true;
      if (prepareUnit) await prepareUnit(patch.group);
      if (disposed) {
        patch.dispose();
        return;
      }
      understory = patch;
      patch.group.visible = distanceToBuenaVistaPark(focus.x, focus.z) <= UNDERSTORY_VISIBLE_DISTANCE;
      group.add(patch.group);
    })().catch((error) => {
      understoryFailed = true;
      console.warn("[buena-vista] close understory failed:", error);
    }).finally(() => {
      understoryLoad = null;
    });
    return understoryLoad;
  };

  const maybeLoadUnderstory = () => {
    const distance = distanceToBuenaVistaPark(focus.x, focus.z);
    if (understory) understory.group.visible = distance <= UNDERSTORY_VISIBLE_DISTANCE;
    if (prepareUnit && distance <= UNDERSTORY_LOAD_DISTANCE) {
      void ensureUnderstory();
    }
  };

  return {
    group,
    ready: trees.ready,
    stats: trees.stats,
    update(nextFocus) {
      focus = { x: nextFocus.x, z: nextFocus.z };
      trees.update(nextFocus);
      maybeLoadUnderstory();
    },
    async prepareVisible(prepare) {
      prepareUnit = prepare;
      await trees.prepareVisible(prepare);
      if (distanceToBuenaVistaPark(focus.x, focus.z) <= UNDERSTORY_LOAD_DISTANCE) {
        await ensureUnderstory();
      }
    },
    understoryStats() {
      return understory?.stats ?? null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      understory?.dispose();
      understory = null;
      trees.dispose();
      group.removeFromParent();
      group.clear();
    }
  };
}
