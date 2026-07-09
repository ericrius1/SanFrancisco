// Per-tile merged LOD chunk — every generated building in one tile cell baked
// into ONE mesh sharing ONE material, so the far city is ~a couple dozen draw
// calls instead of thousands. Built INCREMENTALLY (a slice of buildings per pump)
// so crossing a tile boundary never hitches; the caller swaps the baked meshes for
// this chunk only once it's finished (no hole while it builds).
import * as THREE from "three/webgpu";
import type { BuildingSpec } from "../core/types";
import { appendPrism, emptyArrays, geometryFrom, lodMaterial, type PrismArrays } from "./lod";
import { footprintGrade, type GroundSampler } from "./foundation";

export interface ChunkLOD {
  /** finished merged mesh, or null while still building */
  mesh: THREE.Mesh | null;
  done: boolean;
  /** append up to `budget` more buildings; sets mesh + done when finished */
  pump(budget: number): void;
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
  let cursor = 0;
  const chunk: ChunkLOD = {
    mesh: null,
    done: specs.length === 0,
    pump(budget: number) {
      if (chunk.done) return;
      const end = Math.min(specs.length, cursor + budget);
      for (; cursor < end; cursor++) {
        const s = specs[cursor];
        // conform to live terrain when a sampler was provided; else legacy path
        if (ground) appendPrism(s, arr, footprintGrade(s.poly, s.base, s.top, ground));
        else appendPrism(s, arr);
      }
      if (cursor >= specs.length) {
        const g = geometryFrom(arr);
        const mesh = new THREE.Mesh(g, lodMaterial());
        mesh.name = "cityGenChunkLOD";
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        mesh.matrixAutoUpdate = false; // geometry is world-space
        chunk.mesh = mesh;
        chunk.done = true;
        // free the scratch arrays
        arr.pos.length = arr.nor.length = arr.uvs.length = arr.col.length = arr.idx.length = 0;
      }
    },
    dispose() {
      if (chunk.mesh) { chunk.mesh.geometry.dispose(); chunk.mesh = null; }
    },
  };
  return chunk;
}
