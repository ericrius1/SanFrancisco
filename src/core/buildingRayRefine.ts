import * as THREE from "three/webgpu";

/**
 * Refines LOOSE baked building-box ray hits onto the ACTUALLY RENDERED citygen
 * surface. The baked collider bake decomposes concave footprints into OBBs that
 * overshoot the true footprint by up to ~2 m (tools/collider-lib.mjs overGate +
 * min half-extent clamp), while the visible far mesh — the merged chunk-LOD
 * prism — is the EXACT footprint. Without refinement a paint splat lands
 * mid-air in front of the visible facade, and a shot aimed through a GAP
 * between buildings splats on nothing.
 *
 * physics.raycastWorld calls `refine(origin, dir, boxDist)` for every building
 * hit whose baked mesh is hidden (the citygen ring draws in its place): the
 * same ray is re-tested against the rendered geometry within ±WINDOW metres of
 * the box hit. A triangle hit replaces the box point/normal; NO triangle means
 * the ray passed through bake overshoot and the caller continues past the box.
 *
 * Sources of rendered geometry (all direct scene children, found by name and
 * cached with a short TTL — no per-shot full-scene traversal):
 *  - "cityGenChunkLOD": one merged world-space prism mesh per 800 m cell
 *    (identity transform). three's Raycaster would test EVERY triangle of a
 *    cell per query, so these go through a lazily built per-geometry XZ bucket
 *    index instead — only triangles near the hit window are intersected.
 *    Buildings whose prism is discarded by the shader (a faded-in detail
 *    building owns the silhouette) have lodVisibility=0 on their vertex range;
 *    those triangles are skipped exactly as the material's alphaTest discards
 *    them.
 *  - "cityGenBuilding" (detail BundleGroups, ~0.6% proud scale) and
 *    "cityGenInterior": handled by a standard THREE.Raycaster — few meshes,
 *    small bounding spheres, near/far window keeps it cheap.
 */

const WINDOW = 4; // m before/after the box hit that may hold the true wall
const CACHE_MS = 400; // scene-children rescan TTL
const BUCKET = 24; // m, XZ triangle-bucket size for merged chunk prism meshes

export interface RefinedHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

type ChunkIndex = {
  minX: number;
  minZ: number;
  nx: number;
  nz: number;
  /** bucket (cx * nz + cz) -> first index-array offset of each triangle */
  cells: Map<number, number[]>;
};

export class BuildingRayRefiner {
  #scene: THREE.Object3D;
  #chunks: THREE.Mesh[] = [];
  #details: THREE.Object3D[] = [];
  #cachedAt = -Infinity;
  // per-geometry triangle index — chunk geometry is immutable once merged (only
  // its lodVisibility attribute mutates), and the WeakMap lets disposed chunks GC
  #indices = new WeakMap<THREE.BufferGeometry, ChunkIndex>();

  #ray = new THREE.Ray();
  #caster = new THREE.Raycaster();
  #hits: THREE.Intersection[] = [];
  #a = new THREE.Vector3();
  #b = new THREE.Vector3();
  #c = new THREE.Vector3();
  #p = new THREE.Vector3();
  #e2 = new THREE.Vector3();
  #box = new THREE.Box3();
  #seen = new Set<number>();

  constructor(scene: THREE.Object3D) {
    this.#scene = scene;
  }

