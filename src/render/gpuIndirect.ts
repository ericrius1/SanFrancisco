// Shared GPU indirect-draw instancing runtime — the "false-earth" pipeline as a
// domain-neutral core: cull compute → atomicAdd visible-index compaction →
// IndirectStorageBufferAttribute indirect draws → materials resolve instances
// through visibleIndices.element(instanceIndex). One proven implementation for
// every instanced system (grass today; trees, wildflowers, and non-vegetation
// users next) instead of parallel bespoke copies.
//
// The core owns the generic plumbing only: storage-buffer instance arenas, the
// shared indirect buffer + per-record draw meshes, compacted visible-index
// buffers, the clip-space frustum test, the per-frame cull-camera uniforms, and
// disposal. Every domain-specific decision — how a candidate is placed, what
// makes it visible, which record (LOD tier / mesh) it draws through — stays with
// the consumer, injected through hooks. Nothing here allocates GPU memory at
// import time; a consumer constructs resources on first use.
//
// WebGPU-only. Foliage consumers never cast/receive shadows; this module sets no
// shadow state and callers must not add any.

import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  abs,
  atomicAdd,
  atomicStore,
  float,
  instanceIndex,
  storage,
  uint,
  uniform,
  vec4
} from "three/tsl";
import { releaseRendererAttribute } from "../app/rendererRegistry";

// TSL's .d.ts narrows chained node types too aggressively for vendored uniforms;
// the whole module speaks the loose node type these graphs actually pass around.
type N = any;

/** Draw-arg stride of an IndirectStorageBufferAttribute record, in uint32s:
 *  [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]. Only the
 *  first two are used: indexCount is baked at init, instanceCount is the atomic
 *  draw counter the cull compaction bumps. */
export const INDIRECT_STRIDE = 5;

// ---------------------------------------------------------------------------
// Instance arenas
// ---------------------------------------------------------------------------

/** Storage element type of one arena attribute (materials + compute read/write
 *  through this). Every arena attribute is a float storage buffer. */
export type StorageFormat = "vec4" | "vec3" | "vec2" | "float";

const FORMAT_COMPONENTS: Readonly<Record<StorageFormat, number>> = {
  vec4: 4,
  vec3: 3,
  vec2: 2,
  float: 1
};

export type ArenaAttributeSpec = Readonly<{
  /** Consumer-facing key used by read()/write()/hostArray()/attribute(). */
  name: string;
  /** Storage element type; the backing itemSize is derived from it. */
  format: StorageFormat;
}>;

/** A storage-buffer instance arena: one parallel plane of per-instance data per
 *  declared attribute, all sized to the same capacity. Fill it from a GPU compute
 *  (grass placement writes the arena) or stream it from the host in ranges (trees
 *  page chunk data in); the two are not exclusive per attribute. */
export type InstanceArena = Readonly<{
  capacity: number;
  /** Read-only storage node — bind into a material's instance source. */
  read(name: string): N;
  /** Writable storage node — bind into a compute that fills or reads the arena.
   *  (Reads through a writable node are legal; grass culls through it.) */
  write(name: string): N;
  /** Backing Float32 array for host-streamed writes; index as instance*components. */
  hostArray(name: string): Float32Array;
  /** Flag [fromInstance, toInstance) dirty for the next submit. Ranged upload when
   *  the backend supports it (r185 WebGPU does), else a whole-buffer re-upload. */
  uploadRange(name: string, fromInstance: number, toInstance: number): void;
  /** Flag the whole attribute dirty for the next submit. */
  markDirty(name: string): void;
  /** Underlying attribute (QA probes, custom storage nodes). */
  attribute(name: string): THREE.StorageInstancedBufferAttribute;
  /** Release every GPU attribute; call from the owner's dispose(). */
  dispose(): void;
}>;

export function createInstanceArena(
  specs: readonly ArenaAttributeSpec[],
  capacity: number
): InstanceArena {
  type Entry = {
    attribute: THREE.StorageInstancedBufferAttribute;
    components: number;
    read: N;
    write: N;
  };
  const entries = new Map<string, Entry>();
  for (const spec of specs) {
    const components = FORMAT_COMPONENTS[spec.format];
    const attribute = new THREE.StorageInstancedBufferAttribute(capacity, components);
    entries.set(spec.name, {
      attribute,
      components,
      // One writable node (compute writes + culls read through it) and one
      // read-only node (materials), matching the two storage() handles every
      // consumer creates per attribute.
      write: storage(attribute, spec.format, capacity),
      read: storage(attribute, spec.format, capacity).toReadOnly()
    });
  }
  const entry = (name: string): Entry => {
    const found = entries.get(name);
    if (!found) throw new Error(`gpuIndirect: unknown arena attribute "${name}"`);
    return found;
  };
  return {
    capacity,
    read: (name) => entry(name).read,
    write: (name) => entry(name).write,
    hostArray: (name) => entry(name).attribute.array as Float32Array,
    uploadRange(name, fromInstance, toInstance) {
      const e = entry(name);
      const from = Math.max(0, Math.min(capacity, Math.floor(fromInstance)));
      const to = Math.max(from, Math.min(capacity, Math.floor(toInstance)));
      if (to <= from) return;
      e.attribute.addUpdateRange(from * e.components, (to - from) * e.components);
      e.attribute.needsUpdate = true;
    },
    markDirty: (name) => {
      entry(name).attribute.needsUpdate = true;
    },
    attribute: (name) => entry(name).attribute,
    dispose() {
      for (const e of entries.values()) releaseRendererAttribute(e.attribute);
    }
  };
}

