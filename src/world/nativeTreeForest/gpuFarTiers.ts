// GPU far-tier renderer for NativeTreeForest — the landscape + horizon silhouette
// grades, moved off per-chunk instanced draws onto the shared GPU indirect core
// (../../render/gpuIndirect). One arena per design streams chunk root/yaw from the
// host as residency pages in; one per-design cull compute frustum-tests every live
// slot, picks landscape vs horizon by a hash-dithered distance band, and appends
// survivors into that tier's indirect draw. Far draws collapse from
// (resident chunks × designs × 2 grades × 2 meshes) to a FIXED
// (designs × 2 tiers × 2 meshes), and the per-chunk rebin sort / LOD-transition
// fade batches / per-residency attribute rebuilds all disappear.
//
// The near close pool (canopy/grove) and CPU chunk residency stay in index.ts;
// this module owns only the far arenas, indirect meshes, cull passes and the
// per-frame dispatch registry. WebGPU-only. Foliage never casts/receives shadows:
// this module sets no shadow state (the indirect meshes default castShadow=false).

import * as THREE from "three/webgpu";
import { If, float, floor, int, uint, uniform, vec3 } from "three/tsl";
import {
  buildCullPass,
  createCullCamera,
  createIndirectDrawSet,
  createInstanceArena,
  createRangeAllocator,
  createVisibleBuffer,
  type CullCamera,
  type IndirectDrawEntry,
  type IndirectDrawRecord,
  type IndirectDrawSet,
  type InstanceArena,
  type RangeAllocator,
  type VisibleBuffer
} from "../../render/gpuIndirect";
import {
  createNativeTreeIndirectFarMaterials,
  type NativeTreeIndirectFarMaterials
} from "../vegetation/nativeTreeMaterials";
import type { NativeTreeMaterialAssets } from "../vegetation/nativeTreeAssets";
import type { NativeTreeStyle } from "../vegetation/nativeTreeRecipes";
import { NATIVE_TREE_LOD_TRANSITION_WIDTH } from "./lodTransition";

// Re-exported so index.ts keeps one import site; the registry itself lives in a
// dependency-light module so frameBody can drive it without bundling this graph.
export { registerForestFarCull, renderNativeTreeForestFarCulls } from "./farCullRegistry";

type N = any;

const ROOT = "root";
const YAW = "yaw";
const FAR_ARENA_ATTRS = [
  { name: ROOT, format: "vec4" }, // local xyz + uniform scale (scale 0 = hidden/free)
  { name: YAW, format: "vec4" } //  sin, cos, variation(palette), dryness
] as const;

// Wind sway + grounding slack folded into the per-instance frustum proxy radius.
const CULL_RADIUS_SLACK = 2.2;
// Soft per-instance far cutoff band: instead of a hard visibleDistance ring, each
// tree extinguishes at a hash-dithered distance across this window.
const FAR_CUTOFF_DITHER = 28;
// Fragmentation headroom over a design's authored total so a first-fit range
// allocator can page churning chunks without wedging on non-contiguous holes.
const ARENA_HEADROOM = 1.3;
const ARENA_MIN_CAPACITY = 64;
// Audited footprint: the whole primary Wildlands forest is ≤15.6k authored trees
// → ~29.7k arena slots → ~1.4 MB device (48 B/slot: one 2×vec4 arena + four
// visible-index uints), and the per-frame full-capacity cull reads ~0.5 MB. That
// is why the cull dispatches `capacity` with no live-count plumbing: a
// high-water bound would buy nothing and the range allocator's `used` is NOT a
// safe bound (first-fit + coalescing leaves live ranges above it). This ceiling
// only exists so an order-of-magnitude denser forest surfaces as a warning
// instead of a silent ~13 MB arena.
const ARENA_CAPACITY_WARN = 262_144;

function ceilPow2(value: number): number {
  let capacity = ARENA_MIN_CAPACITY;
  while (capacity < value) capacity *= 2;
  return capacity;
}

/** Minimal per-instance input the forest hands the arena; `Slot` satisfies it. */
export type FarInstanceInput = Readonly<{
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  variation: number;
  dryness: number;
}>;

/** Opaque token identifying one chunk-design's contiguous arena range. */
export type FarChunkHandle = Readonly<{ design: number; base: number; count: number }>;

