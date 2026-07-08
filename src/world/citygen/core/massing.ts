// Footprint-faithful massing — the heart of the "no shift" guarantee.
//
// Extrudes the REAL footprint polygon from `base` to `top`, so a generated
// building's silhouette is identical to its baked twin. Phase 1 emits a plain
// LOD1 shell: one quad wall per footprint edge + a triangulated roof cap. The
// split-grammar detail (bay windows, cornices, storefronts) plugs in at the
// façade level in Phase 2 — this file stays the mass/roof stage. Pure geometry,
// no THREE, no textures (portable core).
import type { ArchetypeSpec, BuildingSpec, Panel } from "./types";
import { centroid, edgeOutwardNormal, ensureCCW, triangulate } from "./footprint";

export interface Massing {
  panels: Panel[];
  /** storeys, derived from real height ÷ archetype floor height (≥1) */
  floors: number;
  /** footprint centroid + base/top, handy for placement / interiors */
  center: readonly [number, number];
  base: number;
  top: number;
}

const UV_SCALE = 3.0; // metres per UV unit — keeps wall texel density uniform

/** Build the LOD1 shell for one building. */
export function massBuilding(spec: BuildingSpec, arch: ArchetypeSpec): Massing {
  const poly = ensureCCW(spec.poly);
  const base = spec.base;
  const top = spec.top;
  const height = Math.max(0.1, top - base);
  const floors = Math.max(1, Math.round(height / arch.floorH));

  const walls: Panel = { materialId: arch.wallMaterial, positions: [], normals: [], uvs: [], indices: [] };
  const roof: Panel = { materialId: arch.roofMaterial, positions: [], normals: [], uvs: [], indices: [] };

  // ---- walls: one quad per edge, base→top ----------------------------------
  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % poly.length];
    const [nx, nz] = edgeOutwardNormal(p0, p1);
    const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const u0 = 0, u1 = segLen / UV_SCALE;
    const v0 = 0, v1 = height / UV_SCALE;
    const b = walls.positions.length / 3;
    // four corners: p0-bottom, p1-bottom, p1-top, p0-top
    walls.positions.push(
      p0[0], base, p0[1],
      p1[0], base, p1[1],
      p1[0], top, p1[1],
      p0[0], top, p0[1],
    );
    for (let k = 0; k < 4; k++) walls.normals.push(nx, 0, nz);
    walls.uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
    walls.indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }

  // ---- roof cap: triangulated top polygon (handles concave footprints) -----
  const tris = triangulate(poly);
  const rb = roof.positions.length / 3;
  const [cx, cz] = centroid(poly);
  for (const [x, z] of poly) {
    roof.positions.push(x, top, z);
    roof.normals.push(0, 1, 0);
    roof.uvs.push((x - cx) / UV_SCALE, (z - cz) / UV_SCALE);
  }
  for (const t of tris) roof.indices.push(rb + t);

  const panels: Panel[] = [];
  if (walls.indices.length) panels.push(walls);
  if (roof.indices.length) panels.push(roof);
  return { panels, floors, center: [cx, cz], base, top };
}
