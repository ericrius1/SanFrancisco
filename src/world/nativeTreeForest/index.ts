// NativeTreeForest — one renderer for every authored and open-world tree.
//
// The compiler flattens each tree LOD into one branch mesh and one foliage mesh.
// This runtime instances those whole-tree prototypes per chunk, shares immutable
// vertex/index buffers across every chunk, batches close trees by design+LOD,
// and uses a stable low-cost proxy for shadows. All distance grades share this
// whole-tree batching path and its compact instance storage.

import * as THREE from "three/webgpu";
import { createFrameBudgetCheckpoint, yieldToFrame } from "../../core/cooperativeWork";
import {
  createTreeShadowProxy,
  type TreeShadowInstance,
  type TreeShadowProfile,
  type TreeShadowProxy
} from "../shadows/treeShadowProxy";
import {
  loadNativeTreeMaterialSet,
  releaseNativeTreeMaterialSet,
  type NativeTreeMaterialAssets
} from "../vegetation/nativeTreeAssets";
import {
  createNativeTreeMaterials,
  type NativeTreeMaterials
} from "../vegetation/nativeTreeMaterials";
import {
  createTreeInstanceGeometry,
  detachTreeInstanceGeometry,
  disposeTreeInstanceGeometry,
  type TreeInstanceGeometry
} from "./nativeGeometry";
import {
  NATIVE_TREE_LOD_UPDATE_MOVE,
  nativeTreeChunkLodBias,
  nativeTreeUsesHorizonLod,
  resolveNativeTreeLodTransition,
  type NativeTreeLodTransitionDirection,
  type NativeTreeSilhouetteLod
} from "./lodTransition";
import { growTemplate, type GrownTemplate, type NativeTreeDesignSpec } from "./templates";

export type { NativeTreeDesignSpec } from "./templates";

export type NativeTreeSlot = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** Index into the designs array passed to createNativeTreeForest. */
  design: number;
  /** False keeps this individual in landscape LOD at every distance. */
  nearDetail?: boolean;
};

export type NativeTreeForestOptions = {
  name: string;
  /** World-space chunk edge in metres (default 176). */
  chunkSize?: number;
  /** Chunks beyond this distance are hidden entirely (default 520). */
  visibleDistance?: number;
  /** Landscape → horizon LOD switch (default 58% of visibleDistance). */
  horizonDistance?: number;
  /** Distance at which a tree can enter the two close batched LODs. */
  nearRadius?: number;
  /** Hysteretic distance at which a close tree returns to its chunk batch. */
  nearExitRadius?: number;
  /** Maximum close trees across this whole forest. */
  nearMax?: number;
};

export type NativeTreePrepareUnit = (unit: THREE.Object3D) => Promise<void>;

export type NativeTreeForest = {
  group: THREE.Group;
  /** Resolves after prototypes, material packs and the initial local residency exist. */
  ready: Promise<void>;
  /** Call every frame with the player/view position. */
  update(focus: { x: number; z: number }): void;
  /**
   * Latest-wins destination prime for boot/teleport transactions. It records
   * `focus`, materializes only that local residency ring, and waits until all
   * visible chunks are prepared. It does not depend on the normal update loop.
   */
  prepareAt(
    focus: { x: number; z: number },
    prepare?: NativeTreePrepareUnit,
    signal?: AbortSignal
  ): Promise<void>;
  /**
   * Prepares the currently relevant render objects before revealing them. The
   * callback is retained so chunks first encountered after a teleport use the
   * same prepare-before-reveal path. Work is serialized and yielded per unit.
   */
  prepareVisible(prepare: NativeTreePrepareUnit): Promise<void>;
  dispose(): void;
  stats: {
    designs: number;
    instances: number;
    chunks: number;
    draws: number;
    farTriangles: number;
    horizonTriangles: number;
    prototypeBytes: number;
    instanceBytes: number;
    nearActive(): number;
  };
};

const REBIN_MS = 250;
const REBIN_MOVE_SQ = 4;
const RESIDENCY_MOVE = 24;
const HORIZON_HYSTERESIS = 14;
const VISIBILITY_HYSTERESIS = 18;
const PREFETCH_CHUNK_RINGS = 0.75;
const RETIRE_CHUNK_RINGS = 2;
const ZERO_SCALE = 1e-6;
const LOD_CANOPY = 0;
const LOD_GROVE = 1;
const LOD_LANDSCAPE = 2;
const LOD_HORIZON = 3;

const superseded = () => new DOMException("Native tree destination superseded", "AbortError");

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(superseded());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(superseded());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
type Slot = NativeTreeSlot & {
  index: number;
  chunk: string;
  key: string;
  variation: number;
  dryness: number;
  lodRank: number;
};

type BatchVariant = {
  lod: number;
  branch: TreeInstanceGeometry;
  foliage: TreeInstanceGeometry;
};

type TreeBatch = {
  name: string;
  capacity: number;
  branch: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;
  foliage: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;
  root: THREE.StorageInstancedBufferAttribute;
  yaw: THREE.StorageInstancedBufferAttribute;
  variants: readonly BatchVariant[];
  materials: NativeTreeMaterials;
  branchByLod: Map<number, THREE.Material>;
  foliageByLod: Map<number, THREE.Material>;
  ownedMaterials: THREE.Material[];
  ownsMaterials: boolean;
  currentLod: number;
};

type ChunkDesign = {
  slots: Slot[];
  batch: TreeBatch;
  transitionBatch: TreeBatch;
};

type Chunk = {
  key: string;
  group: THREE.Group;
  cx: number;
  cz: number;
  horizontalRadius: number;
  lod: NativeTreeSilhouetteLod;
  lodBias: number;
  lodDirection: NativeTreeLodTransitionDirection;
  horizonFraction: number;
  hasCullState: boolean;
  wantedVisible: boolean;
  preparedLods: Set<2 | 3>;
  prepareEpoch: number;
  preparing: Promise<void> | null;
  retireRequested: boolean;
  byDesign: Map<number, ChunkDesign>;
  shadowProxy: TreeShadowProxy | null;
};

type ChunkDescriptor = {
  key: string;
  slots: Slot[];
  sphere: THREE.Sphere;
  cx: number;
  cz: number;
  horizontalRadius: number;
  lodBias: number;
  designs: number[];
  chunk: Chunk | null;
};

type NearPool = {
  canopy: TreeBatch;
  grove: TreeBatch;
};

type NearPreparation = {
  batch: TreeBatch;
  entries: ActiveNear[];
  /** True only after the near meshes are visible and their far fallbacks are hidden. */
  farHidden: boolean;
  wantedVisible: boolean;
  prepared: boolean;
  prepareEpoch: number;
  preparing: Promise<void> | null;
};

type ActiveNear = {
  slot: Slot;
  chunk: Chunk;
  lod: 0 | 1;
};

function mixHash(value: number): number {
  let x = value | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 0x1_0000_0000;
}

function slotRandom(slot: NativeTreeSlot, seed: number, salt: number): number {
  const x = Math.round(slot.x * 8);
  const z = Math.round(slot.z * 8);
  return mixHash(Math.imul(x, 73856093) ^ Math.imul(z, 19349663) ^ Math.imul(seed, 83492791) ^ salt);
}

function updateRange(attribute: THREE.BufferAttribute, offset: number, count: number): void {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(offset, count);
  attribute.needsUpdate = true;
}

function writeBatchSlot(
  batch: TreeBatch,
  slot: Slot,
  index: number,
  hidden = false,
  writeStaticData = true
): void {
  const scale = hidden ? ZERO_SCALE : slot.scale;
  if (!writeStaticData) {
    batch.root.setW(index, scale);
    return;
  }
  batch.root.setXYZW(index, slot.x, slot.y, slot.z, scale);
  batch.yaw.setXYZW(
    index,
    Math.sin(slot.yaw),
    Math.cos(slot.yaw),
    slot.variation,
    slot.dryness
  );
}

function finishBatchWrite(batch: TreeBatch, count: number, staticData: boolean): void {
  for (const variant of batch.variants) {
    variant.branch.geometry.instanceCount = count;
    variant.foliage.geometry.instanceCount = count;
  }
  if (staticData) {
    updateRange(batch.root, 0, Math.max(1, count) * 4);
    updateRange(batch.yaw, 0, Math.max(1, count) * 4);
  }
}

function setBatchEntries(batch: TreeBatch, slots: readonly Slot[]): void {
  for (let index = 0; index < slots.length; index++) writeBatchSlot(batch, slots[index], index);
  finishBatchWrite(batch, slots.length, true);
}

function setBatchVisible(batch: TreeBatch, visible: boolean): void {
  batch.branch.visible = visible;
  batch.foliage.visible = visible;
}

