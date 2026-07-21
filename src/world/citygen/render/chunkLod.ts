// Per-tile merged LOD chunk — every generated building in one tile cell baked
// into ONE mesh sharing ONE material, so the far city is ~a couple dozen draw
// calls instead of thousands. Built INCREMENTALLY (a slice of buildings per pump)
// so crossing a tile boundary never hitches; the caller swaps the baked meshes for
// this chunk only once it's finished (no hole while it builds).
import * as THREE from "three/webgpu";
import type { BuildingSpec } from "../core/types";
import { appendPrism, emptyArrays, geometryFrom, lodMaterial, type PrismArrays } from "./lod";
import { footprintGrade, type GroundSampler } from "./foundation";
import { setLocalFarShadowOnly } from "../../shadows/shadowLayers";
import {
  materialDisposeListenerCount,
  registerSharedMaterialLeakCounter,
  releaseRenderObjectsFor,
} from "../../../render/renderObjectRegistry";

// All chunks share one unlit depth-only material. The proxy meshes never enter
// the beauty camera, and their geometry is shared with the merged LOD mesh.
// M9: retired cells release their RenderObjects explicitly in dispose() —
// sharing the material otherwise pins them in its dispose-listener array
// forever (geometry dispose alone never frees a RenderObject in r185).
const shadowProxyMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
shadowProxyMaterial.name = "cityGenChunkShadowProxy.depth";
shadowProxyMaterial.toneMapped = false;

registerSharedMaterialLeakCounter("cityGenChunkShadowDepth", () =>
  materialDisposeListenerCount(shadowProxyMaterial)
);

export interface ChunkLOD {
  /** finished merged mesh, or null while still building */
  mesh: THREE.Mesh | null;
  /** stable shadow-only massing, independent of beauty/detail visibility */
  shadowMesh: THREE.Mesh | null;
  done: boolean;
  /** append up to `budget` more buildings; sets mesh + done when finished */
  pump(budget: number): void;
  /** Selectively discard/restore one merged prism without splitting the draw. */
  setBuildingVisible(index: number, visible: boolean): void;
  /** Restart this cell's shared-material birth/growth at an actual gate show. */
  markVisibleBirth(time: number): void;
  dispose(): void;
}

export interface ChunkLODOptions {
  /** Optional LIVE terrain sampler. When supplied, every merged building is
   *  conformed to terrain: its windowed wall + roof start at the HIGHEST ground
   *  under the footprint (no uphill window buried into the slope) and a plain
   *  foundation skirt drops to the LOWEST ground (no downhill float). Omit for the
   *  legacy baked-`base` behaviour (identical output to before). A few samples per
   *  building — cheap enough for the ~260 buildings/frame merge budget.
   *  NOTE: pass a bound fn — e.g. `(x, z) => map.groundHeight(x, z)` — so `this`
   *  survives; a bare method reference would lose its receiver. */
  groundHeight?: GroundSampler;
}

/** Exact beauty owner used to compile the merged chunk-LOD node graph while
 * detached. Live cells use the same SHARED material (M6), so the prepared
 * pipeline is reused without retaining a full city cell. The shadow proxy
 * intentionally stays out: it uses the generic depth-only shadow path. */
export function createChunkLODBeautyWarmup(): { object: THREE.Mesh; dispose(): void } {
  const arrays = emptyArrays();
  appendPrism({
    i: -1,
    id: -1,
    poly: [[0, 0], [1, 0], [1, 1], [0, 1]],
    base: 0,
    top: 3,
    archetype: "victorian",
    seed: 1,
  }, arrays);
  const geometry = geometryFrom(arrays);
  // M6: warm the exact SHARED material live cells now use (no clone — see
  // buildChunkLOD). dispose() releases the warmup RenderObject explicitly.
  const material = lodMaterial();
  const object = new THREE.Mesh(geometry, material);
  object.name = "cityGenChunkLOD.warmup";
  object.castShadow = false;
  object.receiveShadow = false;
  object.frustumCulled = false;
  object.matrixAutoUpdate = false;
  return {
    object,
    dispose() {
      object.removeFromParent();
      // M9: the warmup RenderObject would otherwise stay listed on the shared
      // material (geometry dispose alone never releases it).
      releaseRenderObjectsFor(object);
      geometry.dispose();
    },
  };
}