  /** Nearest rendered-surface triangle hit within ±WINDOW m of `boxDist` along
   * the ray, or null when the window holds no visible citygen triangle. */
  refine(origin: THREE.Vector3, dir: THREE.Vector3, boxDist: number): RefinedHit | null {
    this.#refresh();
    if (this.#chunks.length === 0 && this.#details.length === 0) return null;
    const near = Math.max(0, boxDist - WINDOW);
    const far = boxDist + WINDOW;
    this.#ray.origin.copy(origin);
    this.#ray.direction.copy(dir);

    let best: RefinedHit | null = null;
    for (const mesh of this.#chunks) best = this.#refineChunk(mesh, near, far, best);

    if (this.#details.length) {
      const caster = this.#caster;
      caster.ray.origin.copy(origin);
      caster.ray.direction.copy(dir);
      caster.near = near;
      caster.far = far;
      this.#hits.length = 0;
      caster.intersectObjects(this.#details, true, this.#hits);
      for (const h of this.#hits) {
        // sorted ascending — first acceptable hit is the closest
        if (best && h.distance >= best.distance) break;
        if (!h.face || h.object.visible === false) continue; // hidden baked door leaf
        const normal = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        if (normal.dot(dir) > 0) normal.negate(); // face the shooter, whatever the winding
        best = { point: h.point, normal, distance: h.distance };
        break;
      }
    }
    return best;
  }

  #refresh(): void {
    const now = performance.now();
    if (now - this.#cachedAt < CACHE_MS) return;
    this.#cachedAt = now;
    this.#chunks.length = 0;
    this.#details.length = 0;
    // the ring adds all three directly to the scene root — a shallow scan finds them
    for (const child of this.#scene.children) {
      if (child.name === "cityGenChunkLOD") this.#chunks.push(child as THREE.Mesh);
      else if (child.name === "cityGenBuilding" || child.name === "cityGenInterior") this.#details.push(child);
    }
  }

  #refineChunk(mesh: THREE.Mesh, near: number, far: number, best: RefinedHit | null): RefinedHit | null {
    const geo = mesh.geometry;
    const index = geo.index;
    if (!index) return best;
    if (!geo.boundingBox) geo.computeBoundingBox();
    // AABB of the refine window's ray segment, padded — rejects far cells cheaply
    const ray = this.#ray;
    const box = this.#box;
    box.makeEmpty();
    box.expandByPoint(this.#p.copy(ray.origin).addScaledVector(ray.direction, near));
    box.expandByPoint(this.#p.copy(ray.origin).addScaledVector(ray.direction, far));
    box.expandByScalar(0.5);
    if (!box.intersectsBox(geo.boundingBox!)) return best;

    const idx = this.#indexOf(geo);
    const pos = geo.getAttribute("position");
    const cx0 = Math.max(0, Math.floor((box.min.x - idx.minX) / BUCKET));
    const cx1 = Math.min(idx.nx - 1, Math.floor((box.max.x - idx.minX) / BUCKET));
    const cz0 = Math.max(0, Math.floor((box.min.z - idx.minZ) / BUCKET));
    const cz1 = Math.min(idx.nz - 1, Math.floor((box.max.z - idx.minZ) / BUCKET));
    const seen = this.#seen;
    seen.clear();
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const bucket = idx.cells.get(cx * idx.nz + cz);
        if (!bucket) continue;
        for (const t of bucket) {
          if (seen.has(t)) continue;
          seen.add(t);
          const ia = index.getX(t);
          // NOTE: hidden prism ranges (lodVisibility<0.5) are NOT skipped. A hidden
          // range means a fully-faded-in DETAIL building owns that silhouette — and
          // its wall now lives in the batched shell layer (not a raycastable mesh),
          // sitting ~0.6% proud of this prism (coplanar to a few cm). So the hidden
          // prism IS the stand-in surface a paint/ball ray must hit; skipping it (as
          // the old code did, when the detail wall was a raycastable bundle mesh)
          // would let rays pass straight through settled detail buildings.
          this.#a.fromBufferAttribute(pos as THREE.BufferAttribute, ia);
          this.#b.fromBufferAttribute(pos as THREE.BufferAttribute, index.getX(t + 1));
          this.#c.fromBufferAttribute(pos as THREE.BufferAttribute, index.getX(t + 2));
          // chunk geometry is world-space on an identity transform — intersect directly
          const hit = ray.intersectTriangle(this.#a, this.#b, this.#c, false, this.#p);
          if (!hit) continue;
          const d = hit.distanceTo(ray.origin);
          if (d < near - 1e-3 || d > far + 1e-3) continue;
          if (best && d >= best.distance) continue;
          const normal = new THREE.Vector3()
            .subVectors(this.#b, this.#a)
            .cross(this.#e2.subVectors(this.#c, this.#a))
            .normalize();
          if (normal.dot(ray.direction) > 0) normal.negate();
          best = { point: hit.clone(), normal, distance: d };
        }
      }
    }
    return best;
  }

  /** Lazily bucket a chunk geometry's triangles into an XZ grid (built once per
   * geometry on first refine near it — a few ms for a dense cell, then cached). */
  #indexOf(geo: THREE.BufferGeometry): ChunkIndex {
    let ci = this.#indices.get(geo);
    if (ci) return ci;
    const bb = geo.boundingBox!;
    const minX = bb.min.x;
    const minZ = bb.min.z;
    const nx = Math.max(1, Math.ceil((bb.max.x - minX) / BUCKET));
    const nz = Math.max(1, Math.ceil((bb.max.z - minZ) / BUCKET));
    const cells = new Map<number, number[]>();
    const index = geo.index!;
    const pos = geo.getAttribute("position");
    for (let t = 0; t < index.count; t += 3) {
      let tminx = Infinity, tmaxx = -Infinity, tminz = Infinity, tmaxz = -Infinity;
      for (let k = 0; k < 3; k++) {
        const vi = index.getX(t + k);
        const x = pos.getX(vi), z = pos.getZ(vi);
        if (x < tminx) tminx = x;
        if (x > tmaxx) tmaxx = x;
        if (z < tminz) tminz = z;
        if (z > tmaxz) tmaxz = z;
      }
      const bx0 = Math.max(0, Math.floor((tminx - minX) / BUCKET));
      const bx1 = Math.min(nx - 1, Math.floor((tmaxx - minX) / BUCKET));
      const bz0 = Math.max(0, Math.floor((tminz - minZ) / BUCKET));
      const bz1 = Math.min(nz - 1, Math.floor((tmaxz - minZ) / BUCKET));
      for (let bx = bx0; bx <= bx1; bx++) {
        for (let bz = bz0; bz <= bz1; bz++) {
          const key = bx * nz + bz;
          const bucket = cells.get(key);
          if (bucket) bucket.push(t);
          else cells.set(key, [t]);
        }
      }
    }
    ci = { minX, minZ, nx, nz, cells };
    this.#indices.set(geo, ci);
    return ci;
  }
}