function setPrimaryBatchEntries(
  batch: TreeBatch,
  allSlots: readonly Slot[],
  visibleSlots: readonly Slot[]
): void {
  for (const slot of allSlots) slot.index = -1;
  for (let index = 0; index < visibleSlots.length; index++) visibleSlots[index].index = index;
  setBatchEntries(batch, visibleSlots);
  setBatchVisible(batch, visibleSlots.length > 0);
}

function setTransitionBatchEntries(batch: TreeBatch, slots: readonly Slot[]): void {
  setBatchEntries(batch, slots);
  setBatchVisible(batch, slots.length > 0);
}

function setBatchLod(batch: TreeBatch, lod: number): void {
  if (batch.currentLod === lod) return;
  const variant = batch.variants.find((candidate) => candidate.lod === lod);
  if (!variant) throw new Error(`${batch.name} has no LOD ${lod}`);
  batch.branch.geometry = variant.branch.geometry;
  batch.foliage.geometry = variant.foliage.geometry;
  batch.branch.material = batch.branchByLod.get(lod) ?? batch.materials.branch[lod];
  batch.foliage.material = batch.foliageByLod.get(lod) ?? batch.materials.foliage[lod];
  batch.currentLod = lod;
}

function settleChunkLod(chunk: Chunk, lod: NativeTreeSilhouetteLod): void {
  for (const entry of chunk.byDesign.values()) {
    setBatchLod(entry.batch, lod);
    setPrimaryBatchEntries(entry.batch, entry.slots, entry.slots);
    setBatchLod(
      entry.transitionBatch,
      lod === LOD_LANDSCAPE ? LOD_HORIZON : LOD_LANDSCAPE
    );
    setTransitionBatchEntries(entry.transitionBatch, []);
  }
  chunk.lod = lod;
  chunk.lodDirection = 0;
  chunk.horizonFraction = lod === LOD_HORIZON ? 1 : 0;
}

function applyChunkLodTransition(
  chunk: Chunk,
  horizonFraction: number,
  direction: NativeTreeLodTransitionDirection
): number {
  let targetInstances = 0;
  for (const entry of chunk.byDesign.values()) {
    const primarySlots: Slot[] = [];
    const transitionSlots: Slot[] = [];
    for (const slot of entry.slots) {
      const usesHorizon = nativeTreeUsesHorizonLod(slot.lodRank, horizonFraction);
      const staysPrimary = chunk.lod === LOD_LANDSCAPE ? !usesHorizon : usesHorizon;
      (staysPrimary ? primarySlots : transitionSlots).push(slot);
    }
    const targetLod = chunk.lod === LOD_LANDSCAPE ? LOD_HORIZON : LOD_LANDSCAPE;
    setBatchLod(entry.batch, chunk.lod);
    setBatchLod(entry.transitionBatch, targetLod);
    setPrimaryBatchEntries(entry.batch, entry.slots, primarySlots);
    setTransitionBatchEntries(entry.transitionBatch, transitionSlots);
    targetInstances += transitionSlots.length;
  }
  chunk.lodDirection = direction;
  chunk.horizonFraction = horizonFraction;
  return targetInstances;
}

function setBatchMaterials(batch: TreeBatch, materials: NativeTreeMaterials): void {
  const priorOwned = batch.ownedMaterials;
  const branchByLod = new Map<number, THREE.Material>();
  const foliageByLod = new Map<number, THREE.Material>();
  const ownedMaterials: THREE.Material[] = [];
  for (const variant of batch.variants) {
    const lod = variant.lod;
    const branch = batch.ownsMaterials ? materials.branch[lod].clone() : materials.branch[lod];
    const foliage = batch.ownsMaterials ? materials.foliage[lod].clone() : materials.foliage[lod];
    branchByLod.set(lod, branch);
    foliageByLod.set(lod, foliage);
    if (batch.ownsMaterials) ownedMaterials.push(branch, foliage);
  }
  batch.materials = materials;
  batch.branchByLod = branchByLod;
  batch.foliageByLod = foliageByLod;
  batch.ownedMaterials = ownedMaterials;
  batch.branch.material = branchByLod.get(batch.currentLod) ?? materials.branch[batch.currentLod];
  batch.foliage.material = foliageByLod.get(batch.currentLod) ?? materials.foliage[batch.currentLod];
  for (const material of priorOwned) material.dispose();
}

function createBatch(
  template: GrownTemplate,
  materials: NativeTreeMaterials,
  lods: readonly number[],
  capacity: number,
  name: string,
  sphere: THREE.Sphere | null,
  parent: THREE.Group,
  ownMaterials = false,
  dynamicInstances = false
): TreeBatch {
  if (capacity < 1) throw new Error(`${name} needs a positive capacity`);
  const variants: BatchVariant[] = [];
  const instanceUsage = sphere === null || dynamicInstances
    ? THREE.DynamicDrawUsage
    : THREE.StaticDrawUsage;
  let sharedAttributes: Pick<TreeInstanceGeometry, "root" | "yaw"> | undefined;
  for (const lod of lods) {
    const source = template.geometry.lods[lod];
    if (!source) throw new Error(`${template.design.species} is missing native LOD ${lod}`);
    const branch = createTreeInstanceGeometry(source.branch, capacity, sharedAttributes, instanceUsage);
    sharedAttributes = { root: branch.root, yaw: branch.yaw };
    const foliage = createTreeInstanceGeometry(source.foliage, capacity, sharedAttributes, instanceUsage);
    variants.push({ lod, branch, foliage });
  }

  const first = variants[0];
  const branchByLod = new Map<number, THREE.Material>();
  const foliageByLod = new Map<number, THREE.Material>();
  const ownedMaterials: THREE.Material[] = [];
  for (const variant of variants) {
    const lod = variant.lod;
    const branchMaterial = ownMaterials ? materials.branch[lod].clone() : materials.branch[lod];
    const foliageMaterial = ownMaterials ? materials.foliage[lod].clone() : materials.foliage[lod];
    if (ownMaterials) {
      branchMaterial.name = `${materials.branch[lod].name}:${name}`;
      foliageMaterial.name = `${materials.foliage[lod].name}:${name}`;
      ownedMaterials.push(branchMaterial, foliageMaterial);
    }
    branchByLod.set(lod, branchMaterial);
    foliageByLod.set(lod, foliageMaterial);
  }
  const branch = new THREE.Mesh(
    first.branch.geometry,
    branchByLod.get(first.lod)!
  );
  const foliage = new THREE.Mesh(
    first.foliage.geometry,
    foliageByLod.get(first.lod)!
  );
  branch.name = `${name}_branch`;
  foliage.name = `${name}_foliage`;
  branch.castShadow = false;
  foliage.castShadow = false;
  branch.receiveShadow = true;
  foliage.receiveShadow = false;
  branch.frustumCulled = sphere !== null;
  foliage.frustumCulled = sphere !== null;
  for (const variant of variants) {
    variant.branch.geometry.boundingSphere = sphere?.clone() ?? null;
    variant.foliage.geometry.boundingSphere = sphere?.clone() ?? null;
  }
  if (sphere === null) {
    // At most nearMax trees live here and all are around the camera. Avoid a
    // per-rebin aggregate bound rebuild for this deliberately tiny batch.
    branch.frustumCulled = false;
    foliage.frustumCulled = false;
  }
  parent.add(branch, foliage);
  return {
    name,
    capacity,
    branch,
    foliage,
    root: first.branch.root,
    yaw: first.branch.yaw,
    variants,
    materials,
    branchByLod,
    foliageByLod,
    ownedMaterials,
    ownsMaterials: ownMaterials,
    currentLod: first.lod
  };
}

function disposeBatch(batch: TreeBatch): void {
  batch.branch.removeFromParent();
  batch.foliage.removeFromParent();
  for (const material of batch.ownedMaterials) material.dispose();
  batch.ownedMaterials.length = 0;
  // Detach every borrowed prototype buffer before any wrapper emits dispose.
  // Three's WebGPU geometry listener follows the render object's current LOD,
  // which may differ from the wrapper dispatching the event after an LOD swap.
  for (const variant of batch.variants) {
    detachTreeInstanceGeometry(variant.branch);
    detachTreeInstanceGeometry(variant.foliage);
  }
  for (const variant of batch.variants) {
    disposeTreeInstanceGeometry(variant.branch);
    disposeTreeInstanceGeometry(variant.foliage);
  }
}

function nativeShadowProfile(template: GrownTemplate): TreeShadowProfile {
  const profile = template.geometry.shadow;
  return {
    baseY: template.geometry.bounds.min[1],
    height: Math.max(1, profile.height),
    crownDiameter: Math.max(0.75, profile.canopyRadii[0] * 2, profile.canopyRadii[2] * 2)
  };
}

