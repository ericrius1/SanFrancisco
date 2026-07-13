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

// All chunks share one unlit depth-only material. The proxy meshes never enter
// the beauty camera, and their geometry is shared with the merged LOD mesh.
const shadowProxyMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
shadowProxyMaterial.name = "cityGenChunkShadowProxy.depth";
shadowProxyMaterial.toneMapped = false;

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

export function buildChunkLOD(specs: BuildingSpec[], opts?: ChunkLODOptions): ChunkLOD {
  const arr: PrismArrays = emptyArrays();
  const ground = opts?.groundHeight;
  const vertexRanges = new Map<number, { start: number; count: number }>();
  const hidden = new Set<number>();
  let cursor = 0;
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
        vertexRanges.set(s.i, { start, count: arr.pos.length / 3 - start });
      }
      if (cursor >= specs.length) {
        const g = geometryFrom(arr);
        const mesh = new THREE.Mesh(g, lodMaterial());
        mesh.name = "cityGenChunkLOD";
        mesh.castShadow = false;
        // Chunk prisms fill the skyline past the CSM far cascade (350 m) — receive
        // samples there are wasted bandwidth. Detail buildings still receive.
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
        mesh.matrixAutoUpdate = false; // geometry is world-space
        chunk.mesh = mesh;
        const shadowMesh = new THREE.Mesh(g, shadowProxyMaterial);
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
      (attr.array as Float32Array).fill(visible ? 1 : 0, range.start, range.start + range.count);
      attr.addUpdateRange(range.start, range.count);
      attr.needsUpdate = true;
    },
    dispose() {
      chunk.shadowMesh?.removeFromParent();
      chunk.shadowMesh = null;
      if (chunk.mesh) { chunk.mesh.geometry.dispose(); chunk.mesh = null; }
    },
  };
  return chunk;
}
