// Merge panels sharing a material id into typed geometry arrays — the format a
// THREE.BufferGeometry (and the host's BatchedMesh/merge pool) consumes. Pure:
// takes Panels, returns MeshData; never touches the scene. The host wraps each
// MeshData in a BufferGeometry + the theme's resolved material.
import type { MeshData, Panel } from "./types";

/** Group panels by material id and pack each group into one MeshData. */
export function mergePanels(panels: Panel[]): MeshData[] {
  const byMat = new Map<string, Panel[]>();
  for (const p of panels) {
    let list = byMat.get(p.materialId);
    if (!list) byMat.set(p.materialId, (list = []));
    list.push(p);
  }

  const out: MeshData[] = [];
  for (const [materialId, group] of byMat) {
    let nVerts = 0, nIdx = 0;
    for (const p of group) { nVerts += p.positions.length / 3; nIdx += p.indices.length; }
    const positions = new Float32Array(nVerts * 3);
    const normals = new Float32Array(nVerts * 3);
    const uvs = new Float32Array(nVerts * 2);
    const indices = new Uint32Array(nIdx);
    let vo = 0, io = 0; // vertex offset (in verts), index write cursor
    for (const p of group) {
      positions.set(p.positions, vo * 3);
      normals.set(p.normals, vo * 3);
      uvs.set(p.uvs, vo * 2);
      for (let k = 0; k < p.indices.length; k++) indices[io + k] = p.indices[k] + vo;
      vo += p.positions.length / 3;
      io += p.indices.length;
    }
    out.push({ materialId, positions, normals, uvs, indices });
  }
  return out;
}