function chunkSphere(slots: readonly Slot[], templates: readonly (GrownTemplate | null)[]): THREE.Sphere {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const slot of slots) {
    const bounds = templates[slot.design]?.geometry.bounds;
    const radius = bounds
      ? Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0]), Math.abs(bounds.min[2]), Math.abs(bounds.max[2])) * slot.scale
      : 6 * slot.scale;
    minX = Math.min(minX, slot.x - radius);
    maxX = Math.max(maxX, slot.x + radius);
    minZ = Math.min(minZ, slot.z - radius);
    maxZ = Math.max(maxZ, slot.z + radius);
    minY = Math.min(minY, slot.y + (bounds?.min[1] ?? 0) * slot.scale);
    maxY = Math.max(maxY, slot.y + (bounds?.max[1] ?? 16) * slot.scale);
  }
  const center = new THREE.Vector3(
    (minX + maxX) * 0.5,
    (minY + maxY) * 0.5,
    (minZ + maxZ) * 0.5
  );
  return new THREE.Sphere(
    center,
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5
  );
}

function chunkHorizontalRadius(
  slots: readonly Slot[],
  templates: readonly (GrownTemplate | null)[],
  centerX: number,
  centerZ: number
): number {
  let radius = 0;
  for (const slot of slots) {
    const bounds = templates[slot.design]?.geometry.bounds;
    const treeRadius = bounds
      ? Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0]), Math.abs(bounds.min[2]), Math.abs(bounds.max[2])) * slot.scale
      : 6 * slot.scale;
    radius = Math.max(radius, Math.hypot(slot.x - centerX, slot.z - centerZ) + treeRadius);
  }
  return radius;
}