// ---------------------------------------------------------------------------
// Range allocator (primitive for host-streamed arenas)
// ---------------------------------------------------------------------------

/** First-fit free-range allocator over an arena's [0, capacity) instance slots.
 *  Streaming consumers (trees paging chunk data into the arena) hand out and
 *  reclaim contiguous ranges with it; grass/flowers, which own fixed regions,
 *  do not need it. */
export type RangeAllocator = Readonly<{
  capacity: number;
  /** Reserve `count` contiguous slots; returns the base index or null if none fit. */
  alloc(count: number): number | null;
  /** Return a previously allocated range so it can be reused (coalesced). */
  free(base: number, count: number): void;
  /** Currently reserved slot count. */
  readonly used: number;
}>;

export function createRangeAllocator(capacity: number): RangeAllocator {
  // Sorted, coalesced list of free spans.
  let free: { base: number; count: number }[] = [{ base: 0, count: capacity }];
  let used = 0;
  return {
    capacity,
    alloc(count) {
      if (count <= 0) return 0;
      for (let i = 0; i < free.length; i++) {
        const span = free[i];
        if (span.count < count) continue;
        const base = span.base;
        if (span.count === count) free.splice(i, 1);
        else {
          span.base += count;
          span.count -= count;
        }
        used += count;
        return base;
      }
      return null;
    },
    free(base, count) {
      if (count <= 0) return;
      free.push({ base, count });
      free.sort((a, b) => a.base - b.base);
      const merged: { base: number; count: number }[] = [];
      for (const span of free) {
        const last = merged[merged.length - 1];
        if (last && last.base + last.count === span.base) last.count += span.count;
        else merged.push({ ...span });
      }
      free = merged;
      used = Math.max(0, used - count);
    },
    get used() {
      return used;
    }
  };
}

// ---------------------------------------------------------------------------
// Visible-index buffers
// ---------------------------------------------------------------------------

/** A compacted visible-instance-index buffer. The cull compute appends surviving
 *  arena indices here (via a draw record's append); the record's material reads
 *  them back through visibleIndices.element(instanceIndex). A buffer may be owned
 *  1:1 by a record (grass, one per layer) or shared across records at distinct
 *  base offsets (flowers pack every bucket into one; a tree tier shares one across
 *  its branch + foliage draws). */
export type VisibleBuffer = Readonly<{
  capacity: number;
  /** Read-only uint storage node — bind into a material's visibleIndices. */
  read: N;
  /** Writable uint storage node — the cull compaction writes compacted indices. */
  write: N;
  attribute: THREE.StorageBufferAttribute;
  dispose(): void;
}>;

export function createVisibleBuffer(capacity: number): VisibleBuffer {
  const attribute = new THREE.StorageBufferAttribute(new Uint32Array(capacity), 1);
  return {
    capacity,
    read: storage(attribute, "uint", capacity).toReadOnly(),
    write: storage(attribute, "uint", capacity),
    attribute,
    dispose() {
      releaseRendererAttribute(attribute);
    }
  };
}

// ---------------------------------------------------------------------------
// Indirect draw set
// ---------------------------------------------------------------------------

export type IndirectDrawEntry = Readonly<{
  /** Cloned into an InstancedBufferGeometry (index + attributes + groups). The
   *  source geometry is not retained; the caller may dispose it afterwards. */
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Instance address space for this record (its slice of the arena). */
  capacity: number;
  /** Compacted visible-index buffer this record draws through. */
  visible: VisibleBuffer;
  /** First slot of this record's region inside `visible` (0 unless shared). */
  visibleBase?: number;
  /** Mesh name. */
  name: string;
}>;

/** One draw: an InstancedBufferGeometry bound to its slot of the shared indirect
 *  buffer, plus the primitives a cull pass needs to compact into it. */
