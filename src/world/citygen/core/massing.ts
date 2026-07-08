// Footprint-faithful massing — the "no shift" guarantee.
//
// Extrudes the REAL footprint from `base` to `top` so a generated building's
// silhouette equals its baked twin. Each polygon edge becomes a FacadeEdge that
// the theme's FacadeDecorator details (bay windows, cornice, storefront); a
// triangulated roof cap closes the top. If no decorator is supplied it falls back
// to a flat wall (Phase-1 shell). Pure geometry — no THREE, no textures.
import type { ArchetypeSpec, BuildingSpec, Panel, Vec2 } from "./types";
import { centroid, edgeOutwardNormal, ensureCCW, streetEdgeIndex, triangulate } from "./footprint";
import { PanelBuilder, defaultFlatWall, type FacadeDecorator, type FacadeEdge } from "./facade";

export interface Massing {
  panels: Panel[];
  /** storeys, derived from real height ÷ archetype floor height (≥1) */
  floors: number;
  /** footprint centroid + base/top, handy for placement / interiors */
  center: readonly [number, number];
  base: number;
  top: number;
}

const UV_SCALE = 3.0;

/** Build the detailed shell for one building. `decorate` = the theme's façade
 *  authoring hook; omit for the plain Phase-1 flat shell. */
export function massBuilding(spec: BuildingSpec, arch: ArchetypeSpec, decorate: FacadeDecorator = defaultFlatWall): Massing {
  const poly = ensureCCW(spec.poly);
  const base = spec.base;
  const top = spec.top;
  const height = Math.max(0.1, top - base);
  const floors = Math.max(1, Math.round(height / arch.floorH));
  const streetI = streetEdgeIndex(poly);

  const out = new PanelBuilder();

  // ---- façades: one FacadeEdge per polygon edge, detailed by the theme ------
  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % poly.length];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const length = Math.hypot(dx, dz);
    if (length < 0.2) continue;
    const along: Vec2 = [dx / length, dz / length];
    const normal = edgeOutwardNormal(p0, p1);
    const edge: FacadeEdge = {
      p0, p1, base, top, floors, along, normal, length,
      isStreet: i === streetI, arch,
    };
    // Seed salt per edge so each face varies but stays deterministic.
    decorate(edge, out, edgeRng(spec.seed, i));
  }

  // ---- roof cap: triangulated top polygon (handles concave footprints) -----
  const roof: Panel = { materialId: arch.roofMaterial, positions: [], normals: [], uvs: [], indices: [] };
  const tris = triangulate(poly);
  const [cx, cz] = centroid(poly);
  for (const [x, z] of poly) {
    roof.positions.push(x, top, z);
    roof.normals.push(0, 1, 0);
    roof.uvs.push((x - cx) / UV_SCALE, (z - cz) / UV_SCALE);
  }
  for (const t of tris) roof.indices.push(t);

  const panels = out.panels();
  if (roof.indices.length) panels.push(roof);
  return { panels, floors, center: [cx, cz], base, top };
}

// local mulberry32 salted per edge (avoids importing rng cycle concerns)
function edgeRng(seed: number, salt: number): () => number {
  let a = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
