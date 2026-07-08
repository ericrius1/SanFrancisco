// Global cross-building rendering pools for generated buildings.
//
// Phase 0 rendered each building as ~1,000 per-building InstancedMeshes (one per
// unique kit part-mesh) — ~1,000 draw calls PER BUILDING, which can never scale.
// Phase 1 collapses the whole system to THREE global THREE.BatchedMesh pools (one
// per kit material: building / floor / glass). Each unique part-mesh geometry is
// uploaded ONCE into its material's batch; every placed instance across ALL
// buildings is just (geometryId, matrix) in the batch. Draw calls for any number
// of generated buildings: ~3 (+1 shadow-proxy pool).
//
// Why BatchedMesh and not one-InstancedMesh-per-part-key pools: Phase 0 measured
// 1,021 UNIQUE part meshes for a single building — per-part pools would still be
// >1,000 draw calls for the whole street and fail the perf gate. BatchedMesh gives
// the identical bookkeeping (global pools, append-on-add, O(building) removal,
// per-instance frustum culling) with the draw-call count of a merged mesh.
//
// Lifecycle:
//   addBuilding(placements, root)  → appends instances, returns a handle
//   removeBuilding(handle)         → deleteInstance per ref, O(building instances)
//   flush()                        → recomputes batch bounding spheres when dirty
//                                    (call once after a batch of adds/removes —
//                                    stale bounds = invisible-buildings bug)
// Growth: instance capacity and vertex/index capacity double on demand
// (BatchedMesh.setInstanceCount / setGeometrySize preserve contents).
//
// Shadow proxies: the batches themselves NEVER cast shadows (castShadow=false —
// the shadow pass is this app's #1 GPU cost and per-part casters would be worse
// than Phase 0). Instead ShadowProxyPool holds ONE solid box per building in a
// single InstancedMesh whose material writes neither color nor depth: invisible
// to the main camera, but castShadow=true puts it in the CSM shadow maps, so each
// building casts one clean silhouette shadow.
import * as THREE from "three/webgpu";
import type { Kit } from "../../../vendor/BuildingGenerator/src/kit";
import type { Placement } from "../../../vendor/BuildingGenerator/src/generator";

const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);

/** parts we never render: kit's own shallow interiors (replaced by interior.ts) */
const SKIP_PART = /ROOMS|storeinside/i;

interface InstanceRef {
  rec: BatchRec;
  id: number;
  /** normalized geometry this instance renders — needed to re-add on rebuild */
  geom: THREE.BufferGeometry;
}

export interface PoolHandle {
  refs: InstanceRef[];
}

interface BatchRec {
  batch: THREE.BatchedMesh;
  /** normalized geometry → geometryId in this batch */
  geomIds: Map<THREE.BufferGeometry, number>;
  /** all live instances, so a rebuild can re-add them */
  live: Set<InstanceRef>;
  maxInstances: number;
  maxVerts: number;
  maxIndices: number;
  boundsDirty: boolean;
}

const INITIAL_INSTANCES = 8192;
const INITIAL_VERTS = 1 << 17;   // 131072 — whole kit is ~52k verts
const INITIAL_INDICES = 1 << 18;

export class BuildingBatchPools {
  #kit: Kit;
  #scene: THREE.Object3D;
  #byMaterial = new Map<THREE.Material, BatchRec>();
  /** source geometry → normalized (position/normal/uv, indexed, de-interleaved) */
  #normCache = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();

  constructor(kit: Kit, scene: THREE.Object3D) {
    this.#kit = kit;
    this.#scene = scene;
  }