export type IndirectDrawRecord = Readonly<{
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;
  capacity: number;
  visible: VisibleBuffer;
  visibleBase: number;
  /** This record's 5-uint block index in the shared indirect buffer. */
  slot: number;
  /** Atomic node for this record's instanceCount — the draw counter. Bump it as an
   *  append counter (see append), or overwrite it (publish) via IndirectDrawSet. */
  drawCount: N;
  /** Inside a cull Fn: append `instanceIndexNode` to this record — atomically bump
   *  instanceCount and store the arena index at visible[base + slot]. */
  append(instanceIndexNode: N): void;
}>;

export type IndirectDrawSet = Readonly<{
  records: readonly IndirectDrawRecord[];
  /** Shared draw-arg buffer, INDIRECT_STRIDE uints per record. QA reads counts here. */
  indirect: THREE.IndirectStorageBufferAttribute;
  /** Atomic storage node over the raw indirect uints (custom count writes / publish). */
  indirectStorage: N;
  /** Compute that zeroes every record's instanceCount; run first each cull frame. */
  drawReset: N;
  /** Local uint32 index of a record's instanceCount inside `indirect` (publish helper). */
  countIndex(recordIndex: number): number;
  dispose(): void;
}>;

function cloneToInstanced(
  source: THREE.BufferGeometry,
  capacity: number,
  indirect: THREE.IndirectStorageBufferAttribute,
  indirectByteOffset: number
): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  if (source.index) geometry.setIndex(source.index.clone());
  for (const [attributeName, attribute] of Object.entries(source.attributes)) {
    geometry.setAttribute(attributeName, attribute.clone());
  }
  for (const group of source.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  // Instance data lives in storage buffers read through the visible-index
  // indirection — deliberately NOT vertex attributes, so a culled draw only
  // fetches survivors and the pipeline stays under the vertex-buffer slot budget.
  geometry.instanceCount = capacity;
  geometry.setIndirect(indirect, indirectByteOffset);
  // Never CPU-frustum-culled; the compute cull owns visibility. The huge bound
  // keeps the whole-object test (if ever consulted) from dropping the draw.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 24_000);
  return geometry;
}

/** Build the shared indirect buffer and one InstancedBufferGeometry draw per
 *  entry, wiring each geometry to its 5-uint indirect slot with the index count
 *  baked in. Materials and visible buffers are supplied by the caller (a material
 *  must exist to make its mesh, and it reads through the visible buffer). */
export function createIndirectDrawSet(
  entries: readonly IndirectDrawEntry[],
  namePrefix = "indirect"
): IndirectDrawSet {
  const indirectData = new Uint32Array(entries.length * INDIRECT_STRIDE);
  for (let i = 0; i < entries.length; i++) {
    const geometry = entries[i].geometry;
    indirectData[i * INDIRECT_STRIDE] =
      geometry.index?.count ?? geometry.getAttribute("position").count;
  }
  const indirect = new THREE.IndirectStorageBufferAttribute(indirectData, 1);
  const indirectStorage = storage(indirect, "uint", indirectData.length).toAtomic();

  const records = entries.map((entry, index): IndirectDrawRecord => {
    const visibleBase = entry.visibleBase ?? 0;
    const geometry = cloneToInstanced(
      entry.geometry,
      entry.capacity,
      indirect,
      index * INDIRECT_STRIDE * Uint32Array.BYTES_PER_ELEMENT
    );
    const mesh = new THREE.Mesh(geometry, entry.material) as THREE.Mesh<
      THREE.InstancedBufferGeometry,
      THREE.Material
    >;
    mesh.name = entry.name;
    mesh.frustumCulled = false;
    const drawCount = indirectStorage.element(uint(index * INDIRECT_STRIDE + 1));
    const visibleWrite = entry.visible.write;
    return {
      mesh,
      capacity: entry.capacity,
      visible: entry.visible,
      visibleBase,
      slot: index,
      drawCount,
      append(instanceIndexNode: N) {
        const slot = atomicAdd(drawCount, uint(1));
        const target = visibleBase === 0 ? slot : uint(visibleBase).add(slot);
        (visibleWrite.element(target) as N).assign(instanceIndexNode);
      }
    };
  });

  const drawReset = Fn(() => {
    atomicStore(indirectStorage.element(instanceIndex.mul(uint(INDIRECT_STRIDE)).add(uint(1))), uint(0));
  })()
    .compute(entries.length, [64])
    .setName(`${namePrefix} draw reset`);

  return {
    records,
    indirect,
    indirectStorage,
    drawReset,
    countIndex: (recordIndex) => recordIndex * INDIRECT_STRIDE + 1,
    dispose() {
      drawReset.dispose();
      for (const record of records) {
        record.mesh.geometry.setIndirect(null);
        record.mesh.geometry.dispose();
        record.mesh.removeFromParent();
      }
      releaseRendererAttribute(indirect);
    }
  };
}

