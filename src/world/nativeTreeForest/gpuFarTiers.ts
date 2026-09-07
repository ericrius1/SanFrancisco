// Shared GPU indirect trees: per-design arenas feed landscape and horizon
// branch/foliage meshes, plus a capture-shaped whole-tree impostor beyond 420m.
// CPU chunks own residency; compute picks exactly one representation per tree.
// Resident pages own five draws each; distant authored populations allocate nothing.
// All paths use the same compact root/yaw planes and visible-index indirection.
// WebGPU only. Foliage never casts or receives shadows.

import * as THREE from "three/webgpu";
import { tracer } from "../../core/hitchTracer";
import { If, float, floor, int, uint, uniform, vec3 } from "three/tsl";
import {
  buildCullPass,
  createCullCamera,
  createIndirectDrawSet,
  createInstanceArena,
  createVisibleBuffer,
  type CullCamera,
  type IndirectDrawEntry,
  type IndirectDrawRecord,
  type IndirectDrawSet,
  type InstanceArena,
  type VisibleBuffer
} from "../../render/gpuIndirect";
import {
  createNativeTreeIndirectFarMaterials,
  type NativeTreeIndirectFarMaterials
} from "../vegetation/nativeTreeMaterials";
import type { NativeTreeMaterialAssets } from "../vegetation/nativeTreeAssets";
import type { NativeTreeStyle } from "../vegetation/nativeTreeRecipes";
import { NATIVE_TREE_LOD_TRANSITION_WIDTH } from "./lodTransition";
import type { NativeTreeImpostor } from "./nativeGeometry";
import { createTreeImpostorMaterial } from "./impostorMaterial";
import { createDenseSlotAllocator, type DenseSlotAllocator, type DenseSlotToken } from "./denseSlots";

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
// Small forests retain small buffers; large forests allocate these fixed-size
// pages only for resident chunks. No buffer is sized to world coverage.
const PAGE_SLOTS = 4096;
const ARENA_MIN_CAPACITY = 64;
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

/** Opaque identity: its slots may move during compaction or span pages. */
export type FarChunkHandle = Readonly<{ design: number; count: number }>;

/** What one design contributes: its far LOD geometries and baked impostor, style and canopy. */
export type NativeTreeFarDesign = Readonly<{
  /** Index into the forest's designs array — the routing key for admit/release. */
  design: number;
  landscapeBranch: THREE.BufferGeometry;
  landscapeFoliage: THREE.BufferGeometry;
  horizonBranch: THREE.BufferGeometry;
  horizonFoliage: THREE.BufferGeometry;
  impostor: NativeTreeImpostor;
  style: NativeTreeStyle;
  assets: NativeTreeMaterialAssets;
  canopyCenter: readonly [number, number, number];
  canopyRadii: readonly [number, number, number];
  /** Local-space bounding sphere of the whole tree (scale 1) for the cull proxy. */
  boundsCenterY: number;
  boundsRadius: number;
  /** Authored count: only used to avoid oversized pages for tiny forests. */
  total: number;
}>;

export type NativeTreeFarTiersOptions = Readonly<{
  name: string;
  /** Landscape → horizon switch distance (dither band centred here). */
  horizonDistance: number;
  /** Beyond this (dithered) every instance extinguishes. */
  visibleDistance: number;
  /** Whole-tree impostor starts at this 3D render-camera distance (default 420m). */
  impostorDistance?: number;
  /**
   * Inside this radius, far instances that the near pool did not take over use
   * the smaller horizon silhouette instead of landscape's oversized opaque
   * cards — otherwise a saturated nearMax leaves giant triangles in personal
   * space next to detailed trees.
   */
  nearCardSuppressDistance?: number;
}>;