/** What one design contributes: its two far LOD geometries, style and canopy. */
export type NativeTreeFarDesign = Readonly<{
  /** Index into the forest's designs array — the routing key for admit/release. */
  design: number;
  landscapeBranch: THREE.BufferGeometry;
  landscapeFoliage: THREE.BufferGeometry;
  horizonBranch: THREE.BufferGeometry;
  horizonFoliage: THREE.BufferGeometry;
  style: NativeTreeStyle;
  assets: NativeTreeMaterialAssets;
  canopyCenter: readonly [number, number, number];
  canopyRadii: readonly [number, number, number];
  /** Local-space bounding sphere of the whole tree (scale 1) for the cull proxy. */
  boundsCenterY: number;
  boundsRadius: number;
  /** Authored instance count of this design across every chunk (arena sizing). */
  total: number;
}>;

export type NativeTreeFarTiersOptions = Readonly<{
  name: string;
  /** Landscape → horizon switch distance (dither band centred here). */
  horizonDistance: number;
  /** Beyond this (dithered) every instance extinguishes. */
  visibleDistance: number;
}>;

export type NativeTreeGpuFarTiers = Readonly<{
  /** Add to the forest group; hidden with it and by the master foliage toggle. */
  group: THREE.Group;
  /** Any live instance resident? Dispatch is skipped when false. */
  hasResident(): boolean;
  /** Page one chunk-design's slots into its arena. Null when the arena is full. */
  admitChunk(design: number, slots: readonly FarInstanceInput[]): FarChunkHandle | null;
  /** Reclaim a chunk-design's range (darkens the slots and frees them). */
  releaseChunk(handle: FarChunkHandle): void;
  /** Near-pool takeover / restore: dark or re-show one instance the same frame. */
  setInstanceHidden(handle: FarChunkHandle, localIndex: number, scale: number, hidden: boolean): void;
  /** drawReset + every design cull against the render camera and tethered focus. */
  dispatch(renderer: THREE.WebGPURenderer, camera: THREE.Camera, focusX: number, focusZ: number): void;
  /** Compile the (fixed) far pipelines once, before reveal. */
  prepare(prepareObject: (unit: THREE.Object3D) => Promise<void>): Promise<void>;
  /** Fixed far draw count = designs × 2 tiers × 2 meshes. */
  readonly farDraws: number;
  readonly designCount: number;
  dispose(): void;
}>;

type DesignTier = {
  design: number;
  arena: InstanceArena;
  allocator: RangeAllocator;
  visibles: VisibleBuffer[];
  materials: NativeTreeIndirectFarMaterials;
  rootHost: Float32Array;
  yawHost: Float32Array;
  capacity: number;
};

const uintHash = (gx: N, gz: N, salt: number): N => {
  const ux = uint(gx.add(int(1 << 20)));
  const uz = uint(gz.add(int(1 << 20)));
  const h = ux
    .mul(uint(374761393))
    .add(uz.mul(uint(668265263)))
    .add(uint(salt).mul(uint(2246822519)))
    .toVar();
  h.assign(h.bitXor(h.shiftRight(uint(15))).mul(uint(2246822519)));
  h.assign(h.bitXor(h.shiftRight(uint(13))).mul(uint(3266489917)));
  h.assign(h.bitXor(h.shiftRight(uint(16))));
  return h;
};

const hashUnit = (gx: N, gz: N, salt: number): N =>
  float(uintHash(gx, gz, salt)).mul(1 / 0x1_0000_0000);

