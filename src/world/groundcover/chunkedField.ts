// Shared chunked-instancing + LOD infrastructure for ground-cover systems.
//
// Every scattered foliage layer (grass, wildflowers, and future ones) wants the
// SAME spatial machinery: bucket a big list of placements into ~chunk-sized
// tiles, give each tile a real bounding sphere so the renderer's frustum cull
// drops off-screen tiles, and hide whole tiles past a view distance so a region
// 2 km away costs nothing. That logic lives here ONCE.
//
// Each concrete system stays its own module: it supplies a `build` callback that
// turns one tile's items into instanced meshes (its own geometry + material),
// and keeps its own group so it can be toggled on/off independently. The field
// owns chunking, sphere-culling, and focus-distance culling.

import * as THREE from "three/webgpu";

export type FieldItem = { x: number; y: number; z: number };

/** Turn one chunk's items into a renderable object. Set `boundingSphere` on any
 *  InstancedMesh you create to `sphere` so per-chunk frustum culling works. */
export type ChunkBuild<T extends FieldItem> = (
  items: T[],
  sphere: THREE.Sphere,
  key: string
) => THREE.Object3D | null;

export type ChunkedFieldOptions = {
  name: string;
  /** chunk edge length in metres */
  chunkSize: number;
  /** chunks beyond this distance from the focus point are hidden entirely */
  visibleDistance: number;
  /** min focus movement (m) before re-evaluating distance culling (default 20) */
  moveThreshold?: number;
  /** extra vertical headroom added to each chunk sphere for tall items (default 1) */
  canopyHeadroom?: number;
};

type Chunk = { group: THREE.Group; cx: number; cz: number };

export class ChunkedField<T extends FieldItem> {
  readonly group = new THREE.Group();
  readonly chunkCount: number;
  #chunks: Chunk[] = [];
  #visSq: number;
  #moveSq: number;
  #last = { x: 1e9, z: 1e9 };

  constructor(items: readonly T[], opts: ChunkedFieldOptions, build: ChunkBuild<T>) {
    this.group.name = opts.name;
    this.#visSq = opts.visibleDistance * opts.visibleDistance;
    const move = opts.moveThreshold ?? 20;
    this.#moveSq = move * move;
    const headroom = opts.canopyHeadroom ?? 1;

    const byChunk = new Map<string, T[]>();
    for (const it of items) {
      const key = `${Math.floor(it.x / opts.chunkSize)},${Math.floor(it.z / opts.chunkSize)}`;
      const list = byChunk.get(key);
      if (list) list.push(it);
      else byChunk.set(key, [it]);
    }

    for (const [key, list] of byChunk) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const it of list) {
        if (it.x < minX) minX = it.x;
        if (it.x > maxX) maxX = it.x;
        if (it.y < minY) minY = it.y;
        if (it.y > maxY) maxY = it.y;
        if (it.z < minZ) minZ = it.z;
        if (it.z > maxZ) maxZ = it.z;
      }
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const sphere = new THREE.Sphere(
        new THREE.Vector3(cx, (minY + maxY) / 2 + headroom * 0.5, cz),
        Math.hypot(maxX - minX, maxY - minY + headroom, maxZ - minZ) / 2 + 1
      );
      const built = build(list, sphere, key);
      if (!built) continue;
      const cGroup = new THREE.Group();
      cGroup.name = `${opts.name}_${key}`;
      cGroup.add(built);
      this.group.add(cGroup);
      this.#chunks.push({ group: cGroup, cx, cz });
    }
    this.chunkCount = this.#chunks.length;
    this.#cull(0, 0, true);
  }

  /** Per-frame: hide chunks beyond the view distance from the focus point. */
  update(focus: { x: number; z: number }) {
    this.#cull(focus.x, focus.z, false);
  }

  #cull(x: number, z: number, force: boolean) {
    if (!force) {
      const dx = x - this.#last.x;
      const dz = z - this.#last.z;
      if (dx * dx + dz * dz < this.#moveSq) return;
    }
    this.#last.x = x;
    this.#last.z = z;
    for (const c of this.#chunks) {
      const dx = c.cx - x;
      const dz = c.cz - z;
      c.group.visible = dx * dx + dz * dz < this.#visSq;
    }
  }
}