// ---------------------------------------------------------------------------
// Per-frame cull camera + frustum test
// ---------------------------------------------------------------------------

/** Per-frame frustum-cull camera state, shared by every cull pass of a system. */
export type CullCamera = Readonly<{
  /** uniform(Matrix4) — camera view-projection, for clip-space transforms. */
  viewProjection: N;
  /** uniform(Vector2) — projection x/y scales, for the world-margin test. */
  projScale: N;
  /** Refresh both uniforms; true only when culling inputs changed. */
  update(camera: THREE.Camera): boolean;
}>;

export function createCullCamera(): CullCamera {
  const viewProjection = uniform(new THREE.Matrix4());
  const projScale = uniform(new THREE.Vector2(1, 1));
  const nextProjection = new THREE.Matrix4();
  return {
    viewProjection,
    projScale,
    update(camera: THREE.Camera) {
      camera.updateMatrixWorld();
      nextProjection.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
      );
      const matrix = viewProjection.value as THREE.Matrix4;
      const scale = projScale.value as THREE.Vector2;
      const changed = !matrix.equals(nextProjection) || scale.x !== camera.projectionMatrix.elements[0] || scale.y !== camera.projectionMatrix.elements[5];
      matrix.copy(nextProjection);
      (projScale.value as THREE.Vector2).set(
        camera.projectionMatrix.elements[0],
        camera.projectionMatrix.elements[5]
      );
      return changed;
    }
  };
}

/** Clip-space left/right/top/bottom frustum test for a world-space sphere, with a
 *  projection-scaled world margin and NO near/far test — reversed-z safe, and the
 *  cull's placement radius already bounds distance. Returns a bool node. Call
 *  inside a cull Fn. */
export function frustumTest(camera: CullCamera, center: N, radius: N): N {
  const clip = ((camera.viewProjection as N).mul(vec4(center, float(1))) as N).toVar();
  const inFront = clip.w.greaterThan(radius.negate());
  const xIn = abs(clip.x).lessThan(clip.w.add(radius.mul((camera.projScale as N).x)));
  const yIn = abs(clip.y).lessThan(clip.w.add(radius.mul((camera.projScale as N).y)));
  return inFront.and(xIn).and(yIn);
}

// ---------------------------------------------------------------------------
// Cull pass assembly
// ---------------------------------------------------------------------------

/** Per-instance cull decision. Returned by a consumer's hook after it has read
 *  whatever arena data it needs (hoist those reads with .toVar() once, then reuse
 *  across the fields). */
export type CullInstance = Readonly<{
  /** World-space frustum proxy centre for this instance. */
  center: N;
  /** World-space frustum proxy radius (already including any sway/ground slack). */
  radius: N;
  /** Extra reject beyond the frustum: a bool node (e.g. rank-vs-distance fade for
   *  grass, a hidden flag for trees). Omit for frustum-only acceptance. */
  accept?: N;
  /** Append this instance's survivors. Called only when in-frustum AND accepted;
   *  emit one or more record.append(idx) here (a single record for grass; a
   *  tier-picked record — or a tier's branch + foliage records — for trees). */
  emit: () => void;
}>;

export type CullPassSpec = Readonly<{
  name: string;
  /** Threads to dispatch — the arena capacity being culled. */
  dispatch: number;
  /** Workgroup size (default 256). */
  workgroup?: number;
  camera: CullCamera;
  /** Optional valid-instance upper bound (e.g. atomicLoad of a live-compaction
   *  count): threads with instanceIndex >= it are skipped. Omit to test all
   *  `dispatch` instances. Returns a uint node. */
  activeCount?: () => N;
  /** Per-instance hook: read arena data for `idx`, return its cull proxy + accept
   *  + emit closure. Reads land before the frustum branch; emit lands inside it. */
  instance: (idx: N) => CullInstance;
}>;

/** Assemble a per-frame cull compute: frustum-test each (optionally live) instance
 *  and append survivors into their record's visible buffer + indirect count. The
 *  built-in test is the clip-space frustum; the consumer owns acceptance and
 *  tier/record routing through the `instance` hook. */
export function buildCullPass(spec: CullPassSpec): N {
  const workgroup = spec.workgroup ?? 256;
  const run = (idx: N) => {
    const info = spec.instance(idx);
    const visible = frustumTest(spec.camera, info.center, info.radius);
    const accepted = info.accept ? visible.and(info.accept) : visible;
    If(accepted, () => {
      info.emit();
    });
  };
  return Fn(() => {
    const idx = instanceIndex;
    const activeCount = spec.activeCount;
    if (activeCount) {
      If(idx.lessThan(activeCount()), () => {
        run(idx);
      });
    } else {
      run(idx);
    }
  })()
    .compute(spec.dispatch, [workgroup])
    .setName(spec.name);
}