export function buildChunkLOD(specs: BuildingSpec[], opts?: ChunkLODOptions): ChunkLOD {
  const arr: PrismArrays = emptyArrays();
  const ground = opts?.groundHeight;
  const vertexRanges = new Map<number, { start: number; count: number; visibleValue: number }>();
  const hidden = new Set<number>();
  let cursor = 0;
  let beautyMaterial: THREE.Material | null = null;
  let cellShadowMaterial: THREE.Material | null = null;
  const chunk: ChunkLOD = {
    mesh: null,
    shadowMesh: null,
    done: specs.length === 0,
    pump(budget: number) {
      if (chunk.done) return;
      const end = Math.min(specs.length, cursor + budget);
      for (; cursor < end; cursor++) {
        const s = specs[cursor];
        const start = arr.pos.length / 3;
        // conform to live terrain when a sampler was provided; else legacy path
        if (ground) appendPrism(s, arr, footprintGrade(s.poly, s.base, s.top, ground));
        else appendPrism(s, arr);
        vertexRanges.set(s.i, {
          start,
          count: arr.pos.length / 3 - start,
          visibleValue: arr.vis[start] ?? 1,
        });
      }
      if (cursor >= specs.length) {
        const g = geometryFrom(arr);
        // M6: share the process-wide materials. Per-cell material CLONES gave
        // every published cell fresh material identities, and the next static
        // shadow redraw (and first beauty draw) paid a fresh node build + GPU
        // pipeline per clone — ~250 ms GPU per redraw during district
        // streaming (the measured hitch storm). M9 correction: geometry
        // dispose does NOT release RenderObjects (r185 onGeometryDispose only
        // nulls attribute caches) — dispose() below releases the cell's
        // RenderObjects explicitly so the shared materials never accumulate
        // retired cells in their dispose-listener arrays.
        beautyMaterial = lodMaterial();
        cellShadowMaterial = shadowProxyMaterial;
        const mesh = new THREE.Mesh(g, beautyMaterial);
        mesh.name = "cityGenChunkLOD";
        mesh.castShadow = false;
        // Chunk prisms fill the skyline past the CSM far cascade (350 m) — receive
        // samples there are wasted bandwidth. Detail buildings still receive.
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
        mesh.matrixAutoUpdate = false; // geometry is world-space
        chunk.mesh = mesh;
        const shadowMesh = new THREE.Mesh(g, cellShadowMaterial);
        shadowMesh.name = "cityGenChunkShadowProxy";
        shadowMesh.castShadow = true;
        shadowMesh.receiveShadow = false;
        shadowMesh.frustumCulled = true;
        shadowMesh.matrixAutoUpdate = false; // geometry is world-space
        setLocalFarShadowOnly(shadowMesh);
        chunk.shadowMesh = shadowMesh;
        const visibility = g.getAttribute("lodVisibility") as THREE.BufferAttribute;
        visibility.setUsage(THREE.DynamicDrawUsage);
        for (const index of hidden) {
          const range = vertexRanges.get(index);
          if (range) (visibility.array as Float32Array).fill(0, range.start, range.start + range.count);
        }
        if (hidden.size) visibility.needsUpdate = true;
        chunk.done = true;
        // free the scratch arrays
        arr.pos.length = arr.nor.length = arr.uvs.length = arr.col.length = arr.vis.length = arr.idx.length = 0;
      }
    },
    setBuildingVisible(index, visible) {
      if (visible) hidden.delete(index); else hidden.add(index);
      const range = vertexRanges.get(index);
      const attr = chunk.mesh?.geometry.getAttribute("lodVisibility") as THREE.BufferAttribute | undefined;
      if (!range || !attr) return;
      (attr.array as Float32Array).fill(visible ? range.visibleValue : 0, range.start, range.start + range.count);
      attr.addUpdateRange(range.start, range.count);
      attr.needsUpdate = true;
    },
    markVisibleBirth(time) {
      if (chunk.mesh) chunk.mesh.userData.materializeBirthTime = time;
    },
    dispose() {
      // M9: release BOTH meshes' RenderObjects (beauty + shadow pass entries)
      // before dropping refs — the shared singleton materials would otherwise
      // retain them (and the merged cell geometry arrays) forever. Never
      // dispose the materials themselves here.
      if (chunk.shadowMesh) {
        chunk.shadowMesh.removeFromParent();
        releaseRenderObjectsFor(chunk.shadowMesh);
        chunk.shadowMesh = null;
      }
      if (chunk.mesh) {
        releaseRenderObjectsFor(chunk.mesh);
        chunk.mesh.geometry.dispose();
        chunk.mesh = null;
      }
      beautyMaterial = null;
      cellShadowMaterial = null;
    },
  };
  return chunk;
}