export function createNativeTreeForest(
  designs: readonly NativeTreeDesignSpec[],
  sourceSlots: readonly NativeTreeSlot[],
  options: NativeTreeForestOptions
): NativeTreeForest {
  const chunkSize = options.chunkSize ?? 176;
  const visibleDistance = options.visibleDistance ?? 520;
  const horizonDistance = Math.min(
    visibleDistance - 24,
    options.horizonDistance ?? visibleDistance * 0.58
  );
  const nearRadius = options.nearRadius ?? 58;
  const nearExit = Math.max(nearRadius, options.nearExitRadius ?? 66);
  const nearMax = Math.max(0, Math.floor(options.nearMax ?? 24));
  const canopyRadius = nearRadius * 0.52;
  const prefetchDistance = visibleDistance + chunkSize * PREFETCH_CHUNK_RINGS;
  const retireDistance = visibleDistance + chunkSize * RETIRE_CHUNK_RINGS;
  // The distance ring is the primary cache bound. This generous hard ceiling
  // protects pathological authored density without evicting a normal complete
  // visibility ring (including a chunk diagonal of conservative slack).
  const maxResidentChunks = Math.max(
    48,
    Math.ceil(
      Math.PI * Math.pow((retireDistance + chunkSize * Math.SQRT2) / chunkSize, 2) * 1.35
    )
  );

  const group = new THREE.Group();
  group.name = options.name;
  let disposed = false;

  const stats = {
    designs: 0,
    instances: 0,
    chunks: 0,
    draws: 0,
    farTriangles: 0,
    horizonTriangles: 0,
    prototypeBytes: 0,
    instanceBytes: 0,
    nearActive: () => active.size
  };

  const chunkSlots = new Map<string, Slot[]>();
  for (const source of sourceSlots) {
    const design = designs[source.design];
    if (!design || source.scale <= 0 || !Number.isFinite(source.scale)) continue;
    const chunk = `${Math.floor(source.x / chunkSize)},${Math.floor(source.z / chunkSize)}`;
    const slot: Slot = {
      ...source,
      y: source.y - design.sink * source.scale,
      index: 0,
      chunk,
      key: "",
      variation: slotRandom(source, design.seed, 0x2c1b3c6d),
      dryness: Math.pow(slotRandom(source, design.seed, 0x6a09e667), 3) * 0.32,
      lodRank: slotRandom(source, design.seed, 0x510e527f)
    };
    const bucket = chunkSlots.get(chunk);
    if (bucket) bucket.push(slot);
    else chunkSlots.set(chunk, [slot]);
  }

  const templates: (GrownTemplate | null)[] = designs.map(() => null);
  const assets: (NativeTreeMaterialAssets | null)[] = designs.map(() => null);
  const materials: (NativeTreeMaterials | null)[] = designs.map(() => null);
  const nearAssets: (NativeTreeMaterialAssets | null)[] = designs.map(() => null);
  const nearMaterials: (NativeTreeMaterials | null)[] = designs.map(() => null);
  const nearLoads: (Promise<void> | null)[] = designs.map(() => null);
  const nearLoadFailures = new Set<number>();
  const wantedNearDesigns = new Set<number>();
  const chunks: Chunk[] = [];
  const chunkDescriptors: ChunkDescriptor[] = [];
  const descriptorsByKey = new Map<string, ChunkDescriptor>();
  const usedDesigns = new Set<number>();
  const allNearSlots: { slot: Slot; chunk: Chunk }[] = [];
  const nearPools = new Map<number, NearPool>();
  const nearPreparations = new Map<TreeBatch, NearPreparation>();
  const active = new Map<string, ActiveNear>();
  const lastFocus = { x: 1e9, z: 1e9 };
  const lastResidencyFocus = { x: 1e9, z: 1e9 };
  const lastRebinFocus = new THREE.Vector2(1e9, 1e9);
  const requestedDesigns = new Set<number>();
  for (const slots of chunkSlots.values()) for (const slot of slots) requestedDesigns.add(slot.design);
  let lastRebin = 0;
  let hasCullFocus = false;
  let prepareUnit: NativeTreePrepareUnit | null = null;
  let preparationTail: Promise<void> = Promise.resolve();
  let descriptorsInitialized = false;
  let readySettled = false;
  let residencyEpoch = 0;
  let residencyTail: Promise<void> = Promise.resolve();
  let horizonPrefetchPump: Promise<void> | null = null;

  function ensureNearMaterials(design: number): Promise<void> {
    if (disposed || nearMaterials[design] || nearLoadFailures.has(design)) {
      return Promise.resolve();
    }
    if (nearLoads[design]) return nearLoads[design];
    const template = templates[design];
    if (!template) return Promise.resolve();
    const task = (async () => {
      const detailAssets = await loadNativeTreeMaterialSet(template.archetype.species, {
        leafColorVariant: template.archetype.style.leafColorVariant,
        detail: "full"
      });
      if (disposed) {
        releaseNativeTreeMaterialSet(detailAssets);
        return;
      }
      let detailMaterials: NativeTreeMaterials;
      try {
        detailMaterials = createNativeTreeMaterials(
          template.archetype.style,
          detailAssets,
          template.geometry.shadow.canopyCenter,
          template.geometry.shadow.canopyRadii
        );
      } catch (error) {
        releaseNativeTreeMaterialSet(detailAssets);
        throw error;
      }
      nearAssets[design] = detailAssets;
      nearMaterials[design] = detailMaterials;
      const pool = nearPools.get(design);
      if (pool) {
        setBatchMaterials(pool.canopy, detailMaterials);
        setBatchMaterials(pool.grove, detailMaterials);
        invalidateNearPreparation(pool.canopy);
        invalidateNearPreparation(pool.grove);
      }
      // Candidates deliberately remain in their landscape fallback until the
      // full material pack exists. Re-run the selection now so the detached
      // near batches can prepare and take ownership atomically.
      if (Number.isFinite(lastFocus.x) && Math.abs(lastFocus.x) < 1e8) {
        rebin(lastFocus.x, lastFocus.z, true);
      }
    })().catch((error) => {
      // Do not spin forever retrying a missing or invalid optional detail pack.
      // The landscape representation remains visible and the failure is exposed
      // through the debug stats for diagnostics.
      nearLoadFailures.add(design);
      console.warn(`[native trees:${options.name}] close material detail failed for ${template.archetype.species}`, error);
    }).finally(() => {
      nearLoads[design] = null;
    });
    nearLoads[design] = task;
    return task;
  }

  function setFarHidden(chunk: Chunk, slot: Slot, hidden: boolean): void {
    const batch = chunk.byDesign.get(slot.design)?.batch;
    // A slot assigned to the transition batch cannot be close enough for a
    // near-detail takeover. A stale near rebin can briefly observe that state
    // after a teleport, so simply leave its already-visible far copy alone.
    if (!batch || slot.index < 0) return;
    writeBatchSlot(batch, slot, slot.index, hidden, false);
    batch.root.clearUpdateRanges();
    batch.root.addUpdateRange(slot.index * 4 + 3, 1);
    batch.root.needsUpdate = true;
  }

  function invalidateNearPreparation(batch: TreeBatch): void {
    const state = nearPreparations.get(batch);
    if (!state) return;
    // Material replacement invalidates the render object. Put every landscape
    // fallback back first, then hide the stale near batch; there is never a frame
    // where both representations of an active tree are absent.
    if (state.farHidden) {
      for (const entry of state.entries) setFarHidden(entry.chunk, entry.slot, false);
      state.farHidden = false;
    }
    state.prepared = false;
    state.prepareEpoch++;
    state.batch.branch.visible = false;
    state.batch.foliage.visible = false;
    if (prepareUnit && state.wantedVisible) {
      void queueNearPreparation(state).catch((error) => {
        console.warn(`[native trees:${options.name}] close batch prepare failed`, error);
      });
    }
  }

  function setNearBatchEntries(batch: TreeBatch, entries: readonly ActiveNear[]): void {
    setBatchEntries(batch, entries.map((entry) => entry.slot));
    const state = nearPreparations.get(batch);
    const wantedVisible = entries.length > 0;
    if (!state) {
      batch.branch.visible = wantedVisible;
      batch.foliage.visible = wantedVisible;
      return;
    }
    const previousKeys = new Set(state.entries.map((entry) => entry.slot.key));
    const nextKeys = new Set(entries.map((entry) => entry.slot.key));
    if (state.farHidden) {
      for (const entry of state.entries) {
        if (!nextKeys.has(entry.slot.key)) setFarHidden(entry.chunk, entry.slot, false);
      }
    }
    state.entries = entries.slice();
    if (state.wantedVisible !== wantedVisible) {
      state.wantedVisible = wantedVisible;
      state.prepareEpoch++;
    }
    const reveal = wantedVisible && (!prepareUnit || state.prepared);
    batch.branch.visible = reveal;
    batch.foliage.visible = reveal;
    if (reveal) {
      // Reveal near first, then retire only the corresponding landscape slots.
      // Existing entries are already hidden; only newly selected entries need a
      // storage-buffer write during a normal rebin.
      for (const entry of state.entries) {
        if (!state.farHidden || !previousKeys.has(entry.slot.key)) {
          setFarHidden(entry.chunk, entry.slot, true);
        }
      }
      state.farHidden = true;
    } else if (state.farHidden) {
      for (const entry of state.entries) setFarHidden(entry.chunk, entry.slot, false);
      state.farHidden = false;
    }
    if (prepareUnit && wantedVisible && !state.prepared) {
      void queueNearPreparation(state).catch((error) => {
        console.warn(`[native trees:${options.name}] close batch prepare failed`, error);
      });
    }
  }

  function rebin(x: number, z: number, force = false): void {
    if (nearMax === 0 || allNearSlots.length === 0) {
      wantedNearDesigns.clear();
      return;
    }
    const now = performance.now();
    const moved = lastRebinFocus.distanceToSquared(new THREE.Vector2(x, z));
    if (!force && (now - lastRebin < REBIN_MS || moved < REBIN_MOVE_SQ)) return;
    lastRebin = now;
    lastRebinFocus.set(x, z);

    const enterSq = nearRadius * nearRadius;
    const exitSq = nearExit * nearExit;
    const candidates: { slot: Slot; chunk: Chunk; d2: number; lod: 0 | 1 }[] = [];
    for (const entry of allNearSlots) {
      const dx = entry.slot.x - x;
      const dz = entry.slot.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= (active.has(entry.slot.key) ? exitSq : enterSq)) continue;
      const previous = active.get(entry.slot.key);
      const canopyExit = canopyRadius * 1.12;
      const useCanopy = previous?.lod === LOD_CANOPY
        ? d2 < canopyExit * canopyExit
        : d2 < canopyRadius * canopyRadius;
      candidates.push({ ...entry, d2, lod: useCanopy ? LOD_CANOPY : LOD_GROVE });
    }
    candidates.sort((a, b) => a.d2 - b.d2);
    candidates.length = Math.min(candidates.length, nearMax);
    wantedNearDesigns.clear();
    for (const candidate of candidates) wantedNearDesigns.add(candidate.slot.design);

    const next = new Map<string, ActiveNear>();
    for (const candidate of candidates) {
      void ensureNearMaterials(candidate.slot.design);
      // Loading or compiling close detail must never remove the already-good
      // landscape tree. It enters the near pool only once its full material pack
      // exists; setNearBatchEntries keeps that fallback until GPU preparation.
      if (!nearMaterials[candidate.slot.design]) continue;
      next.set(candidate.slot.key, {
        slot: candidate.slot,
        chunk: candidate.chunk,
        lod: candidate.lod
      });
    }
    for (const [key, entry] of active) {
      if (!next.has(key)) setFarHidden(entry.chunk, entry.slot, false);
    }

    const canopyByDesign: ActiveNear[][] = designs.map(() => []);
    const groveByDesign: ActiveNear[][] = designs.map(() => []);
    for (const entry of next.values()) {
      (entry.lod === LOD_CANOPY ? canopyByDesign : groveByDesign)[entry.slot.design].push(entry);
    }
    for (const [design, pool] of nearPools) {
      setNearBatchEntries(pool.canopy, canopyByDesign[design]);
      setNearBatchEntries(pool.grove, groveByDesign[design]);
    }
    active.clear();
    for (const [key, entry] of next) active.set(key, entry);
  }

  function descriptorEdgeDistance(
    descriptor: Pick<ChunkDescriptor, "cx" | "cz" | "horizontalRadius">,
    x: number,
    z: number
  ): number {
    return Math.max(0, Math.hypot(descriptor.cx - x, descriptor.cz - z) - descriptor.horizontalRadius);
  }

  function materializeDescriptor(descriptor: ChunkDescriptor): Chunk | null {
    if (disposed) return null;
    if (descriptor.chunk) {
      descriptor.chunk.retireRequested = false;
      return descriptor.chunk;
    }
    const chunk: Chunk = {
      key: descriptor.key,
      group: new THREE.Group(),
      cx: descriptor.cx,
      cz: descriptor.cz,
      horizontalRadius: descriptor.horizontalRadius,
      lod: LOD_LANDSCAPE,
      lodBias: descriptor.lodBias,
      lodDirection: 0,
      horizonFraction: 0,
      hasCullState: false,
      wantedVisible: false,
      preparedLods: new Set(),
      prepareEpoch: 0,
      preparing: null,
      retireRequested: false,
      byDesign: new Map(),
      shadowProxy: null
    };
    chunk.group.name = `${options.name}_${descriptor.key}`;
    chunk.group.visible = false;

    const byDesign = new Map<number, Slot[]>();
    for (const slot of descriptor.slots) {
      const bucket = byDesign.get(slot.design);
      if (bucket) bucket.push(slot);
      else byDesign.set(slot.design, [slot]);
    }

    const shadowInstances: TreeShadowInstance[] = [];
    for (const [design, designSlots] of byDesign) {
      const template = templates[design];
      const materialPack = materials[design];
      if (!template || !materialPack) continue;
      designSlots.forEach((slot, index) => {
        slot.index = index;
        slot.key = `${slot.chunk}:${slot.design}:${index}`;
      });
      // Chunk meshes borrow the forest-owned material pack. Object/geometry
      // disposal still retires each WebGPU RenderObject, while keeping one
      // material identity per design/LOD lets pipeline compilation be reused
      // instead of paying it again for every streamed residency.
      const batch = createBatch(
        template,
        materialPack,
        [LOD_LANDSCAPE, LOD_HORIZON],
        designSlots.length,
        `${options.name}_${designs[design].species}_${descriptor.key}`,
        descriptor.sphere,
        chunk.group,
        false,
        true
      );
      const transitionBatch = createBatch(
        template,
        materialPack,
        [LOD_LANDSCAPE, LOD_HORIZON],
        designSlots.length,
        `${options.name}_${designs[design].species}_${descriptor.key}_lod_transition`,
        descriptor.sphere,
        chunk.group,
        false,
        true
      );
      setPrimaryBatchEntries(batch, designSlots, designSlots);
      setBatchLod(transitionBatch, LOD_HORIZON);
      setTransitionBatchEntries(transitionBatch, []);
      chunk.byDesign.set(design, { slots: designSlots, batch, transitionBatch });

      const shadowProfile = nativeShadowProfile(template);
      for (const slot of designSlots) {
        shadowInstances.push({
          x: slot.x,
          y: slot.y,
          z: slot.z,
          yaw: slot.yaw,
          scale: slot.scale,
          profile: shadowProfile
        });
        if (
          nearMax > 0 &&
          template.design.nearDetail !== false &&
          slot.nearDetail !== false
        ) {
          allNearSlots.push({ slot, chunk });
        }
      }
    }
    if (shadowInstances.length > 0) {
      chunk.shadowProxy = createTreeShadowProxy({
        name: `${options.name}_shadow_${descriptor.key}`,
        instances: shadowInstances,
        // Beauty residency is already chunk-bounded. Matching that ownership
        // unit collapses the former ~3.3 shadow microcells/chunk into one stable
        // WebGPU render object without changing any proxy triangles.
        cellSize: chunkSize
      });
      chunk.group.add(chunk.shadowProxy.group);
    }
    if (chunk.byDesign.size === 0) {
      chunk.shadowProxy?.dispose();
      chunk.group.clear();
      return null;
    }
    descriptor.chunk = chunk;
    chunks.push(chunk);
    group.add(chunk.group);
    return chunk;
  }

  function disposeResidentChunk(chunk: Chunk, force = false): boolean {
    if (chunk.preparing && !force) {
      chunk.retireRequested = true;
      return false;
    }
    chunk.retireRequested = false;
    chunk.wantedVisible = false;
    chunk.group.visible = false;
    for (const [key, entry] of active) {
      if (entry.chunk === chunk) active.delete(key);
    }
    for (let index = allNearSlots.length - 1; index >= 0; index--) {
      if (allNearSlots[index].chunk === chunk) allNearSlots.splice(index, 1);
    }
    for (const entry of chunk.byDesign.values()) {
      disposeBatch(entry.batch);
      disposeBatch(entry.transitionBatch);
    }
    chunk.shadowProxy?.dispose();
    chunk.group.removeFromParent();
    chunk.group.clear();
    const residentIndex = chunks.indexOf(chunk);
    if (residentIndex >= 0) chunks.splice(residentIndex, 1);
    const descriptor = descriptorsByKey.get(chunk.key);
    if (descriptor?.chunk === chunk) descriptor.chunk = null;
    return true;
  }

  function requestChunkRetirement(chunk: Chunk): boolean {
    if (!chunk.retireRequested) {
      chunk.retireRequested = true;
      chunk.prepareEpoch++;
    }
    chunk.wantedVisible = false;
    chunk.group.visible = false;
    return disposeResidentChunk(chunk);
  }

  function retireDistantChunks(x: number, z: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    let retired = false;
    for (const chunk of [...chunks]) {
      if (descriptorEdgeDistance(chunk, x, z) > retireDistance) {
        retired = requestChunkRetirement(chunk) || retired;
      }
    }
    if (chunks.length <= maxResidentChunks) return retired;
    const overflow = chunks
      .filter((chunk) => descriptorEdgeDistance(chunk, x, z) >= visibleDistance + VISIBILITY_HYSTERESIS)
      .sort((a, b) => descriptorEdgeDistance(b, x, z) - descriptorEdgeDistance(a, x, z));
    for (const chunk of overflow) {
      if (chunks.length <= maxResidentChunks) break;
      retired = requestChunkRetirement(chunk) || retired;
    }
    return retired;
  }

  async function materializeRelevantChunks(epoch: number, x: number, z: number): Promise<void> {
    if (!descriptorsInitialized || !Number.isFinite(x) || !Number.isFinite(z)) return;
    const relevant = chunkDescriptors
      .filter((descriptor) => descriptorEdgeDistance(descriptor, x, z) < prefetchDistance)
      .sort((a, b) => descriptorEdgeDistance(a, x, z) - descriptorEdgeDistance(b, x, z));
    for (const descriptor of relevant) {
      if (disposed || epoch !== residencyEpoch) return;
      if (descriptor.chunk) {
        descriptor.chunk.retireRequested = false;
        continue;
      }
      materializeDescriptor(descriptor);
      // Start destination preparation as each atomic chunk becomes resident.
      // This overlaps asynchronous renderer warm-up with later sliced assembly
      // instead of withholding the first useful chunk until the whole ring exists.
      applyDistanceCull(x, z, true);
      // One chunk is the atomic ownership unit. Always return to rendering
      // between chunks instead of allowing a nominal budget to aggregate them.
      await yieldToFrame();
    }
    if (disposed || epoch !== residencyEpoch) return;
    applyDistanceCull(x, z, true);
    retireDistantChunks(x, z);
    rebin(x, z, true);
    requestHorizonPrefetchPreparation();
  }

  function queueResidencyRefresh(epoch: number, x: number, z: number): Promise<void> {
    const queued = residencyTail.then(() => materializeRelevantChunks(epoch, x, z));
    residencyTail = queued.catch(() => {});
    return queued;
  }

  function applyDistanceCull(x: number, z: number, force = false): void {
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 1e8 || Math.abs(z) > 1e8) {
      for (const chunk of chunks) {
        if (chunk.wantedVisible) chunk.prepareEpoch++;
        chunk.hasCullState = false;
        chunk.wantedVisible = false;
        chunk.group.visible = false;
      }
      hasCullFocus = false;
      lastFocus.x = 1e9;
      lastFocus.z = 1e9;
      lastResidencyFocus.x = 1e9;
      lastResidencyFocus.z = 1e9;
      return;
    }
    if (!force && Math.hypot(x - lastFocus.x, z - lastFocus.z) < NATIVE_TREE_LOD_UPDATE_MOVE) return;
    const firstCull = !hasCullFocus;
    // update() is intentionally useful before ready: it records the destination
    // that asynchronous assembly should cull around. Do not consume the first-
    // cull semantics until chunks actually exist, though.
    if (chunks.length > 0) hasCullFocus = true;
    lastFocus.x = x;
    lastFocus.z = z;
    for (const chunk of chunks) {
      const firstChunkCull = firstCull || !chunk.hasCullState;
      chunk.hasCullState = true;
      const centerDistance = Math.hypot(chunk.cx - x, chunk.cz - z);
      const edgeDistance = Math.max(0, centerDistance - chunk.horizontalRadius);
      const visibilityLimit = firstChunkCull
        ? visibleDistance
        : visibleDistance + (chunk.wantedVisible ? VISIBILITY_HYSTERESIS : -VISIBILITY_HYSTERESIS);
      const wantedVisible = edgeDistance < visibilityLimit;
      if (chunk.wantedVisible !== wantedVisible) {
        chunk.wantedVisible = wantedVisible;
        chunk.prepareEpoch++;
      }
      if (!wantedVisible) {
        chunk.group.visible = false;
        continue;
      }
      // A latest-wins destination can return to a chunk while preparation is
      // still in flight. Being wanted again cancels its deferred retirement.
      chunk.retireRequested = false;
      const previousLod = chunk.lod;
      let transitionTarget: NativeTreeSilhouetteLod | null = null;
      if (firstChunkCull) {
        settleChunkLod(
          chunk,
          edgeDistance >= horizonDistance + chunk.lodBias ? LOD_HORIZON : LOD_LANDSCAPE
        );
      } else {
        const transition = resolveNativeTreeLodTransition(
          edgeDistance,
          horizonDistance + chunk.lodBias,
          chunk.lod,
          undefined,
          HORIZON_HYSTERESIS
        );
        if (transition.settledLod !== chunk.lod) {
          settleChunkLod(chunk, transition.settledLod);
        } else if (
          transition.horizonFraction !== chunk.horizonFraction ||
          transition.direction !== chunk.lodDirection
        ) {
          const targetInstances = applyChunkLodTransition(
            chunk,
            transition.horizonFraction,
            transition.direction
          );
          if (transition.transitioning && targetInstances > 0) {
            transitionTarget = chunk.lod === LOD_LANDSCAPE ? LOD_HORIZON : LOD_LANDSCAPE;
          }
        }
      }
      if (previousLod !== chunk.lod) chunk.prepareEpoch++;
      if (prepareUnit && !chunk.preparedLods.has(chunk.lod)) {
        chunk.group.visible = false;
        void queueChunkPreparation(chunk).catch((error) => {
          console.warn(`[native trees:${options.name}] streamed chunk prepare failed`, error);
        });
      } else {
        chunk.group.visible = true;
        // Once the ranked target population is submitted, the target material
        // and shared vertex layout have crossed the real renderer path. This
        // prevents the final consolidation from hiding a chunk that has already
        // displayed that grade throughout the bounded transition band.
        if (transitionTarget !== null) chunk.preparedLods.add(transitionTarget);
      }
    }
  }

  function preparationStillCurrent(chunk: Chunk, epoch: number, lod: 2 | 3): boolean {
    return (
      !disposed &&
      !chunk.retireRequested &&
      chunk.wantedVisible &&
      chunk.lod === lod &&
      chunk.prepareEpoch === epoch
    );
  }

  async function prepareObject(unit: THREE.Object3D): Promise<void> {
    if (!prepareUnit || disposed) return;
    // compileAsync ignores invisible roots. Detach the unit while temporarily
    // exposing it to the compiler so the live scene can never draw a half-warm
    // chunk during an await or a teleport that supersedes this preparation.
    const parent = unit.parent;
    const wasVisible = unit.visible;
    if (parent) parent.remove(unit);
    unit.visible = true;
    try {
      await prepareUnit(unit);
    } finally {
      unit.visible = wasVisible;
      if (parent && !disposed) parent.add(unit);
    }
    await yieldToFrame();
  }

  function nearPreparationStillCurrent(state: NearPreparation, epoch: number): boolean {
    return !disposed && state.wantedVisible && state.prepareEpoch === epoch;
  }

  async function prepareNearBatch(state: NearPreparation, epoch: number): Promise<void> {
    if (!nearPreparationStillCurrent(state, epoch)) return;
    await prepareObject(state.batch.branch);
    if (!nearPreparationStillCurrent(state, epoch)) return;
    await prepareObject(state.batch.foliage);
    if (!nearPreparationStillCurrent(state, epoch)) return;
    state.prepared = true;
    // The fallback remains live throughout both async compiles. Publish the near
    // pair first, then hide its exact far slots in the same main-thread turn.
    state.batch.branch.visible = true;
    state.batch.foliage.visible = true;
    for (const entry of state.entries) setFarHidden(entry.chunk, entry.slot, true);
    state.farHidden = true;
  }

  function queueNearPreparation(state: NearPreparation): Promise<void> {
    if (!prepareUnit || state.prepared || !state.wantedVisible) return Promise.resolve();
    if (state.preparing) return state.preparing;
    const epoch = state.prepareEpoch;
    const queued = preparationTail.then(() => prepareNearBatch(state, epoch));
    let tracked: Promise<void>;
    tracked = queued.finally(() => {
      if (state.preparing === tracked) state.preparing = null;
      if (
        !disposed &&
        state.wantedVisible &&
        !state.prepared &&
        state.prepareEpoch !== epoch
      ) {
        void queueNearPreparation(state).catch((error) => {
          console.warn(`[native trees:${options.name}] close batch prepare failed`, error);
        });
      }
    });
    state.preparing = tracked;
    preparationTail = tracked.catch(() => {});
    return tracked;
  }

  async function prepareChunk(chunk: Chunk, epoch: number, lod: 2 | 3): Promise<void> {
    if (!preparationStillCurrent(chunk, epoch, lod) || !prepareUnit) return;
    // Only the LOD needed at the current destination is prepared. Other designs,
    // distances and close-detail variants remain truly lazy until approached.
    await prepareObject(chunk.group);
    if (!preparationStillCurrent(chunk, epoch, lod)) return;
    chunk.preparedLods.add(lod);
    chunk.group.visible = true;
  }

  function queueChunkPreparation(chunk: Chunk): Promise<void> {
    if (!prepareUnit || chunk.preparedLods.has(chunk.lod) || !chunk.wantedVisible) return Promise.resolve();
    if (chunk.preparing) return chunk.preparing;
    const epoch = chunk.prepareEpoch;
    const lod = chunk.lod;
    const queued = preparationTail.then(() => prepareChunk(chunk, epoch, lod));
    let tracked: Promise<void>;
    tracked = queued.finally(() => {
      if (chunk.preparing === tracked) chunk.preparing = null;
      if (chunk.retireRequested && !disposed) {
        const retired = disposeResidentChunk(chunk);
        if (retired && Number.isFinite(lastFocus.x) && Math.abs(lastFocus.x) < 1e8) {
          rebin(lastFocus.x, lastFocus.z, true);
        }
        return;
      }
      if (
        !disposed &&
        chunk.wantedVisible &&
        !chunk.preparedLods.has(chunk.lod) &&
        chunk.prepareEpoch !== epoch
      ) {
        void queueChunkPreparation(chunk).catch((error) => {
          console.warn(`[native trees:${options.name}] streamed chunk prepare failed`, error);
        });
      }
      requestHorizonPrefetchPreparation();
    });
    chunk.preparing = tracked;
    // A failed unit must not poison every later chunk in the serialized queue.
    preparationTail = tracked.catch(() => {});
    return tracked;
  }

  function hiddenHorizonStillRelevant(chunk: Chunk, epoch: number): boolean {
    return (
      !disposed &&
      Boolean(prepareUnit) &&
      !chunk.retireRequested &&
      !chunk.wantedVisible &&
      !chunk.preparedLods.has(LOD_HORIZON) &&
      chunk.prepareEpoch === epoch &&
      Number.isFinite(lastFocus.x) &&
      Math.abs(lastFocus.x) < 1e8 &&
      descriptorEdgeDistance(chunk, lastFocus.x, lastFocus.z) < prefetchDistance
    );
  }

  function nextHiddenHorizonChunk(): Chunk | null {
    if (!prepareUnit || disposed || !Number.isFinite(lastFocus.x) || Math.abs(lastFocus.x) >= 1e8) {
      return null;
    }
    let best: Chunk | null = null;
    let bestDistance = Infinity;
    for (const chunk of chunks) {
      if (
        chunk.preparing ||
        chunk.retireRequested ||
        chunk.wantedVisible ||
        chunk.preparedLods.has(LOD_HORIZON)
      ) continue;
      const distance = descriptorEdgeDistance(chunk, lastFocus.x, lastFocus.z);
      if (distance >= prefetchDistance || distance >= bestDistance) continue;
      best = chunk;
      bestDistance = distance;
    }
    return best;
  }

  async function prepareHiddenHorizonChunk(chunk: Chunk, epoch: number): Promise<void> {
    if (!hiddenHorizonStillRelevant(chunk, epoch) || !prepareUnit) return;
    // Chunk batches reuse the same render objects for both silhouette grades.
    // Compile the horizon variant while detached, then restore the live/previous
    // grade. No near-detail material or KTX2 request is reachable from this path.
    const restoreLods = new Map<TreeBatch, number>();
    for (const entry of chunk.byDesign.values()) {
      restoreLods.set(entry.batch, entry.batch.currentLod);
      setBatchLod(entry.batch, LOD_HORIZON);
    }
    try {
      await prepareObject(chunk.group);
      // A focus move alone does not invalidate compiled render state. A cull/LOD
      // transition increments prepareEpoch, preventing us from blessing a render
      // object that changed underneath compileAsync.
      if (
        !disposed &&
        !chunk.retireRequested &&
        !chunk.wantedVisible &&
        chunk.prepareEpoch === epoch
      ) {
        chunk.preparedLods.add(LOD_HORIZON);
      }
    } finally {
      if (!disposed && !chunk.retireRequested && chunks.includes(chunk)) {
        for (const entry of chunk.byDesign.values()) {
          setBatchLod(
            entry.batch,
            chunk.wantedVisible ? chunk.lod : (restoreLods.get(entry.batch) ?? chunk.lod)
          );
        }
        chunk.group.visible = chunk.wantedVisible && (
          !prepareUnit || chunk.preparedLods.has(chunk.lod)
        );
      }
    }
  }

  function queueHiddenHorizonPreparation(chunk: Chunk): Promise<void> {
    if (!prepareUnit || chunk.preparedLods.has(LOD_HORIZON) || chunk.wantedVisible) {
      return Promise.resolve();
    }
    if (chunk.preparing) return chunk.preparing;
    const epoch = chunk.prepareEpoch;
    const queued = preparationTail.then(() => prepareHiddenHorizonChunk(chunk, epoch));
    let tracked: Promise<void>;
    tracked = queued.finally(() => {
      if (chunk.preparing === tracked) chunk.preparing = null;
      if (chunk.retireRequested && !disposed) {
        const retired = disposeResidentChunk(chunk);
        if (retired && Number.isFinite(lastFocus.x) && Math.abs(lastFocus.x) < 1e8) {
          rebin(lastFocus.x, lastFocus.z, true);
        }
        return;
      }
      // A chunk can cross the visible boundary while its one allowed prefetch
      // unit is waiting for the global quiet gate. Current visuals take priority
      // immediately after that unit settles.
      if (!disposed && chunk.wantedVisible && !chunk.preparedLods.has(chunk.lod)) {
        void queueChunkPreparation(chunk).catch((error) => {
          console.warn(`[native trees:${options.name}] streamed chunk prepare failed`, error);
        });
      }
    });
    chunk.preparing = tracked;
    preparationTail = tracked.catch(() => {});
    return tracked;
  }

  function requestHorizonPrefetchPreparation(): void {
    if (!prepareUnit || disposed || horizonPrefetchPump) return;
    let tracked: Promise<void>;
    tracked = (async () => {
      // Queue exactly one invisible unit at a time. Visible/near jobs that arrive
      // while it runs append ahead of the next iteration on preparationTail, so a
      // long prefetch train can never starve current scenery.
      while (!disposed && prepareUnit) {
        const chunk = nextHiddenHorizonChunk();
        if (!chunk) return;
        await queueHiddenHorizonPreparation(chunk);
      }
    })().catch((error) => {
      console.warn(`[native trees:${options.name}] horizon prefetch failed`, error);
    }).finally(() => {
      if (horizonPrefetchPump === tracked) horizonPrefetchPump = null;
    });
    horizonPrefetchPump = tracked;
  }

  function assertResidencyCurrent(epoch: number, signal?: AbortSignal): void {
    if (signal?.aborted || epoch !== residencyEpoch) throw superseded();
    if (disposed) throw new Error(`Native tree forest ${options.name} was disposed`);
  }

  function cancelResidencyPrime(epoch: number): void {
    if (epoch !== residencyEpoch) return;
    residencyEpoch++;
    // Invalidate every reveal queued for the abandoned focus. The next normal
    // update or latest-wins prepareAt call establishes a fresh destination.
    applyDistanceCull(Number.NaN, Number.NaN, true);
    rebin(1e9, 1e9, true);
  }

  async function prepareWantedUnits(expectedResidencyEpoch?: number): Promise<void> {
    if (!prepareUnit || disposed) return;
    // An in-flight unit can belong to the focus that was just superseded. Loop
    // until the *current* wanted set is prepared rather than merely awaiting the
    // stale promise returned by its first queue lookup.
    while (!disposed) {
      if (expectedResidencyEpoch !== undefined && expectedResidencyEpoch !== residencyEpoch) {
        throw superseded();
      }
      const relevant = chunks
        .filter((chunk) => chunk.wantedVisible && !chunk.preparedLods.has(chunk.lod))
        .sort((a, b) =>
          Math.hypot(a.cx - lastFocus.x, a.cz - lastFocus.z) -
          Math.hypot(b.cx - lastFocus.x, b.cz - lastFocus.z)
        );
      const close = Array.from(nearPreparations.values()).filter(
        (state) => state.wantedVisible && !state.prepared
      );
      // `rebin` can discover close candidates before their optional full-detail
      // texture pack has loaded. Treat those loads as preparation work, then
      // loop once more so the newly populated near batches are compiled before
      // the destination is declared visually ready.
      const detailLoads = Array.from(wantedNearDesigns)
        .filter((design) => !nearMaterials[design] && !nearLoadFailures.has(design))
        .map((design) => ensureNearMaterials(design));
      if (relevant.length === 0 && close.length === 0 && detailLoads.length === 0) return;
      for (const chunk of relevant) chunk.group.visible = false;
      for (const state of close) {
        state.batch.branch.visible = false;
        state.batch.foliage.visible = false;
      }
      await Promise.all([
        ...detailLoads,
        ...relevant.map((chunk) => queueChunkPreparation(chunk)),
        ...close.map((state) => queueNearPreparation(state))
      ]);
    }
  }

  function batchSubmission(batch: TreeBatch, rootVisible: boolean) {
    const count = batch.branch.geometry.instanceCount;
    let draws = 0;
    let triangles = 0;
    for (const mesh of [batch.branch, batch.foliage]) {
      if (!rootVisible || !mesh.visible || count <= 0) continue;
      draws++;
      const primitiveCount = mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count;
      triangles += primitiveCount / 3 * count;
    }
    return {
      lod: batch.currentLod,
      instances: rootVisible && count > 0 ? count : 0,
      draws,
      triangles
    };
  }

  function collectLodTransitionStats() {
    const rows = chunks.map((chunk) => {
      let primaryInstances = 0;
      let transitionInstances = 0;
      let landscapeInstances = 0;
      let horizonInstances = 0;
      let draws = 0;
      let transitionDraws = 0;
      let triangles = 0;
      for (const entry of chunk.byDesign.values()) {
        const primary = batchSubmission(entry.batch, chunk.group.visible);
        const transition = batchSubmission(entry.transitionBatch, chunk.group.visible);
        primaryInstances += primary.instances;
        transitionInstances += transition.instances;
        landscapeInstances += primary.lod === LOD_LANDSCAPE ? primary.instances : 0;
        landscapeInstances += transition.lod === LOD_LANDSCAPE ? transition.instances : 0;
        horizonInstances += primary.lod === LOD_HORIZON ? primary.instances : 0;
        horizonInstances += transition.lod === LOD_HORIZON ? transition.instances : 0;
        draws += primary.draws + transition.draws;
        transitionDraws += transition.draws;
        triangles += primary.triangles + transition.triangles;
      }
      return {
        key: chunk.key,
        cx: chunk.cx,
        cz: chunk.cz,
        horizontalRadius: chunk.horizontalRadius,
        edgeDistance: Number.isFinite(lastFocus.x)
          ? descriptorEdgeDistance(chunk, lastFocus.x, lastFocus.z)
          : null,
        lodCenter: horizonDistance + chunk.lodBias,
        lodBias: chunk.lodBias,
        settledLod: chunk.lod,
        direction: chunk.lodDirection,
        horizonFraction: chunk.horizonFraction,
        transitioning: chunk.lodDirection !== 0,
        wantedVisible: chunk.wantedVisible,
        visible: chunk.group.visible,
        preparedLods: Array.from(chunk.preparedLods).sort(),
        preparing: chunk.preparing !== null,
        retireRequested: chunk.retireRequested,
        slots: Array.from(chunk.byDesign.values()).reduce((sum, entry) => sum + entry.slots.length, 0),
        primaryInstances,
        transitionInstances,
        landscapeInstances,
        horizonInstances,
        draws,
        transitionDraws,
        triangles
      };
    });
    return {
      updateMove: NATIVE_TREE_LOD_UPDATE_MOVE,
      residencyMove: RESIDENCY_MOVE,
      residentChunks: rows.length,
      transitioningChunks: rows.filter((row) => row.transitioning).length,
      visibleDraws: rows.reduce((sum, row) => sum + row.draws, 0),
      transitionDraws: rows.reduce((sum, row) => sum + row.transitionDraws, 0),
      visibleTriangles: rows.reduce((sum, row) => sum + row.triangles, 0),
      chunks: rows
    };
  }

  function collectNearLodStats() {
    const entries = Array.from(active.values()).map((entry) => ({
      key: entry.slot.key,
      x: entry.slot.x,
      z: entry.slot.z,
      distance: Math.hypot(
        entry.slot.x - lastRebinFocus.x,
        entry.slot.z - lastRebinFocus.y
      ),
      lod: entry.lod,
      lodName: entry.lod === LOD_CANOPY ? "canopy" : "grove",
      design: entry.slot.design
    })).sort((a, b) => a.distance - b.distance);
    const closestCandidate = allNearSlots.map((entry) => ({
      key: entry.slot.key,
      x: entry.slot.x,
      z: entry.slot.z,
      distance: Math.hypot(
        entry.slot.x - lastRebinFocus.x,
        entry.slot.z - lastRebinFocus.y
      ),
      design: entry.slot.design,
      detailMaterialReady: nearMaterials[entry.slot.design] !== null
    })).sort((a, b) => a.distance - b.distance)[0] ?? null;
    return {
      focus: { x: lastRebinFocus.x, z: lastRebinFocus.y },
      nearRadius,
      nearExit,
      canopyRadius,
      nearMax,
      wantedDesigns: Array.from(wantedNearDesigns),
      loadingDesigns: nearLoads.flatMap((load, design) => load ? [design] : []),
      failedDesigns: Array.from(nearLoadFailures),
      active: entries.length,
      canopy: entries.filter((entry) => entry.lod === LOD_CANOPY).length,
      grove: entries.filter((entry) => entry.lod === LOD_GROVE).length,
      closest: entries[0] ?? null,
      closestCandidate,
      entries: entries.slice(0, 12)
    };
  }

  const ready = (async () => {
    const loaded = await Promise.all(designs.map(async (design, index) => {
      if (!requestedDesigns.has(index)) return null;
      let template: GrownTemplate | null = null;
      try {
        template = await growTemplate(design);
        const materialAssets = await loadNativeTreeMaterialSet(template.archetype.species, {
          leafColorVariant: template.archetype.style.leafColorVariant,
          detail: "silhouette"
        });
        const materialPack = createNativeTreeMaterials(
          template.archetype.style,
          materialAssets,
          template.geometry.shadow.canopyCenter,
          template.geometry.shadow.canopyRadii
        );
        return { index, template, materialAssets, materialPack };
      } catch (error) {
        template?.release();
        console.error(`[native trees:${options.name}] ${design.species} failed:`, error);
        return null;
      }
    }));
    for (const result of loaded) {
      if (!result) continue;
      templates[result.index] = result.template;
      assets[result.index] = result.materialAssets;
      materials[result.index] = result.materialPack;
    }
    if (disposed) {
      for (let index = 0; index < designs.length; index++) {
        materials[index]?.dispose();
        const materialAssets = assets[index];
        if (materialAssets) releaseNativeTreeMaterialSet(materialAssets);
        nearMaterials[index]?.dispose();
        const detailAssets = nearAssets[index];
        if (detailAssets) releaseNativeTreeMaterialSet(detailAssets);
        templates[index]?.release();
      }
      return;
    }

    let instanceBytes = 0;
    const assemblyCheckpoint = createFrameBudgetCheckpoint(6);
    for (const [key, slots] of chunkSlots) {
      const sphere = chunkSphere(slots, templates);
      const validDesigns = new Set<number>();
      for (const slot of slots) {
        const template = templates[slot.design];
        if (!template || !materials[slot.design]) continue;
        validDesigns.add(slot.design);
        usedDesigns.add(slot.design);
        stats.instances++;
        stats.farTriangles += template.geometry.lods[LOD_LANDSCAPE].triangles;
        stats.horizonTriangles += template.geometry.lods[LOD_HORIZON].triangles;
        // Primary + empty-at-rest transition storage. The latter lets ranked
        // trees move between opaque silhouette grades without allocating GPU
        // buffers or render objects on the transition frame.
        instanceBytes += (4 + 4) * 4 * 2;
      }
      if (validDesigns.size === 0) continue;
      const [chunkX, chunkZ] = key.split(",").map(Number);
      const descriptor: ChunkDescriptor = {
        key,
        slots,
        sphere,
        cx: sphere.center.x,
        cz: sphere.center.z,
        horizontalRadius: chunkHorizontalRadius(slots, templates, sphere.center.x, sphere.center.z),
        lodBias: nativeTreeChunkLodBias(chunkX, chunkZ),
        designs: Array.from(validDesigns),
        chunk: null
      };
      chunkDescriptors.push(descriptor);
      descriptorsByKey.set(key, descriptor);
      await assemblyCheckpoint();
      if (disposed) return;
    }
    descriptorsInitialized = true;

    if (nearMax > 0) {
      for (const design of usedDesigns) {
        const template = templates[design];
        const materialPack = materials[design];
        if (!template || !materialPack || template.design.nearDetail === false) continue;
        const canopy = createBatch(
          template,
          materialPack,
          [LOD_CANOPY],
          nearMax,
          `${options.name}_${designs[design].species}_canopy`,
          null,
          group
        );
        const grove = createBatch(
          template,
          materialPack,
          [LOD_GROVE],
          nearMax,
          `${options.name}_${designs[design].species}_grove`,
          null,
          group
        );
        finishBatchWrite(canopy, 0, false);
        finishBatchWrite(grove, 0, false);
        canopy.branch.visible = false;
        canopy.foliage.visible = false;
        grove.branch.visible = false;
        grove.foliage.visible = false;
        nearPools.set(design, { canopy, grove });
        nearPreparations.set(canopy, {
          batch: canopy,
          entries: [],
          farHidden: false,
          wantedVisible: false,
          prepared: false,
          prepareEpoch: 0,
          preparing: null
        });
        nearPreparations.set(grove, {
          batch: grove,
          entries: [],
          farHidden: false,
          wantedVisible: false,
          prepared: false,
          prepareEpoch: 0,
          preparing: null
        });
        instanceBytes += nearMax * (4 + 4) * 4 * 2;
        await assemblyCheckpoint();
        if (disposed) return;
      }
    }

    stats.designs = usedDesigns.size;
    stats.chunks = chunkDescriptors.length;
    stats.draws = chunkDescriptors.reduce((sum, descriptor) => sum + descriptor.designs.length * 2, 0)
      + nearPools.size * 4;
    stats.prototypeBytes = Array.from(usedDesigns).reduce(
      (sum, design) => sum + (
        templates[design]?.geometry.stats.lods.reduce((lodSum, lod) => lodSum + lod.byteLength, 0) ?? 0
      ),
      0
    );
    stats.instanceBytes = instanceBytes;
    group.userData.nativeTreeStats = stats;
    group.userData.nativeTreeResidentChunks = () => chunks.length;
    group.userData.nativeTreePreparedHorizonChunks = () =>
      chunks.filter((chunk) => chunk.preparedLods.has(LOD_HORIZON)).length;
    group.userData.nativeTreeHiddenPreparedHorizonChunks = () =>
      chunks.filter((chunk) => !chunk.wantedVisible && chunk.preparedLods.has(LOD_HORIZON)).length;
    group.userData.nativeTreeShadowMeshes = () =>
      chunks.reduce((sum, chunk) => sum + (chunk.shadowProxy?.meshes.length ?? 0), 0);
    group.userData.nativeTreeLodTransitionStats = collectLodTransitionStats;
    group.userData.nativeTreeNearLodStats = collectNearLodStats;
    group.userData.nativeTreeLodProbeAt = (x: number, z: number) => {
      applyDistanceCull(x, z, true);
      return collectLodTransitionStats();
    };
    group.userData.disposeTreeShadowProxies = () => {
      for (const chunk of chunks) chunk.shadowProxy?.dispose();
    };

    if (Number.isFinite(lastFocus.x) && Math.abs(lastFocus.x) < 1e8) {
      // The destination may change while initial chunks stream. Restart from the
      // latest focus; stale loops stop at the next per-chunk frame boundary.
      while (!disposed) {
        const epoch = residencyEpoch;
        const x = lastFocus.x;
        const z = lastFocus.z;
        await materializeRelevantChunks(epoch, x, z);
        if (epoch === residencyEpoch) break;
      }
    }
    readySettled = true;
    console.log(
      `[native trees] ${options.name}: ${stats.designs} designs, ${stats.instances} trees, ` +
      `${stats.chunks} authored / ${chunks.length} resident chunks, ` +
      `${(stats.prototypeBytes / 1048576).toFixed(1)} MiB shared prototypes, ` +
      `${(stats.instanceBytes / 1048576).toFixed(1)} MiB instance data`
    );
  })();

  return {
    group,
    ready,
    update(focus) {
      if (disposed) return;
      const finiteFocus =
        Number.isFinite(focus.x) &&
        Number.isFinite(focus.z) &&
        Math.abs(focus.x) < 1e8 &&
        Math.abs(focus.z) < 1e8;
      const refreshResidency = finiteFocus && Math.hypot(
        focus.x - lastResidencyFocus.x,
        focus.z - lastResidencyFocus.z
      ) >= RESIDENCY_MOVE;
      applyDistanceCull(focus.x, focus.z);
      if (refreshResidency) {
        lastResidencyFocus.x = focus.x;
        lastResidencyFocus.z = focus.z;
        const epoch = ++residencyEpoch;
        const retired = descriptorsInitialized ? retireDistantChunks(focus.x, focus.z) : false;
        if (retired) rebin(focus.x, focus.z, true);
        if (readySettled) {
          void queueResidencyRefresh(epoch, focus.x, focus.z).catch((error) => {
            console.warn(`[native trees:${options.name}] residency refresh failed`, error);
          });
        }
        requestHorizonPrefetchPreparation();
      }
      rebin(focus.x, focus.z);
    },
    async prepareAt(focus, prepare, signal) {
      if (
        !Number.isFinite(focus.x) ||
        !Number.isFinite(focus.z) ||
        Math.abs(focus.x) > 1e8 ||
        Math.abs(focus.z) > 1e8
      ) {
        throw new RangeError("Native tree destination focus must be finite");
      }
      if (signal?.aborted) throw superseded();
      if (prepare) prepareUnit = prepare;

      lastResidencyFocus.x = focus.x;
      lastResidencyFocus.z = focus.z;

      const epoch = ++residencyEpoch;
      const onAbort = () => cancelResidencyPrime(epoch);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // Record the destination immediately, including while prototype loading
        // is still in progress. `ready` consumes the latest focus when its light
        // descriptor pass reaches local materialization.
        applyDistanceCull(focus.x, focus.z, true);
        if (descriptorsInitialized) {
          const retired = retireDistantChunks(focus.x, focus.z);
          if (retired) rebin(focus.x, focus.z, true);
        }

        if (readySettled) {
          await abortable(queueResidencyRefresh(epoch, focus.x, focus.z), signal);
        } else {
          await abortable(ready, signal);
        }
        assertResidencyCurrent(epoch, signal);

        // A descriptor can finish on the same frame as a newer cull. Reassert
        // the exact focus before waiting for all required current LOD pipelines.
        applyDistanceCull(focus.x, focus.z, true);
        rebin(focus.x, focus.z, true);
        await abortable(prepareWantedUnits(epoch), signal);
        assertResidencyCurrent(epoch, signal);
        requestHorizonPrefetchPreparation();
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
    async prepareVisible(prepare) {
      await ready;
      await residencyTail;
      if (disposed) return;
      prepareUnit = prepare;
      await prepareWantedUnits();
      requestHorizonPrefetchPreparation();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of active.values()) setFarHidden(entry.chunk, entry.slot, false);
      active.clear();
      for (const pool of nearPools.values()) {
        disposeBatch(pool.canopy);
        disposeBatch(pool.grove);
      }
      nearPools.clear();
      nearPreparations.clear();
      for (const chunk of [...chunks]) disposeResidentChunk(chunk, true);
      chunkDescriptors.length = 0;
      descriptorsByKey.clear();
      for (let index = 0; index < materials.length; index++) {
        materials[index]?.dispose();
        const materialAssets = assets[index];
        if (materialAssets) releaseNativeTreeMaterialSet(materialAssets);
        nearMaterials[index]?.dispose();
        const detailAssets = nearAssets[index];
        if (detailAssets) releaseNativeTreeMaterialSet(detailAssets);
        templates[index]?.release();
      }
      group.removeFromParent();
      group.clear();
    },
    stats
  };
}