  /** BatchedMesh requires every geometry to share the exact attribute layout.
   *  The kit is uniform (POSITION/NORMAL/TEXCOORD_0, indexed) but GLTFLoader may
   *  interleave or add extras — normalize defensively to plain float32 buffers. */
  #normalize(src: THREE.BufferGeometry): THREE.BufferGeometry {
    let g = this.#normCache.get(src);
    if (g) return g;
    g = new THREE.BufferGeometry();
    const pos = src.getAttribute("position");
    const n = pos.count;
    const copy = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, size: number) => {
      const out = new Float32Array(n * size);
      if (attr) {
        for (let i = 0; i < n; i++) {
          out[i * size] = attr.getX(i);
          if (size > 1) out[i * size + 1] = attr.getY(i);
          if (size > 2) out[i * size + 2] = attr.getZ(i);
        }
      }
      return new THREE.BufferAttribute(out, size);
    };
    g.setAttribute("position", copy(pos, 3));
    g.setAttribute("normal", copy(src.getAttribute("normal"), 3));
    g.setAttribute("uv", copy(src.getAttribute("uv"), 2));
    if (src.index) g.setIndex(src.index.clone());
    else {
      const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) arr[i] = i;
      g.setIndex(new THREE.BufferAttribute(arr, 1));
    }
    g.computeBoundingSphere();
    this.#normCache.set(src, g);
    return g;
  }

  #makeBatch(rec: Pick<BatchRec, "maxInstances" | "maxVerts" | "maxIndices">, material: THREE.Material): THREE.BatchedMesh {
    const batch = new THREE.BatchedMesh(rec.maxInstances, rec.maxVerts, rec.maxIndices, material);
    batch.name = `buildingBatch:${material.name || "part"}`;
    batch.castShadow = false;       // shadows come from ShadowProxyPool only
    batch.receiveShadow = true;
    // Per-object culling/sorting iterate EVERY instance on the CPU each frame —
    // measured 4.3 ms/frame at 87k instances (20 buildings), vs ~0.0 ms with the
    // static full draw list. Whole-batch culling still applies via the batch
    // boundingSphere, which flush() keeps current. Per-BUILDING visibility gating
    // (setVisibleAt over a building's refs) is the scalable middle ground if GPU
    // vertex cost ever bites; not needed at street scale.
    batch.perObjectFrustumCulled = false;
    batch.sortObjects = false;
    return batch;
  }

  #batchFor(material: THREE.Material): BatchRec {
    let rec = this.#byMaterial.get(material);
    if (rec) return rec;
    rec = {
      batch: null as unknown as THREE.BatchedMesh,
      geomIds: new Map(),
      live: new Set(),
      maxInstances: INITIAL_INSTANCES,
      maxVerts: INITIAL_VERTS,
      maxIndices: INITIAL_INDICES,
      boundsDirty: true,
    };
    rec.batch = this.#makeBatch(rec, material);
    this.#byMaterial.set(material, rec);
    this.#scene.add(rec.batch);
    return rec;
  }

  /**
   * Capacity growth = FULL REBUILD: a brand-new BatchedMesh at the new capacity,
   * geometries + live instances re-added, swapped into the scene.
   *
   * Why not BatchedMesh.setInstanceCount/setGeometrySize: they replace the
   * matrices/indirect textures (or attribute arrays) on the SAME mesh, and the
   * three r185 WebGPU backend keeps rendering with the old disposed textures —
   * every instance added after a resize renders with garbage matrices (verified
   * with a minimal in-app repro; from-scratch construction at any capacity and
   * post-render addInstance/setMatrixAt both work fine). A fresh object gets
   * fresh bindings, which is the only resize path the backend handles correctly.
   */
  #rebuild(rec: BatchRec, minInstances: number, minVerts: number, minIndices: number): void {
    while (rec.maxInstances < minInstances) rec.maxInstances *= 2;
    while (rec.maxVerts < minVerts) rec.maxVerts *= 2;
    while (rec.maxIndices < minIndices) rec.maxIndices *= 2;
    const old = rec.batch;
    const next = this.#makeBatch(rec, old.material as THREE.Material);
    // re-add geometries in insertion order, then remap live instances
    const newIds = new Map<THREE.BufferGeometry, number>();
    for (const g of rec.geomIds.keys()) newIds.set(g, next.addGeometry(g));
    rec.geomIds = newIds;
    const m = new THREE.Matrix4();
    for (const ref of rec.live) {
      old.getMatrixAt(ref.id, m);
      const nid = next.addInstance(newIds.get(ref.geom)!);
      next.setMatrixAt(nid, m);
      ref.id = nid;
    }
    this.#scene.remove(old);
    old.dispose();
    this.#scene.add(next);
    rec.batch = next;
    rec.boundsDirty = true;
  }

  #geometryId(rec: BatchRec, geom: THREE.BufferGeometry): number {
    let id = rec.geomIds.get(geom);
    if (id !== undefined) return id;
    const nv = geom.getAttribute("position").count;
    const ni = geom.index!.count;
    if (rec.batch.unusedVertexCount < nv || rec.batch.unusedIndexCount < ni) {
      const g = rec.batch.geometry;
      const curV = g.getAttribute("position").count;
      const curI = g.index!.count;
      this.#rebuild(rec, rec.maxInstances, curV + nv, curI + ni);
    }
    id = rec.batch.addGeometry(geom);
    rec.geomIds.set(geom, id);
    return id;
  }

  #addInstance(rec: BatchRec, geom: THREE.BufferGeometry, matrix: THREE.Matrix4): InstanceRef {
    let geomId = this.#geometryId(rec, geom);
    let id: number;
    try {
      id = rec.batch.addInstance(geomId);
    } catch {
      this.#rebuild(rec, rec.maxInstances * 2, rec.maxVerts, rec.maxIndices);
      geomId = rec.geomIds.get(geom)!;
      id = rec.batch.addInstance(geomId);
    }
    rec.batch.setMatrixAt(id, matrix);
    rec.boundsDirty = true;
    const ref: InstanceRef = { rec, id, geom };
    rec.live.add(ref);
    return ref;
  }

  /** Append every placement of one building. root = world matrix of the building
   *  (position · yaw · Z-up→Y-up · metre scale). Returns a removal handle. */
  addBuilding(placements: Placement[], root: THREE.Matrix4): PoolHandle {
    const refs: InstanceRef[] = [];
    const m = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    for (const pl of placements) {
      if (SKIP_PART.test(pl.key)) continue;
      const entries = this.#kit.partMeshEntries(pl.key);
      if (!entries) continue;
      for (const e of entries) {
        m.copy(pl.matrix).multiply(e.meshLocal);
        // mirror-baked geometry for negative-determinant placements (root is
        // rotation+uniform-scale+translation, so its determinant is positive and
        // the sign is decided by placement × meshLocal — same rule as the kit).
        const mirrored = m.determinant() < 0;
        const srcGeom = mirrored ? this.#kit.mirroredGeometry(this.#normalize(e.geometry)) : this.#normalize(e.geometry);
        if (mirrored) m.multiply(MIRROR_X);
        world.copy(root).multiply(m);
        refs.push(this.#addInstance(this.#batchFor(e.material), srcGeom, world));
      }
    }
    return { refs };
  }

  /** O(building's instances). Freed slots are recycled by BatchedMesh.addInstance. */
  removeBuilding(handle: PoolHandle): void {
    for (const ref of handle.refs) {
      ref.rec.batch.deleteInstance(ref.id);
      ref.rec.live.delete(ref);
      ref.rec.boundsDirty = true;
    }
    handle.refs.length = 0;
  }

  /** Recompute batch bounding spheres after adds/removes — a global batch spans
   *  many buildings, and stale bounds would frustum-cull visible ones away. */
  flush(): void {
    for (const rec of this.#byMaterial.values()) {
      if (!rec.boundsDirty) continue;
      rec.boundsDirty = false;
      rec.batch.computeBoundingSphere();
    }
  }

  stats() {
    let batches = 0, instances = 0, geometries = 0, maxInstances = 0;
    for (const rec of this.#byMaterial.values()) {
      batches++;
      instances += rec.batch.instanceCount;
      geometries += rec.geomIds.size;
      maxInstances += rec.maxInstances;
    }
    return { batches, instances, geometries, maxInstances };
  }
}

