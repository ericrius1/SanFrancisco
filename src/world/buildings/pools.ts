// Per-building merged rendering for generated buildings.
//
// History: Phase 0 = ~1,000 InstancedMeshes/building (dead). Phase 1 = global
// BatchedMesh pools, 3 draw calls total — BUT with per-object frustum culling off
// it draws EVERY resident instance every frame, and the kit emits ~8,300 tiny
// instances/building (every window mullion, AC fin, clothesline). ~71 buildings =
// 589 k instances = 75 ms/frame, and per-instance visibility culling made it
// WORSE (setVisibleAt bookkeeping over 589 k instances). Measured, both dead.
//
// This version MERGES each building into one THREE.Mesh per kit material
// (building / floor / glass) — exactly how the baked city tiles render. The win:
//   - zero per-instance overhead (raw triangles the GPU eats fast),
//   - THREE frustum-culls each building for FREE (mesh.frustumCulled) — only the
//     handful of buildings actually on screen draw,
//   - O(1) dispose (3 geometry.dispose(), not 8,300 deleteInstance — that O(n)
//     dispose was the earlier 30 s streaming hang).
// Cost: merged geometry is per-building (no cross-building geometry sharing), so
// the resident set is kept small by a tight streaming ring (chinatown.ts).
//
// Shadow proxies (unchanged): the merged meshes never cast shadows (castShadow
// =false — the shadow pass is this app's #1 GPU cost); ShadowProxyPool holds one
// invisible solid box per building that casts a single clean silhouette instead.
import * as THREE from "three/webgpu";
import type { Kit } from "../../../vendor/BuildingGenerator/src/kit";
import type { Placement } from "../../../vendor/BuildingGenerator/src/generator";

const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);

/** parts we never render: kit's own shallow interiors (replaced by interior.ts) */
const SKIP_PART = /ROOMS|storeinside/i;

/** greeble parts dropped at "low" detail — the numerous small props: AC units +
 *  wires, clotheslines + clothes, curtains, loose props, roof props, ground lights.
 *  Keeps walls, windows, corners, storefronts, awnings (roof.002) and signs — the
 *  street-level silhouette and Kowloon character. Cuts a big chunk of vertices. */
const GREEBLE_PART = /\bac\b|ac\.001|AC WIRE|cloth ?lines|CURTAINS|prop_store|prop_front|prop_groud|roof_prop|lightsground/i;

// reused merge scratch (never allocate per part — GC churn dominated the old merge)
const _m = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _nm = new THREE.Matrix3();

export interface PoolHandle {
  meshes: THREE.Mesh[];
  vertexCount: number;
  /** in-progress merge job, if the building is still being built incrementally */
  job: MergeJob | null;
}

interface Bucket {
  mat: THREE.Material;
  verts: number; indices: number;
  pos?: Float32Array; nor?: Float32Array; uv?: Float32Array; idx?: Uint16Array | Uint32Array;
  vo: number; io: number;
}

/** A building's merge spread across frames: pass over the placement list to count
 *  (phase "count"), then again to fill pre-sized arrays (phase "fill"), a chunk of
 *  placements at a time, so a ~30 ms merge becomes several ~6 ms slices instead of
 *  a single stall while streaming. */
interface MergeJob {
  placements: Placement[];
  root: THREE.Matrix4;
  detail: "full" | "low";
  handle: PoolHandle;
  sphere: { center: THREE.Vector3; radius: number };
  byMat: Map<THREE.Material, Bucket>;
  phase: "count" | "fill" | "done";
  cursor: number;
  canceled: boolean;
}

export class BuildingBatchPools {
  #kit: Kit;
  #scene: THREE.Object3D;
  /** source geometry → normalized (position/normal/uv, indexed, de-interleaved) */
  #normCache = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  #buildings = new Set<PoolHandle>();
  /** in-progress incremental merges, advanced by pump() each frame */
  #jobs: MergeJob[] = [];

  constructor(kit: Kit, scene: THREE.Object3D) {
    this.#kit = kit;
    this.#scene = scene;
  }