export function createNativeTreeGpuFarTiers(
  designs: readonly NativeTreeFarDesign[],
  options: NativeTreeFarTiersOptions
): NativeTreeGpuFarTiers {
  const group = new THREE.Group();
  group.name = `${options.name}_far_tiers`;

  const cullCamera: CullCamera = createCullCamera();
  const focus = new THREE.Vector2(1e9, 1e9);
  const focusU = uniform(focus);

  // Pass 1: per-design arena + visible buffers + materials. Every design's four
  // records land in ONE shared indirect draw set (pass 2) so a single drawReset
  // zeroes the whole forest's far counts each frame.
  const tiers = new Map<number, DesignTier>();
  const entries: IndirectDrawEntry[] = [];
  for (const design of designs) {
    const capacity = ceilPow2(Math.ceil(Math.max(1, design.total) * ARENA_HEADROOM));
    if (capacity > ARENA_CAPACITY_WARN) {
      console.warn(
        `[native trees:${options.name}] far arena for design ${design.design} is ${capacity} slots ` +
        `(${((capacity * 48) / 1e6).toFixed(1)} MB) from ${design.total} authored trees — ` +
        `revisit the arena sizing`
      );
    }
    const arena = createInstanceArena(FAR_ARENA_ATTRS, capacity);
    const allocator = createRangeAllocator(capacity);
    // Each tier's branch + foliage keep independent visible buffers: the cull
    // appends the same survivor index to both, order-independent and correct.
    const visibles = [
      createVisibleBuffer(capacity), // 0 branch landscape
      createVisibleBuffer(capacity), // 1 foliage landscape
      createVisibleBuffer(capacity), // 2 branch horizon
      createVisibleBuffer(capacity) //  3 foliage horizon
    ];
    const materials = createNativeTreeIndirectFarMaterials(
      design.style,
      design.assets,
      { root: arena.read(ROOT), yaw: arena.read(YAW) },
      {
        branchLandscape: visibles[0].read,
        foliageLandscape: visibles[1].read,
        branchHorizon: visibles[2].read,
        foliageHorizon: visibles[3].read
      },
      design.canopyCenter,
      design.canopyRadii
    );
    tiers.set(design.design, {
      design: design.design,
      arena,
      allocator,
      visibles,
      materials,
      rootHost: arena.hostArray(ROOT),
      yawHost: arena.hostArray(YAW),
      capacity
    });
    entries.push(
      { geometry: design.landscapeBranch, material: materials.branch.landscape, capacity, visible: visibles[0], name: `${options.name}_${design.design}_branch_landscape` },
      { geometry: design.landscapeFoliage, material: materials.foliage.landscape, capacity, visible: visibles[1], name: `${options.name}_${design.design}_foliage_landscape` },
      { geometry: design.horizonBranch, material: materials.branch.horizon, capacity, visible: visibles[2], name: `${options.name}_${design.design}_branch_horizon` },
      { geometry: design.horizonFoliage, material: materials.foliage.horizon, capacity, visible: visibles[3], name: `${options.name}_${design.design}_foliage_horizon` }
    );
  }

  const drawSet: IndirectDrawSet = createIndirectDrawSet(entries, `${options.name}_far`);
  for (const record of drawSet.records) group.add(record.mesh);

  // Pass 2: per-design cull. Reads root/yaw once, rejects hidden/free slots
  // (scale 0), then inside the frustum branch picks a tier by a hash-dithered
  // distance band and appends to that tier's branch + foliage records.
  const designCulls: N[] = [];
  designs.forEach((design, designIndex) => {
    const tier = tiers.get(design.design);
    if (!tier) return;
    const base = designIndex * 4;
    const [lBranch, lFoliage, hBranch, hFoliage] = drawSet.records.slice(base, base + 4) as [
      IndirectDrawRecord,
      IndirectDrawRecord,
      IndirectDrawRecord,
      IndirectDrawRecord
    ];
    const rootRead = tier.arena.read(ROOT);
    const horizonDistance = options.horizonDistance;
    const cull = buildCullPass({
      name: `${options.name}_${design.design} far cull`,
      dispatch: tier.capacity,
      camera: cullCamera,
      instance: (idx: N) => {
        const root = (rootRead.element(idx) as N).toVar();
        const scale = root.w;
        const center = vec3(root.x, root.y.add(float(design.boundsCenterY).mul(scale)), root.z);
        const radius = float(design.boundsRadius).mul(scale).add(CULL_RADIUS_SLACK);
        // Quantised world XZ → a stable per-tree dither seed (arena-slot agnostic,
        // so a tree keeps its landscape/horizon threshold across residency churn).
        const gx = int(floor(root.x.mul(8)));
        const gz = int(floor(root.z.mul(8)));
        return {
          center,
          radius,
          // Free ranges and near-pool takeovers write scale 0; the material never
          // resolves an instance the cull rejects, so live slots always have w>0.
          accept: scale.greaterThan(float(0)),
          emit: () => {
            const dist = center.xz.sub(focusU as N).length().toVar();
            const horizonAt = float(horizonDistance).add(
              hashUnit(gx, gz, 0x9e37).sub(0.5).mul(NATIVE_TREE_LOD_TRANSITION_WIDTH)
            );
            const farAt = float(options.visibleDistance).add(
              hashUnit(gx, gz, 0x85eb).sub(0.5).mul(FAR_CUTOFF_DITHER)
            );
            If(dist.lessThan(farAt), () => {
              If(dist.lessThan(horizonAt), () => {
                lBranch.append(idx);
                lFoliage.append(idx);
              }).Else(() => {
                hBranch.append(idx);
                hFoliage.append(idx);
              });
            });
          }
        };
      }
    });
    designCulls.push(cull);
  });

  const cullPasses: N[] = [drawSet.drawReset, ...designCulls];

  let totalUsed = 0;
  // The cull is the only writer that zeroes the indirect instanceCounts, so a
  // forest whose last chunk unloads would freeze its draws on the final frame's
  // survivor set and keep fetching those instances forever. Park it instead: one
  // last drawReset, then hide the group. Matters most on a teleport, where the
  // frozen counts would be the ORIGIN's tree set drawn out of arena slots the
  // destination is already paging over.
  let parked = false;

  const admitChunk = (design: number, slots: readonly FarInstanceInput[]): FarChunkHandle | null => {
    const tier = tiers.get(design);
    if (!tier || slots.length === 0) return null;
    const base = tier.allocator.alloc(slots.length);
    if (base === null) {
      console.warn(
        `[native trees:${options.name}] far arena full for design ${design} ` +
        `(capacity ${tier.capacity}); chunk kept out of the far tier`
      );
      return null;
    }
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const a = (base + i) * 4;
      tier.rootHost[a] = slot.x;
      tier.rootHost[a + 1] = slot.y;
      tier.rootHost[a + 2] = slot.z;
      tier.rootHost[a + 3] = slot.scale;
      tier.yawHost[a] = Math.sin(slot.yaw);
      tier.yawHost[a + 1] = Math.cos(slot.yaw);
      tier.yawHost[a + 2] = slot.variation;
      tier.yawHost[a + 3] = slot.dryness;
    }
    tier.arena.uploadRange(ROOT, base, base + slots.length);
    tier.arena.uploadRange(YAW, base, base + slots.length);
    totalUsed += slots.length;
    return { design, base, count: slots.length };
  };

  const releaseChunk = (handle: FarChunkHandle): void => {
    const tier = tiers.get(handle.design);
    if (!tier) return;
    // Darken the range (scale 0) before freeing so no stale slot survives as a
    // ghost if the cull runs before a later admit overwrites it.
    for (let i = 0; i < handle.count; i++) tier.rootHost[(handle.base + i) * 4 + 3] = 0;
    tier.arena.uploadRange(ROOT, handle.base, handle.base + handle.count);
    tier.allocator.free(handle.base, handle.count);
    totalUsed = Math.max(0, totalUsed - handle.count);
  };

  const setInstanceHidden = (
    handle: FarChunkHandle,
    localIndex: number,
    scale: number,
    hidden: boolean
  ): void => {
    const tier = tiers.get(handle.design);
    if (!tier || localIndex < 0 || localIndex >= handle.count) return;
    const a = (handle.base + localIndex) * 4 + 3;
    tier.rootHost[a] = hidden ? 0 : scale;
    tier.arena.uploadRange(ROOT, handle.base + localIndex, handle.base + localIndex + 1);
  };

  let disposed = false;
  return Object.freeze({
    group,
    hasResident: () => totalUsed > 0,
    admitChunk,
    releaseChunk,
    setInstanceHidden,
    dispatch(renderer, camera, focusX, focusZ) {
      if (disposed) return;
      if (totalUsed === 0) {
        // One-shot reset, then park. The visibility flag is re-asserted every
        // frame rather than only on the transition: prepare() hands the group to
        // compileAsync, which detaches it and restores the visibility it captured
        // on entry — an admit landing inside that await would otherwise strand the
        // group hidden with live counts.
        if (!parked) {
          renderer.compute([drawSet.drawReset]);
          parked = true;
        }
        group.visible = false;
        return;
      }
      parked = false;
      group.visible = true;
      cullCamera.update(camera);
      focus.set(focusX, focusZ);
      renderer.compute(cullPasses);
    },
    async prepare(prepareObject) {
      if (disposed || drawSet.records.length === 0) return;
      await prepareObject(group);
    },
    farDraws: drawSet.records.length,
    designCount: tiers.size,
    dispose() {
      if (disposed) return;
      disposed = true;
      // drawSet.dispose() owns the shared drawReset; only the per-design culls
      // are disposed here to avoid a double free.
      for (const cull of designCulls) cull.dispose();
      drawSet.dispose();
      for (const tier of tiers.values()) {
        tier.materials.dispose();
        for (const visible of tier.visibles) visible.dispose();
        tier.arena.dispose();
      }
      tiers.clear();
      group.removeFromParent();
      group.clear();
    }
  });
}