/* ===================================================== shadow proxy pool */

/** One solid box per building, in ONE InstancedMesh. Invisible to the camera
 *  (colorWrite & depthWrite off) but castShadow=true → it is what the CSM
 *  shadow pass renders instead of thousands of kit parts. */
export class ShadowProxyPool {
  #im: THREE.InstancedMesh;
  #scene: THREE.Object3D;
  #capacity: number;
  #count = 0;
  /** slot → owner record (mutated on swap-remove) */
  #owners: { slot: number }[] = [];

  constructor(scene: THREE.Object3D, capacity = 64) {
    this.#scene = scene;
    this.#capacity = capacity;
    this.#im = this.#make(capacity);
    scene.add(this.#im);
  }

  #make(capacity: number): THREE.InstancedMesh {
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const im = new THREE.InstancedMesh(geom, mat, capacity);
    im.name = "buildingShadowProxies";
    im.count = this.#count;
    im.castShadow = true;
    im.receiveShadow = false;
    im.frustumCulled = false; // tiny; must stay visible to the shadow cameras
    return im;
  }

  /** matrix should place a unit box over the building volume (slightly inset so
   *  sun-facing facades don't self-shadow against their own proxy). */
  add(matrix: THREE.Matrix4): { slot: number } {
    if (this.#count === this.#capacity) {
      const bigger = this.#make(this.#capacity * 2);
      for (let i = 0; i < this.#count; i++) {
        bigger.instanceMatrix.array.set(
          this.#im.instanceMatrix.array.subarray(i * 16, i * 16 + 16), i * 16);
      }
      this.#scene.remove(this.#im);
      this.#im.dispose();
      this.#capacity *= 2;
      this.#im = bigger;
      this.#scene.add(this.#im);
    }
    const slot = this.#count++;
    this.#im.setMatrixAt(slot, matrix);
    this.#im.count = this.#count;
    this.#im.instanceMatrix.needsUpdate = true;
    const owner = { slot };
    this.#owners[slot] = owner;
    return owner;
  }

  remove(owner: { slot: number }): void {
    const last = this.#count - 1;
    const slot = owner.slot;
    if (slot < 0 || slot > last) return;
    if (slot !== last) {
      // swap-remove: move the last instance into the freed slot
      this.#im.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16);
      const moved = this.#owners[last];
      moved.slot = slot;
      this.#owners[slot] = moved;
    }
    this.#owners.length = last;
    this.#count = last;
    this.#im.count = this.#count;
    this.#im.instanceMatrix.needsUpdate = true;
    owner.slot = -1;
  }

  get count(): number {
    return this.#count;
  }
}
