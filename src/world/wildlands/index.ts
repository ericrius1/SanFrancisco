// Wildlands — designed unified foliage across Golden Gate Park, the Presidio,
// and the Marin Headlands. Groves, cypress windrows, oak savannas, and
// noise-banded wildflower drifts, all deterministic (layout.ts) and rendered
// through the chunked nativeTreeForest engine + a player-following flower ring.
//
// Public surface mirrors the botanical garden: hand it a terrain sampler, add
// the groups, tick update() with a focus point. All outdoor tree beauty uses the
// same NativeTreeForest runtime; layout owns only deterministic planting intent.

import type * as THREE from "three/webgpu";
import {
  createNativeTreeForest,
  type NativeTreeForest,
  type NativeTreePrepareUnit
} from "../nativeTreeForest";
import { yieldToFrame } from "../../core/cooperativeWork";
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
  /** Prepare current tree chunks and player-following groundcover before reveal. */
  prepareVisible(prepare: NativeTreePrepareUnit): Promise<void>;
  /** Prime one boot/teleport destination without depending on the frame loop. */
  prepareAt(
    focus: { x: number; z: number },
    prepare?: NativeTreePrepareUnit,
    signal?: AbortSignal
  ): Promise<void>;
  /**
   * Per-frame update. `ringFocus` anchors the player-following grass + flower
   * rings — it MUST be the player, not the camera: the chase camera orbits the
   * player when you look around, so anchoring the rings to it slides the whole
   * field around you (grass swims / detaches from the ground). `cullFocus`
   * (defaults to ringFocus) drives the tree distance-culling and legitimately
   * wants the camera so off-screen groves drop.
   */
  update(ringFocus: { x: number; z: number }, cullFocus?: { x: number; z: number }): void;
  /** Release all GPU resources owned by this regional foliage bundle. */
  dispose(): void;
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
    // Extend only the fixed-cost silhouette annulus. Pinning the handoff avoids
    // implicitly pushing the more expensive landscape tier out with visibility.
    visibleDistance: 520,
    horizonDistance: 220,
    // Keep enough individually selected close trees beyond the landscape handoff
    // for a stable crown silhouette. Both the near pool and chunk tier are native
    // whole-tree batches; entry/exit hysteresis prevents boundary flicker.
    nearRadius: 96,
    nearExitRadius: 110,
    nearMax: 46
  });
  const flowers = createFlowerRing(map, exclusions.groundcover); // player-following ring, like the grass
  const grass = createWildGrass(map, exclusions.groundcover); // player-following ring; free off green (grows in city parks too)
  let groundcoverPreparer: NativeTreePrepareUnit | null = null;
  let groundcoverTail: Promise<void> = Promise.resolve();
  let groundcoverEpoch = 0;
  const preparedGroundcover = new WeakSet<THREE.Object3D>();
  const preparingGroundcover = new WeakMap<THREE.Object3D, Promise<void>>();

  const groundcoverUnits = (): THREE.Object3D[] => {
    const units: THREE.Object3D[] = [];
    for (const layer of [flowers.group, grass.group]) {
      layer.traverse((object) => {
        const renderable = object as THREE.Object3D & {
          isInstancedMesh?: boolean;
          count?: number;
        };
        if (renderable.isInstancedMesh && (renderable.count ?? 0) > 0) units.push(object);
      });
    }
    return units;
  };

  const queueGroundcoverPreparation = (unit: THREE.Object3D): Promise<void> => {
    if (!groundcoverPreparer || preparedGroundcover.has(unit)) return Promise.resolve();
    const existing = preparingGroundcover.get(unit);
    if (existing) return existing;
    const revealEpoch = groundcoverEpoch;
    unit.visible = false;
    const queued = groundcoverTail.then(async () => {
      if (!groundcoverPreparer) return;
      const parent = unit.parent;
      if (parent) parent.remove(unit);
      unit.visible = true;
      try {
        await groundcoverPreparer(unit);
        preparedGroundcover.add(unit);
      } finally {
        unit.visible = false;
        if (parent) parent.add(unit);
      }
      await yieldToFrame();
      const mesh = unit as THREE.Object3D & { count?: number };
      unit.visible = revealEpoch === groundcoverEpoch && (mesh.count ?? 0) > 0;
    });
    let tracked: Promise<void>;
    tracked = queued.finally(() => {
      if (preparingGroundcover.get(unit) === tracked) preparingGroundcover.delete(unit);
    });
    preparingGroundcover.set(unit, tracked);
    groundcoverTail = tracked.catch(() => {});
    return tracked;
  };

  const gateGroundcover = (): Promise<void>[] => {
    const jobs: Promise<void>[] = [];
    for (const unit of groundcoverUnits()) {
      if (groundcoverPreparer && !preparedGroundcover.has(unit)) {
        unit.visible = false;
        jobs.push(queueGroundcoverPreparation(unit));
      } else {
        unit.visible = true;
      }
    }
    return jobs;
  };

  const destinationSuperseded = () =>
    new DOMException("Wildlands destination superseded", "AbortError");

  const prepareCurrentGroundcover = async (expectedEpoch?: number): Promise<void> => {
    while (true) {
      if (expectedEpoch !== undefined && expectedEpoch !== groundcoverEpoch) {
        throw destinationSuperseded();
      }
      const jobs = gateGroundcover();
      if (jobs.length === 0) return;
      await Promise.all(jobs);
    }
  };

  const abortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(destinationSuperseded());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(destinationSuperseded());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };

  return {
    trees,
    flowers,
    grass,
    ready: trees.ready,
    groups: [trees.group, flowers.group, grass.group],
    async prepareVisible(prepare) {
      groundcoverPreparer = prepare;
      await trees.prepareVisible(prepare);
      // Only non-empty species/grass tiers are prepared. Empty pools stay truly
      // lazy and gate themselves on their first later activation.
      await Promise.all(gateGroundcover());
    },
    async prepareAt(focus, prepare, signal) {
      if (signal?.aborted) throw destinationSuperseded();
      if (prepare) groundcoverPreparer = prepare;
      const epoch = ++groundcoverEpoch;
      const onAbort = () => {
        if (epoch !== groundcoverEpoch) return;
        groundcoverEpoch++;
        for (const unit of groundcoverUnits()) unit.visible = false;
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // Scatter the exact destination ring synchronously, then hide any new
        // unprepared pools before a render can traverse them under the cover.
        flowers.update(focus);
        grass.update(focus);
        for (const unit of groundcoverUnits()) {
          unit.visible = !groundcoverPreparer || preparedGroundcover.has(unit);
        }

        // Tree preparation is internally sliced and serialized. Groundcover
        // follows on the same callback to avoid competing compileAsync bursts.
        await trees.prepareAt(focus, prepare, signal);
        if (signal?.aborted || epoch !== groundcoverEpoch) throw destinationSuperseded();
        await abortable(prepareCurrentGroundcover(epoch), signal);
        if (signal?.aborted || epoch !== groundcoverEpoch) throw destinationSuperseded();
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
    update(ringFocus, cullFocus = ringFocus) {
      trees.update(cullFocus); // distance-cull to what the camera sees
      flowers.update(ringFocus); // rings stay centred on the player, not the camera
      grass.update(ringFocus);
      if (groundcoverPreparer) {
        for (const job of gateGroundcover()) {
          void job.catch((error) => console.warn("[wildlands] groundcover prepare failed", error));
        }
      }
    },
    dispose() {
      trees.dispose();
      flowers.dispose();
      grass.dispose();
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
