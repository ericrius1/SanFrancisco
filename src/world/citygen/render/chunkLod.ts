// Per-tile merged LOD chunk — every generated building in one tile cell baked
// into ONE mesh sharing ONE material, so the far city is ~a couple dozen draw
// calls instead of thousands. Built INCREMENTALLY (a slice of buildings per pump)
// so crossing a tile boundary never hitches; the caller swaps the baked meshes for
// this chunk only once it's finished (no hole while it builds).
import * as THREE from "three/webgpu";
import type { BuildingSpec } from "../core/types";
import { appendPrism, emptyArrays, geometryFrom, lodMaterial, type PrismArrays } from "./lod";

export interface ChunkLOD {
  /** finished merged mesh, or null while still building */
  mesh: THREE.Mesh | null;
  done: boolean;
  /** append up to `budget` more buildings; sets mesh + done when finished */
  pump(budget: number): void;
  dispose(): void;
}

export function buildChunkLOD(specs: BuildingSpec[]): ChunkLOD {
  const arr: PrismArrays = emptyArrays();
  let cursor = 0;
  const chunk: ChunkLOD = {
    mesh: null,
    done: specs.length === 0,
    pump(budget: number) {
      if (chunk.done) return;
      const end = Math.min(specs.length, cursor + budget);
      for (; cursor < end; cursor++) appendPrism(specs[cursor], arr);
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
