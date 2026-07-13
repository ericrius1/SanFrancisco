// NativeTreeForest — one renderer for every authored and open-world tree.
//
// The compiler flattens each tree LOD into one branch mesh and one foliage mesh.
// This runtime instances those whole-tree prototypes per chunk, shares immutable
// vertex/index buffers across every chunk, batches close trees by design+LOD,
// and uses a stable low-cost proxy for shadows. All distance grades share this
// whole-tree batching path and its compact instance storage.

import * as THREE from "three/webgpu";
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

export type NativeTreeForest = {
  group: THREE.Group;
  /** Resolves after native prototypes, material packs and chunk batches exist. */
  ready: Promise<void>;
  /** Call every frame with the player/view position. */
  update(focus: { x: number; z: number }): void;
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
const CULL_MOVE = 24;
const HORIZON_HYSTERESIS = 14;
const VISIBILITY_HYSTERESIS = 18;
const ZERO_SCALE = 1e-6;
const LOD_CANOPY = 0;
const LOD_GROVE = 1;
const LOD_LANDSCAPE = 2;
const LOD_HORIZON = 3;
const UP = new THREE.Vector3(0, 1, 0);

type Slot = NativeTreeSlot & {
  index: number;
  chunk: string;
  key: string;
  variation: number;
  dryness: number;
};

type BatchVariant = {
  lod: number;
  branch: TreeInstanceGeometry;
  foliage: TreeInstanceGeometry;
};

type TreeBatch = {
  name: string;
  capacity: number;
  branch: THREE.InstancedMesh;
  foliage: THREE.InstancedMesh;
  matrix: THREE.StorageInstancedBufferAttribute;
  root: THREE.StorageInstancedBufferAttribute;
  yaw: THREE.StorageInstancedBufferAttribute;
  variants: readonly BatchVariant[];
  materials: NativeTreeMaterials;
  currentLod: number;
};

type ChunkDesign = {
  slots: Slot[];
  batch: TreeBatch;
};

type Chunk = {
  key: string;
  group: THREE.Group;
  cx: number;
  cz: number;
  horizontalRadius: number;
  lod: 2 | 3;
  byDesign: Map<number, ChunkDesign>;
  shadowProxy: TreeShadowProxy | null;
};

type NearPool = {
  canopy: TreeBatch;
  grove: TreeBatch;
};

type ActiveNear = {
  slot: Slot;
  chunk: Chunk;
  lod: 0 | 1;
};

const matrixScratch = new THREE.Matrix4();
const positionScratch = new THREE.Vector3();
const quaternionScratch = new THREE.Quaternion();
const scaleScratch = new THREE.Vector3();

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

function slotMatrix(slot: Slot, hidden = false): THREE.Matrix4 {
  const scale = hidden ? ZERO_SCALE : slot.scale;
  positionScratch.set(slot.x, slot.y, slot.z);
  quaternionScratch.setFromAxisAngle(UP, slot.yaw);
  scaleScratch.setScalar(scale);
  return matrixScratch.compose(positionScratch, quaternionScratch, scaleScratch);
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
  batch.branch.setMatrixAt(index, slotMatrix(slot, hidden));
  if (!writeStaticData) return;
  batch.root.setXYZW(index, slot.x, slot.y, slot.z, slot.scale);
  batch.yaw.setXYZW(
    index,
    Math.sin(slot.yaw),
    Math.cos(slot.yaw),
    slot.variation,
    slot.dryness
  );
}

function finishBatchWrite(batch: TreeBatch, count: number, staticData: boolean): void {
  batch.branch.count = count;
  batch.foliage.count = count;
  updateRange(batch.matrix, 0, Math.max(1, count) * 16);
  if (staticData) {
    updateRange(batch.root, 0, Math.max(1, count) * 4);
    updateRange(batch.yaw, 0, Math.max(1, count) * 4);
  }
}

function setBatchEntries(batch: TreeBatch, slots: readonly Slot[]): void {
  for (let index = 0; index < slots.length; index++) writeBatchSlot(batch, slots[index], index);
  finishBatchWrite(batch, slots.length, true);
}

function setBatchLod(batch: TreeBatch, lod: number): void {
  if (batch.currentLod === lod) return;
  const variant = batch.variants.find((candidate) => candidate.lod === lod);
  if (!variant) throw new Error(`${batch.name} has no LOD ${lod}`);
  batch.branch.geometry = variant.branch.geometry;
  batch.foliage.geometry = variant.foliage.geometry;
  batch.branch.material = batch.materials.branch[lod];
  batch.foliage.material = batch.materials.foliage[lod];
  batch.currentLod = lod;
}

function setBatchMaterials(batch: TreeBatch, materials: NativeTreeMaterials): void {
  batch.materials = materials;
  batch.branch.material = materials.branch[batch.currentLod];
  batch.foliage.material = materials.foliage[batch.currentLod];
}

function createBatch(
  template: GrownTemplate,
  materials: NativeTreeMaterials,
  lods: readonly number[],
  capacity: number,
  name: string,
  sphere: THREE.Sphere | null,
  parent: THREE.Group
): TreeBatch {
  if (capacity < 1) throw new Error(`${name} needs a positive capacity`);
  const variants: BatchVariant[] = [];
  const instanceUsage = sphere === null ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage;
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
  const branch = new THREE.InstancedMesh(first.branch.geometry, materials.branch[first.lod], capacity);
  const foliage = new THREE.InstancedMesh(first.foliage.geometry, materials.foliage[first.lod], capacity);
  const matrix = new THREE.StorageInstancedBufferAttribute(capacity, 16);
  matrix.setUsage(instanceUsage);
  branch.instanceMatrix = matrix;
  foliage.instanceMatrix = matrix;
  branch.name = `${name}_branch`;
  foliage.name = `${name}_foliage`;
  branch.castShadow = false;
  foliage.castShadow = false;
  branch.receiveShadow = true;
  foliage.receiveShadow = false;
  branch.frustumCulled = sphere !== null;
  foliage.frustumCulled = sphere !== null;
  branch.boundingSphere = sphere?.clone() ?? null;
  foliage.boundingSphere = sphere?.clone() ?? null;
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
    matrix,
    root: first.branch.root,
    yaw: first.branch.yaw,
    variants,
    materials,
    currentLod: first.lod
  };
}

