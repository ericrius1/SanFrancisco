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
  /** Prepare player-following flowers/grass without waiting for native trees. */
  prepareGroundcover(prepare: NativeTreePrepareUnit): Promise<void>;
  /** Prepare native-tree chunks independently after groundcover can reveal. */
  prepareTrees(prepare: NativeTreePrepareUnit): Promise<void>;
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
  /** App-wide frame-budget lane used to page the player-following foliage field. */
  scheduleGroundcoverBuild?: (job: () => void | "again") => void;
};

type GroundcoverRenderable = THREE.Object3D & {
  isInstancedMesh?: boolean;
  isMesh?: boolean;
  material?: THREE.Material | THREE.Material[];
  geometry?: THREE.BufferGeometry & { isInstancedBufferGeometry?: boolean };
};

/**
 * WebGPU render pipelines are reusable across player-following groundcover objects when
 * they share a material and vertex-buffer layout. Instance capacity/count are
 * deliberately excluded: grass keeps fixed storage buffers and only its indirect
 * counts change, so movement never needs another shader/pipeline compile.
 */
export function groundcoverPipelineLayoutKey(object: THREE.Object3D): string | null {
  const renderable = object as GroundcoverRenderable;
  if (!renderable.geometry || !renderable.material) return null;
  const materials = Array.isArray(renderable.material)
    ? renderable.material
    : [renderable.material];
  const attributes = Object.entries(renderable.geometry.attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, attribute]) => {
      const arrayName = attribute.array?.constructor?.name ?? "unknown";
      const instanced = "isInstancedBufferAttribute" in attribute && attribute.isInstancedBufferAttribute
        ? 1
        : 0;
      return `${name}:${attribute.itemSize}:${attribute.normalized ? 1 : 0}:${arrayName}:${instanced}`;
    })
    .join(",");
  const indexArray = renderable.geometry.index?.array?.constructor?.name ?? "none";
  const kind = renderable.isInstancedMesh
    ? "instanced-mesh"
    : renderable.geometry.isInstancedBufferGeometry
      ? "instanced-geometry"
      : renderable.isMesh
        ? "mesh"
        : object.type;
  return `${kind}|${materials.map((material) => material.uuid).join(",")}|${indexArray}|${attributes}`;
}

/** @internal Exported so the streamed-tile contract can exercise admission. */
export function createGroundcoverPreparationRegistry() {
  const units = new WeakSet<THREE.Object3D>();
  const layouts = new Set<string>();
  return {
    has(object: THREE.Object3D): boolean {
      if (units.has(object)) return true;
      const layout = groundcoverPipelineLayoutKey(object);
      return layout !== null && layouts.has(layout);
    },
    mark(object: THREE.Object3D): void {
      units.add(object);
      const layout = groundcoverPipelineLayoutKey(object);
      if (layout !== null) layouts.add(layout);
    }
  };
}

export type GroundcoverPreparationRegistry = ReturnType<typeof createGroundcoverPreparationRegistry>;