export type NativeTreeGpuFarTiers = Readonly<{
  /** Add to the forest group; hidden with it and by the master foliage toggle. */
  group: THREE.Group;
  /** Any live instance resident? Dispatch is skipped when false. */
  hasResident(): boolean;
  /** Admit every slot, splitting large chunks across resident pages. */
  admitChunk(design: number, slots: readonly FarInstanceInput[]): FarChunkHandle | null;
  /** Reclaim a chunk-design's slots and compact survivors. Idempotent. */
  releaseChunk(handle: FarChunkHandle): void;
  /** Near-pool takeover / restore: dark or re-show one instance the same frame. */
  setInstanceHidden(handle: FarChunkHandle, localIndex: number, scale: number, hidden: boolean): void;
  /** drawReset + every design cull against the render camera and tethered focus. */
  dispatch(renderer: THREE.WebGPURenderer, camera: THREE.Camera, focusX: number, focusZ: number): void;
  /** Prepare current pages and register the warmup callback for future pages. */
  prepare(prepareObject: (unit: THREE.Object3D) => Promise<void>): Promise<void>;
  /** Current resident-page draw count. */
  readonly farDraws: number;
  readonly designCount: number;
  residencyStats(): { pages: number; capacity: number; used: number; storageBytes: number; cullSlots: number };
  dispose(): void;
}>;