function disposeBatch(batch: TreeBatch): void {
  batch.branch.removeFromParent();
  batch.foliage.removeFromParent();
  batch.branch.dispose();
  batch.foliage.dispose();
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
      dryness: Math.pow(slotRandom(source, design.seed, 0x6a09e667), 3) * 0.32
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
  const chunks: Chunk[] = [];
  const allNearSlots: { slot: Slot; chunk: Chunk }[] = [];
  const nearPools = new Map<number, NearPool>();
  const active = new Map<string, ActiveNear>();
  const lastFocus = { x: 1e9, z: 1e9 };
  const lastRebinFocus = new THREE.Vector2(1e9, 1e9);
  const requestedDesigns = new Set<number>();
  for (const slots of chunkSlots.values()) for (const slot of slots) requestedDesigns.add(slot.design);
  let lastRebin = 0;
  let hasCullFocus = false;

  function ensureNearMaterials(design: number): void {
    if (disposed || nearMaterials[design] || nearLoads[design]) return;
    const template = templates[design];
    if (!template) return;
    const task = (async () => {
      const detailAssets = await loadNativeTreeMaterialSet(template.archetype.species, {
        leafColorVariant: template.archetype.style.leafColorVariant,
        detail: "full"
      });
      if (disposed) {
        releaseNativeTreeMaterialSet(detailAssets);
        return;
      }
      const detailMaterials = createNativeTreeMaterials(template.archetype.style, detailAssets);
      nearAssets[design] = detailAssets;
      nearMaterials[design] = detailMaterials;
      const pool = nearPools.get(design);
      if (pool) {
        setBatchMaterials(pool.canopy, detailMaterials);
        setBatchMaterials(pool.grove, detailMaterials);
      }
    })().catch((error) => {
      console.warn(`[native trees:${options.name}] close material detail failed for ${template.archetype.species}`, error);
    }).finally(() => {
      nearLoads[design] = null;
    });
    nearLoads[design] = task;
  }

  function setFarHidden(chunk: Chunk, slot: Slot, hidden: boolean): void {
    const batch = chunk.byDesign.get(slot.design)?.batch;
    if (!batch) return;
    writeBatchSlot(batch, slot, slot.index, hidden, false);
    batch.matrix.clearUpdateRanges();
    batch.matrix.addUpdateRange(slot.index * 16, 16);
    batch.matrix.needsUpdate = true;
  }

  function rebin(x: number, z: number, force = false): void {
    if (nearMax === 0 || allNearSlots.length === 0) return;
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

    const next = new Map<string, ActiveNear>();
    for (const candidate of candidates) {
      next.set(candidate.slot.key, {
        slot: candidate.slot,
        chunk: candidate.chunk,
        lod: candidate.lod
      });
    }
    for (const [key, entry] of active) {
      if (!next.has(key)) setFarHidden(entry.chunk, entry.slot, false);
    }
    for (const [key, entry] of next) {
      if (!active.has(key)) setFarHidden(entry.chunk, entry.slot, true);
      ensureNearMaterials(entry.slot.design);
    }

    const canopyByDesign: Slot[][] = designs.map(() => []);
    const groveByDesign: Slot[][] = designs.map(() => []);
    for (const entry of next.values()) {
      (entry.lod === LOD_CANOPY ? canopyByDesign : groveByDesign)[entry.slot.design].push(entry.slot);
    }
    for (const [design, pool] of nearPools) {
      setBatchEntries(pool.canopy, canopyByDesign[design]);
      setBatchEntries(pool.grove, groveByDesign[design]);
    }
    active.clear();
    for (const [key, entry] of next) active.set(key, entry);
  }

  function applyDistanceCull(x: number, z: number, force = false): void {
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 1e8 || Math.abs(z) > 1e8) {
      for (const chunk of chunks) chunk.group.visible = false;
      return;
    }
    if (!force && Math.hypot(x - lastFocus.x, z - lastFocus.z) < CULL_MOVE) return;
    const firstCull = !hasCullFocus;
    hasCullFocus = true;
    lastFocus.x = x;
    lastFocus.z = z;
    for (const chunk of chunks) {
      const centerDistance = Math.hypot(chunk.cx - x, chunk.cz - z);
      const edgeDistance = Math.max(0, centerDistance - chunk.horizontalRadius);
      const visibilityLimit = firstCull
        ? visibleDistance
        : visibleDistance + (chunk.group.visible ? VISIBILITY_HYSTERESIS : -VISIBILITY_HYSTERESIS);
      chunk.group.visible = edgeDistance < visibilityLimit;
      if (!chunk.group.visible) continue;
      if (firstCull) {
        chunk.lod = edgeDistance >= horizonDistance ? LOD_HORIZON : LOD_LANDSCAPE;
      } else if (chunk.lod === LOD_LANDSCAPE && edgeDistance >= horizonDistance + HORIZON_HYSTERESIS) {
        chunk.lod = LOD_HORIZON;
      } else if (chunk.lod === LOD_HORIZON && edgeDistance < horizonDistance - HORIZON_HYSTERESIS) {
        chunk.lod = LOD_LANDSCAPE;
      }
      for (const entry of chunk.byDesign.values()) setBatchLod(entry.batch, chunk.lod);
    }
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
        const materialPack = createNativeTreeMaterials(template.archetype.style, materialAssets);
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

    const usedDesigns = new Set<number>();
    let instanceBytes = 0;
    for (const [key, slots] of chunkSlots) {
      const sphere = chunkSphere(slots, templates);
      const chunk: Chunk = {
        key,
        group: new THREE.Group(),
        cx: sphere.center.x,
        cz: sphere.center.z,
        horizontalRadius: chunkHorizontalRadius(slots, templates, sphere.center.x, sphere.center.z),
        lod: LOD_LANDSCAPE,
        byDesign: new Map(),
        shadowProxy: null
      };
      chunk.group.name = `${options.name}_${key}`;
      const byDesign = new Map<number, Slot[]>();
      for (const slot of slots) {
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
        const batch = createBatch(
          template,
          materialPack,
          [LOD_LANDSCAPE, LOD_HORIZON],
          designSlots.length,
          `${options.name}_${designs[design].species}_${key}`,
          sphere,
          chunk.group
        );
        for (let index = 0; index < designSlots.length; index++) {
          writeBatchSlot(batch, designSlots[index], index);
        }
        finishBatchWrite(batch, designSlots.length, true);
        chunk.byDesign.set(design, { slots: designSlots, batch });
        usedDesigns.add(design);
        stats.instances += designSlots.length;
        stats.farTriangles += template.geometry.lods[LOD_LANDSCAPE].triangles * designSlots.length;
        stats.horizonTriangles += template.geometry.lods[LOD_HORIZON].triangles * designSlots.length;
        instanceBytes += designSlots.length * (16 + 4 + 4) * 4;

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
          name: `${options.name}_shadow_${key}`,
          instances: shadowInstances,
          cellSize: Math.min(96, chunkSize)
        });
        chunk.group.add(chunk.shadowProxy.group);
      }
      if (chunk.byDesign.size > 0) {
        chunks.push(chunk);
        group.add(chunk.group);
      }
    }

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
        nearPools.set(design, { canopy, grove });
        instanceBytes += nearMax * (16 + 4 + 4) * 4 * 2;
      }
    }

    stats.designs = usedDesigns.size;
    stats.chunks = chunks.length;
    stats.draws = Array.from(chunks).reduce((sum, chunk) => sum + chunk.byDesign.size * 2, 0)
      + nearPools.size * 4;
    stats.prototypeBytes = Array.from(usedDesigns).reduce(
      (sum, design) => sum + (
        templates[design]?.geometry.stats.lods.reduce((lodSum, lod) => lodSum + lod.byteLength, 0) ?? 0
      ),
      0
    );
    stats.instanceBytes = instanceBytes;
    group.userData.nativeTreeStats = stats;
    group.userData.disposeTreeShadowProxies = () => {
      for (const chunk of chunks) chunk.shadowProxy?.dispose();
    };

    applyDistanceCull(lastFocus.x, lastFocus.z, true);
    if (Number.isFinite(lastFocus.x) && Math.abs(lastFocus.x) < 1e8) {
      rebin(lastFocus.x, lastFocus.z, true);
    }
    console.log(
      `[native trees] ${options.name}: ${stats.designs} designs, ${stats.instances} trees, ` +
      `${stats.chunks} chunks, ${(stats.prototypeBytes / 1048576).toFixed(1)} MiB shared prototypes, ` +
      `${(stats.instanceBytes / 1048576).toFixed(1)} MiB instance data`
    );
  })();

  return {
    group,
    ready,
    update(focus) {
      if (disposed) return;
      applyDistanceCull(focus.x, focus.z);
      rebin(focus.x, focus.z);
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
      for (const chunk of chunks) {
        for (const entry of chunk.byDesign.values()) disposeBatch(entry.batch);
        chunk.shadowProxy?.dispose();
      }
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