/** @internal Compile a root off-scene while preserving its external visibility. */
export async function prepareGroundcoverRootPipelines(
  root: THREE.Object3D,
  units: readonly THREE.Object3D[],
  prepare: NativeTreePrepareUnit,
  registry: GroundcoverPreparationRegistry
): Promise<boolean> {
  const pending = units.filter((unit) => !registry.has(unit));
  if (pending.length === 0) {
    // Cache the object identity too, so steady-state frame gates do not need to
    // rebuild the structural key after layout-equivalent tiles are admitted.
    for (const unit of units) registry.mark(unit);
    return false;
  }

  const parent = root.parent;
  const parentIndex = parent?.children.indexOf(root) ?? -1;
  const rootWasVisible = root.visible;
  if (parent) parent.remove(root);
  root.visible = true;
  for (const unit of pending) unit.visible = true;
  try {
    await prepare(root);
    for (const unit of pending) registry.mark(unit);
  } finally {
    // Every input unit was non-empty when collected. Keep it locally revealable
    // while the root's master visibility remains exactly what the caller chose.
    for (const unit of pending) unit.visible = true;
    root.visible = rootWasVisible;
    if (parent) {
      parent.add(root);
      if (parentIndex >= 0 && parentIndex < parent.children.length - 1) {
        parent.children.splice(parent.children.indexOf(root), 1);
        parent.children.splice(parentIndex, 0, root);
      }
    }
  }
  return true;
}

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
  const grass = createWildGrass(map, exclusions.groundcover, {
    schedule: exclusions.scheduleGroundcoverBuild,
    // Completed tile buffers enter the group hidden. The preparation registry
    // compiles the first material/layout before reveal; later equivalent tiles
    // are admitted immediately from that warmed layout.
    requirePreparation: true
  }); // player-following ring; free off green (grows in city parks too)
  let groundcoverPreparer: NativeTreePrepareUnit | null = null;
  let groundcoverTail: Promise<void> = Promise.resolve();
  let groundcoverEpoch = 0;
  const preparedGroundcover = createGroundcoverPreparationRegistry();
  const preparingGroundcover = new WeakMap<THREE.Object3D, Promise<void>>();

  const renderableCount = (object: THREE.Object3D): number => {
    const renderable = object as THREE.Object3D & {
      isInstancedMesh?: boolean;
      count?: number;
      isMesh?: boolean;
      geometry?: { isInstancedBufferGeometry?: boolean; instanceCount?: number };
    };
    if (renderable.isInstancedMesh) return renderable.count ?? 0;
    if (renderable.isMesh && renderable.geometry?.isInstancedBufferGeometry) {
      return renderable.geometry.instanceCount ?? 0;
    }
    return 0;
  };

  const groundcoverUnits = (root?: THREE.Object3D): THREE.Object3D[] => {
    const units: THREE.Object3D[] = [];
    for (const layer of root ? [root] : [flowers.group, grass.group]) {
      layer.traverse((object) => {
        if (renderableCount(object) > 0) units.push(object);
      });
    }
    return units;
  };

  const queueGroundcoverPreparation = (unit: THREE.Object3D): Promise<void> => {
    if (!groundcoverPreparer || preparedGroundcover.has(unit)) {
      if (groundcoverPreparer) preparedGroundcover.mark(unit);
      return Promise.resolve();
    }
    const existing = preparingGroundcover.get(unit);
    if (existing) return existing;
    const revealEpoch = groundcoverEpoch;
    unit.visible = false;
    const queued = groundcoverTail.then(async () => {
      if (!groundcoverPreparer) return;
      // Several freshly completed tiles can enter the gate in one frame. The
      // first tile for a material/layout warms the pipeline; queued siblings
      // must re-check that shared registry here instead of redundantly compiling
      // every object that happened to be discovered before the first resolved.
      if (preparedGroundcover.has(unit)) {
        preparedGroundcover.mark(unit);
        unit.visible = revealEpoch === groundcoverEpoch && renderableCount(unit) > 0;
        return;
      }
      const parent = unit.parent;
      if (parent) parent.remove(unit);
      unit.visible = true;
      try {
        await groundcoverPreparer(unit);
        preparedGroundcover.mark(unit);
      } finally {
        unit.visible = false;
        if (parent) parent.add(unit);
      }
      await yieldToFrame();
      unit.visible = revealEpoch === groundcoverEpoch && renderableCount(unit) > 0;
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
        if (groundcoverPreparer) preparedGroundcover.mark(unit);
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

  const prepareGroundcoverRoots = async (prepare: NativeTreePrepareUnit): Promise<void> => {
    groundcoverPreparer = prepare;
    // Wait for the foliage field and its one atomic four-layer compute pass.
    // This gives the destination a complete far→hero surface under the cover.
    await grass.whenCriticalReady();
    for (const root of [flowers.group, grass.group]) {
      const units = groundcoverUnits(root);
      // One detached-root compile warms every distinct layer material/layout.
      // Later field pages reuse those fixed pipelines and storage buffers.
      if (await prepareGroundcoverRootPipelines(root, units, prepare, preparedGroundcover)) {
        await yieldToFrame();
      }
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
    prepareGroundcover(prepare) {
      return prepareGroundcoverRoots(prepare);
    },
    prepareTrees(prepare) {
      return trees.prepareVisible(prepare);
    },
    async prepareVisible(prepare) {
      // Destination-essential groundcover is admitted first. Native trees keep
      // their independent optional preparation path and cannot hold it back.
      await prepareGroundcoverRoots(prepare);
      await trees.prepareVisible(prepare);
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
        // Retarget both destination rings immediately. Flowers update in place;
        // grass pages its toroidal field, then publishes all four compacted layers
        // together after the shared preparation registry admits their layouts.
        flowers.update(focus);
        grass.update(focus);
        for (const unit of groundcoverUnits()) {
          unit.visible = !groundcoverPreparer || preparedGroundcover.has(unit);
        }

        // Groundcover is the immediate destination surface; prepare it before
        // the optional tree pipeline so a large grove cannot keep grass hidden.
        if (groundcoverPreparer) {
          await abortable(prepareGroundcoverRoots(groundcoverPreparer), signal);
        } else {
          await abortable(grass.whenCriticalReady(), signal);
          await abortable(prepareCurrentGroundcover(epoch), signal);
        }
        if (signal?.aborted || epoch !== groundcoverEpoch) throw destinationSuperseded();
        await trees.prepareAt(focus, prepare, signal);
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