  /** mergeGeometries needs every input to share the exact attribute layout. The
   *  kit is roughly uniform but GLTFLoader may interleave or add extras —
   *  normalize defensively to plain float32 position/normal/uv, indexed. */
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
    this.#normCache.set(src, g);
    return g;
  }

  /**
   * Start an INCREMENTAL merge of one building. A synchronous merge (~30 ms low /
   * ~55 ms full) stalls streaming, so this only queues a job and returns a handle
   * immediately; pump() advances the merge a chunk of placements per frame and the
   * handle's meshes appear a few frames later. The collider box + shadow proxy are
   * created by the caller right away, so the building is present/solid meanwhile.
   * `detail` "low" drops greeble parts.
   */
  addBuilding(
    placements: Placement[],
    root: THREE.Matrix4,
    sphere: { center: THREE.Vector3; radius: number },
    detail: "full" | "low" = "full"
  ): PoolHandle {
    const handle: PoolHandle = { meshes: [], vertexCount: 0, job: null };
    const job: MergeJob = {
      placements, root: root.clone(), detail, handle, sphere,
      byMat: new Map(), phase: "count", cursor: 0, canceled: false,
    };
    handle.job = job;
    this.#jobs.push(job);
    this.#buildings.add(handle);
    return handle;
  }

  /** Advance queued merge jobs for up to ~maxMs this frame — call once per frame.
   *  Turns a per-building merge stall into a few sub-frame slices while streaming. */
  pump(maxMs = 6): void {
    const t0 = performance.now();
    while (this.#jobs.length && performance.now() - t0 < maxMs) {
      const job = this.#jobs[0];
      if (job.canceled) { this.#jobs.shift(); continue; }
      this.#advance(job);
      if (job.phase === "done") this.#jobs.shift();
    }
  }

  #advance(job: MergeJob): void {
    const CHUNK = 1500; // placements processed per slice
    const { placements, detail } = job;
    if (job.phase === "count") {
      let n = 0;
      while (job.cursor < placements.length && n < CHUNK) {
        const pl = placements[job.cursor++]; n++;
        if (SKIP_PART.test(pl.key)) continue;
        if (detail === "low" && GREEBLE_PART.test(pl.key)) continue;
        const entries = this.#kit.partMeshEntries(pl.key);
        if (!entries) continue;
        for (const e of entries) {
          const g = this.#normalize(e.geometry); // cached; mirror has identical counts
          let bucket = job.byMat.get(e.material);
          if (!bucket) { bucket = { mat: e.material, verts: 0, indices: 0, vo: 0, io: 0 }; job.byMat.set(e.material, bucket); }
          bucket.verts += g.getAttribute("position").count;
          bucket.indices += g.index!.count;
        }
      }
      if (job.cursor >= placements.length) {
        for (const b of job.byMat.values()) {
          b.pos = new Float32Array(b.verts * 3);
          b.nor = new Float32Array(b.verts * 3);
          b.uv = new Float32Array(b.verts * 2);
          b.idx = b.verts > 65535 ? new Uint32Array(b.indices) : new Uint16Array(b.indices);
        }
        job.phase = "fill"; job.cursor = 0;
      }
      return;
    }
    // phase "fill": transform + write, reusing module scratch matrices
    const m = _m, world = _world, nm = _nm, root = job.root;
    let n = 0;
    while (job.cursor < placements.length && n < CHUNK) {
      const pl = placements[job.cursor++]; n++;
      if (SKIP_PART.test(pl.key)) continue;
      if (detail === "low" && GREEBLE_PART.test(pl.key)) continue;
      const entries = this.#kit.partMeshEntries(pl.key);
      if (!entries) continue;
      for (const e of entries) {
        m.copy(pl.matrix).multiply(e.meshLocal);
        // mirror-baked geometry for negative-determinant placements
        const mirrored = m.determinant() < 0;
        const g = mirrored ? this.#kit.mirroredGeometry(this.#normalize(e.geometry)) : this.#normalize(e.geometry);
        if (mirrored) m.multiply(MIRROR_X);
        world.multiplyMatrices(root, m);
        const wp = world.elements;
        nm.getNormalMatrix(world);
        const ne = nm.elements;
        const bucket = job.byMat.get(e.material)!;
        const pos = bucket.pos!, nor = bucket.nor!, uv = bucket.uv!, idx = bucket.idx!;
        const sp = (g.getAttribute("position") as THREE.BufferAttribute).array as ArrayLike<number>;
        const sn = (g.getAttribute("normal") as THREE.BufferAttribute).array as ArrayLike<number>;
        const su = (g.getAttribute("uv") as THREE.BufferAttribute).array as ArrayLike<number>;
        const si = g.index!.array as ArrayLike<number>;
        const vc = g.getAttribute("position").count;
        const vo = bucket.vo;
        for (let v = 0; v < vc; v++) {
          const x = sp[v * 3], y = sp[v * 3 + 1], z = sp[v * 3 + 2];
          const o = (vo + v) * 3;
          pos[o] = wp[0] * x + wp[4] * y + wp[8] * z + wp[12];
          pos[o + 1] = wp[1] * x + wp[5] * y + wp[9] * z + wp[13];
          pos[o + 2] = wp[2] * x + wp[6] * y + wp[10] * z + wp[14];
          const nx = sn[v * 3], ny = sn[v * 3 + 1], nz = sn[v * 3 + 2];
          const ox = ne[0] * nx + ne[3] * ny + ne[6] * nz;
          const oy = ne[1] * nx + ne[4] * ny + ne[7] * nz;
          const oz = ne[2] * nx + ne[5] * ny + ne[8] * nz;
          const inv = 1 / (Math.hypot(ox, oy, oz) || 1);
          nor[o] = ox * inv; nor[o + 1] = oy * inv; nor[o + 2] = oz * inv;
          const uo = (vo + v) * 2;
          uv[uo] = su[v * 2]; uv[uo + 1] = su[v * 2 + 1];
        }
        const ic = g.index!.count;
        const io = bucket.io;
        for (let i = 0; i < ic; i++) idx[io + i] = si[i] + vo;
        bucket.vo += vc; bucket.io += ic;
      }
    }
    if (job.cursor >= placements.length) this.#finalize(job);
  }

  #finalize(job: MergeJob): void {
    const meshes = job.handle.meshes;
    let vertexCount = 0;
    for (const bucket of job.byMat.values()) {
      const merged = new THREE.BufferGeometry();
      merged.setAttribute("position", new THREE.BufferAttribute(bucket.pos!, 3));
      merged.setAttribute("normal", new THREE.BufferAttribute(bucket.nor!, 3));
      merged.setAttribute("uv", new THREE.BufferAttribute(bucket.uv!, 2));
      merged.setIndex(new THREE.BufferAttribute(bucket.idx!, 1));
      merged.computeBoundingSphere(); // frustum culling reads this
      vertexCount += bucket.verts;
      const mesh = new THREE.Mesh(merged, bucket.mat);
      mesh.name = "genBuildingMerged";
      mesh.castShadow = false;       // ShadowProxyPool casts instead
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;     // THREE culls per-building for free
      mesh.matrixAutoUpdate = false; // geometry is already in world space
      this.#scene.add(mesh);
      meshes.push(mesh);
    }
    job.handle.vertexCount = vertexCount;
    job.handle.job = null;
    job.phase = "done";
  }

  /** O(materials) — dispose the merged geometries, or cancel an in-flight merge. */
  removeBuilding(handle: PoolHandle): void {
    if (handle.job) { handle.job.canceled = true; handle.job = null; } // shifted out of #jobs by pump
    for (const mesh of handle.meshes) {
      this.#scene.remove(mesh);
      mesh.geometry.dispose();
    }
    handle.meshes.length = 0;
    this.#buildings.delete(handle);
  }

  /** no-op — kept for API parity; merged meshes carry their own bounds. */
  flush(): void {}
  /** no-op — THREE frustum-culls the merged meshes automatically. */
  cull(_camera: THREE.Camera): void {}

  stats() {
    let buildings = 0, meshes = 0, vertexCount = 0;
    for (const h of this.#buildings) { buildings++; meshes += h.meshes.length; vertexCount += h.vertexCount; }
    return { batches: meshes, instances: vertexCount, geometries: meshes, maxInstances: 0, buildings, pendingJobs: this.#jobs.length };
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