type DesignTier = {
  design: number;
  arena: InstanceArena;
  allocator: DenseSlotAllocator;
  allocations: Map<FarChunkHandle, DenseSlotToken>;
  visibles: VisibleBuffer[];
  materials: NativeTreeIndirectFarMaterials;
  impostorMaterial: THREE.Material;
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

function createTreeFarArena(
  designs: readonly NativeTreeFarDesign[],
  options: NativeTreeFarTiersOptions,
  capacity: number
): NativeTreeGpuFarTiers {
  const group = new THREE.Group();
  group.name = `${options.name}_far_tiers`;

  const cullCamera: CullCamera = createCullCamera();
  const focus = new THREE.Vector2(1e9, 1e9);
  const focusU = uniform(focus);
  const cameraPosition = new THREE.Vector3();
  const cameraPositionU = uniform(cameraPosition);
  // A very large finite distance also gives probes a same-device control.
  const impostorDistance = Number.isFinite(options.impostorDistance ?? 420)
    ? Math.max(1, options.impostorDistance ?? 420) : 1e9;

  // Pass 1: per-design arena + visible buffers + materials. Every design's five
  // records land in ONE shared indirect draw set (pass 2) so a single drawReset
  // zeroes the whole forest's far counts each frame.
  const tiers = new Map<number, DesignTier>();
  const entries: IndirectDrawEntry[] = [];
  for (const design of designs) {
    const arena = createInstanceArena(FAR_ARENA_ATTRS, capacity);
    const allocator = createDenseSlotAllocator(capacity);
    // Each tier's branch + foliage keep independent visible buffers: the cull
    // appends the same survivor index to both, order-independent and correct.
    const visibles = [
      createVisibleBuffer(capacity), // 0 branch landscape
      createVisibleBuffer(capacity), // 1 foliage landscape
      createVisibleBuffer(capacity), // 2 branch horizon
      createVisibleBuffer(capacity), // 3 foliage horizon
      createVisibleBuffer(capacity) // 4 whole-tree impostor
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
    const impostorMaterial = createTreeImpostorMaterial(design.style, design.impostor, {
      root: arena.read(ROOT), yaw: arena.read(YAW), visibleIndices: visibles[4].read
    });
    tiers.set(design.design, {
      design: design.design,
      arena,
      allocator,
      allocations: new Map(),
      visibles,
      materials,
      impostorMaterial,
      rootHost: arena.hostArray(ROOT),
      yawHost: arena.hostArray(YAW),
      capacity
    });
    entries.push(
      { geometry: design.landscapeBranch, material: materials.branch.landscape, capacity, visible: visibles[0], name: `${options.name}_${design.design}_branch_landscape` },
      { geometry: design.landscapeFoliage, material: materials.foliage.landscape, capacity, visible: visibles[1], name: `${options.name}_${design.design}_foliage_landscape` },
      { geometry: design.horizonBranch, material: materials.branch.horizon, capacity, visible: visibles[2], name: `${options.name}_${design.design}_branch_horizon` },
      { geometry: design.horizonFoliage, material: materials.foliage.horizon, capacity, visible: visibles[3], name: `${options.name}_${design.design}_foliage_horizon` },
      { geometry: design.impostor.geometry, material: impostorMaterial, capacity, visible: visibles[4], name: `${options.name}_${design.design}_impostor` }
    );
  }

  const drawSet: IndirectDrawSet = createIndirectDrawSet(entries, `${options.name}_far`);
  for (const record of drawSet.records) group.add(record.mesh);

  // Pass 2: read roots once, reject hidden/free slots and frustum misses, then
  // append one representation. Render-camera distance picks the impostor even
  // on high flyovers; focus XZ continues to control regional residency and the
  // close landscape/horizon bands.
  const designCulls: N[] = [];
  const cullOwners: DesignTier[] = [];
  designs.forEach((design, designIndex) => {
    const tier = tiers.get(design.design);
    if (!tier) return;
    const base = designIndex * 5;
    const [lBranch, lFoliage, hBranch, hFoliage, impostor] = drawSet.records.slice(base, base + 5) as [
      IndirectDrawRecord,
      IndirectDrawRecord,
      IndirectDrawRecord,
      IndirectDrawRecord,
      IndirectDrawRecord
    ];
    const rootRead = tier.arena.read(ROOT);
    const horizonDistance = options.horizonDistance;
    const nearCardSuppress = options.nearCardSuppressDistance ?? 0;
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
              // Near-pool overflow in personal space: horizon cards are smaller
              // than landscape's opaque triangles (see nearCardSuppressDistance).
              const cameraDistance = center.sub(cameraPositionU as N).length();
              const impostorAt = float(impostorDistance).add(
                hashUnit(gx, gz, 0x4f1b).sub(0.5).mul(NATIVE_TREE_LOD_TRANSITION_WIDTH)
              );
              If(cameraDistance.greaterThan(impostorAt), () => {
                impostor.append(idx);
              }).ElseIf(dist.lessThan(float(nearCardSuppress)), () => {
                hBranch.append(idx);
                hFoliage.append(idx);
              }).ElseIf(dist.lessThan(horizonAt), () => {
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
    cullOwners.push(tier);
  });

  let cullPasses: N[] = [drawSet.drawReset];
  let cullDirty = true;

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
    const allocation = tier.allocator.allocate(slots.length);
    if (!allocation) return null;
    const handle = { design, count: slots.length };
    tier.allocations.set(handle, allocation);
    const base = allocation.indices[0];
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
    cullDirty = true;
    return handle;
  };

  const releaseChunk = (handle: FarChunkHandle): void => {
    const tier = tiers.get(handle.design);
    if (!tier) return;
    const allocation = tier.allocations.get(handle);
    if (!allocation) return;
    tier.allocations.delete(handle);
    tier.allocator.release(allocation, (from, to) => {
      tier.rootHost.copyWithin(to * 4, from * 4, from * 4 + 4);
      tier.yawHost.copyWithin(to * 4, from * 4, from * 4 + 4);
      tier.arena.uploadRange(ROOT, to, to + 1);
      tier.arena.uploadRange(YAW, to, to + 1);
    });
    // The next dispatch resets all draws and only visits the dense live prefix.
    totalUsed -= handle.count;
    cullDirty = true;
  };

  const setInstanceHidden = (
    handle: FarChunkHandle,
    localIndex: number,
    scale: number,
    hidden: boolean
  ): void => {
    const tier = tiers.get(handle.design);
    if (!tier || localIndex < 0 || localIndex >= handle.count) return;
    const allocation = tier.allocations.get(handle);
    if (!allocation) return;
    const index = allocation.indices[localIndex];
    const a = index * 4 + 3;
    tier.rootHost[a] = hidden ? 0 : scale;
    tier.arena.uploadRange(ROOT, index, index + 1);
    cullDirty = true;
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
      const cameraChanged = cullCamera.update(camera);
      camera.getWorldPosition(cameraPosition);
      if (!cullDirty && !cameraChanged && focus.x === focusX && focus.y === focusZ) return;
      if (cullDirty) {
        // Reset every draw, but dispatch only designs with allocated instances.
        // Empty designs must still have their previous draw counts cleared.
        for (let i = 0; i < designCulls.length; i++) designCulls[i].count = cullOwners[i].allocator.used;
        cullPasses = [drawSet.drawReset, ...designCulls.filter((_, i) => cullOwners[i].allocator.used > 0)];
      }
      focus.set(focusX, focusZ);
      renderer.compute(cullPasses);
      tracer.count("treeCullPasses", cullPasses.length);
      cullDirty = false;
    },
    async prepare(prepareObject) {
      if (disposed || drawSet.records.length === 0) return;
      await prepareObject(group);
    },
    farDraws: drawSet.records.length,
    designCount: tiers.size,
    residencyStats: () => ({ pages: 1, capacity, used: totalUsed, storageBytes: capacity * 52 + drawSet.records.length * 20, cullSlots: totalUsed }),
    dispose() {
      if (disposed) return;
      disposed = true;
      // drawSet.dispose() owns the shared drawReset; only the per-design culls
      // are disposed here to avoid a double free.
      for (const cull of designCulls) cull.dispose();
      drawSet.dispose();
      for (const tier of tiers.values()) {
        tier.materials.dispose();
        tier.impostorMaterial.dispose();
        for (const visible of tier.visibles) visible.dispose();
        tier.arena.dispose();
      }
      tiers.clear();
      group.removeFromParent();
      group.clear();
    }
  });
}

/** Page lifetimes follow resident chunks, never the authored forest's extent. */
export function createNativeTreeGpuFarTiers(
  designs: readonly NativeTreeFarDesign[],
  options: NativeTreeFarTiersOptions
): NativeTreeGpuFarTiers {
  type Page = {
    owner: NativeTreeGpuFarTiers;
    container: THREE.Group;
    capacity: number;
    used: number;
    prepared: boolean;
    preparing: Promise<void> | null;
    inPrepare: boolean;
    destroyed: boolean;
    retryAt: number;
    retired: boolean;
  };
  const group = new THREE.Group();
  group.name = `${options.name}_far_tiers`;
  const byDesign = new Map(designs.map(design => [design.design, { design, pages: [] as Page[] }]));
  const handles = new Map<FarChunkHandle, { page: Page; handle: FarChunkHandle }[]>();
  const livePages = new Set<Page>();
  const retired = new Set<Page>();
  let prepareObject: ((unit: THREE.Object3D) => Promise<void>) | null = null;
  let disposed = false;
  let pageId = 0;
  let preparationTail: Promise<void> = Promise.resolve();
  const pages = () => [...livePages];
  const destroy = (page: Page) => {
    if (page.destroyed) return;
    page.destroyed = true;
    page.owner.dispose();
    retired.delete(page);
  };
  const preparePage = (page: Page): Promise<void> => {
    if (disposed || page.retired || page.prepared || !prepareObject) return Promise.resolve();
    if (page.preparing) return page.preparing;
    page.container.visible = false;
    const prepare = prepareObject;
    page.preparing = preparationTail.then(async () => {
      if (disposed || page.retired) return;
      page.inPrepare = true;
      await page.owner.prepare(prepare);
    }).then(() => {
      if (disposed || page.retired) return;
      page.prepared = true;
      page.container.visible = true;
    }).catch(error => {
      page.retryAt = performance.now() + 1000;
      throw error;
    }).finally(() => {
      page.preparing = null;
      page.inPrepare = false;
      if (page.retired) destroy(page);
    });
    preparationTail = page.preparing.catch(() => {});
    return page.preparing;
  };
  const warmPage = (page: Page) => {
    void preparePage(page).catch(error => {
      if (!disposed && !page.retired) console.warn(`[native trees:${options.name}] page preparation failed; retrying`, error);
    });
  };
  const retirePage = (page: Page) => {
    livePages.delete(page);
    page.retired = true;
    page.container.visible = false;
    page.container.removeFromParent();
    // compileAsync may still own these buffers. Finish that operation before
    // releasing them; a late result can never reattach the retired page.
    if (page.inPrepare) retired.add(page);
    else destroy(page);
  };
  return Object.freeze({
    group,
    hasResident: () => handles.size > 0,
    admitChunk(designIndex: number, slots: readonly FarInstanceInput[]) {
      const entry = byDesign.get(designIndex);
      if (disposed || !entry || slots.length === 0) return null;
      const handle = { design: designIndex, count: slots.length };
      const parts: { page: Page; handle: FarChunkHandle }[] = [];
      let offset = 0;
      while (offset < slots.length) {
        let page = entry.pages.find(p => p.used < p.capacity);
        if (!page) {
          const capacity = Math.min(PAGE_SLOTS, ceilPow2(Math.max(1, entry.design.total)));
          const container = new THREE.Group();
          container.name = `${options.name}_resident_page_${pageId}`;
          const owner = createTreeFarArena([entry.design], { ...options, name: `${options.name}_page${pageId++}` }, capacity);
          container.add(owner.group);
          container.visible = !prepareObject;
          group.add(container);
          page = { owner, container, capacity, used: 0, prepared: false, preparing: null, inPrepare: false, destroyed: false, retryAt: 0, retired: false };
          entry.pages.push(page);
          livePages.add(page);
        }
        const count = Math.min(slots.length - offset, page.capacity - page.used);
        const part = page.owner.admitChunk(designIndex, slots.slice(offset, offset + count));
        if (!part) throw new Error(`Native tree page accounting mismatch: ${designIndex}`);
        page.used += count;
        parts.push({ page, handle: part });
        offset += count;
        if (prepareObject) warmPage(page);
      }
      handles.set(handle, parts);
      return handle;
    },
    releaseChunk(handle: FarChunkHandle) {
      const parts = handles.get(handle);
      if (!parts) return;
      handles.delete(handle);
      for (const { page, handle: part } of parts) {
        page.owner.releaseChunk(part);
        page.used -= part.count;
        if (page.used === 0) {
          const list = byDesign.get(handle.design)!.pages;
          list.splice(list.indexOf(page), 1);
          retirePage(page);
        }
      }
    },
    setInstanceHidden(handle: FarChunkHandle, localIndex: number, scale: number, hidden: boolean) {
      if (localIndex < 0 || localIndex >= handle.count) return;
      for (const part of handles.get(handle) ?? []) {
        if (localIndex < part.handle.count) {
          part.page.owner.setInstanceHidden(part.handle, localIndex, scale, hidden);
          return;
        }
        localIndex -= part.handle.count;
      }
    },
    dispatch(renderer: THREE.WebGPURenderer, camera: THREE.Camera, focusX: number, focusZ: number) {
      if (disposed) return;
      for (const page of livePages) {
        if (prepareObject && !page.prepared) {
          if (!page.preparing && performance.now() >= page.retryAt) warmPage(page);
          continue;
        }
        page.owner.dispatch(renderer, camera, focusX, focusZ);
      }
    },
    async prepare(prepare: (unit: THREE.Object3D) => Promise<void>) {
      prepareObject = prepare;
      // Snapshot pages: newly admitted ones independently join the same warmup
      // path and stay hidden until ready, without invalidating prepared pages.
      await Promise.all(pages().map(preparePage));
    },
    get farDraws() { let draws = 0; for (const page of livePages) draws += page.owner.farDraws; return draws; },
    designCount: byDesign.size,
    residencyStats() {
      const live = pages();
      const held = [...live, ...retired];
      return {
        pages: held.length,
        capacity: held.reduce((sum, page) => sum + page.capacity, 0),
        used: live.reduce((sum, page) => sum + page.used, 0),
        storageBytes: held.reduce((sum, page) => sum + page.owner.residencyStats().storageBytes, 0),
        cullSlots: live.reduce((sum, page) => sum + page.used, 0)
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      handles.clear();
      for (const entry of byDesign.values()) {
        for (const page of entry.pages) retirePage(page);
        entry.pages.length = 0;
      }
      byDesign.clear();
      group.removeFromParent();
      group.clear();
    }
  });
}
