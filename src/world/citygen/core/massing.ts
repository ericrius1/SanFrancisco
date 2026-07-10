// Footprint-faithful massing — the "no shift" guarantee.
//
// Extrudes the REAL footprint from `base` to `top` so a generated building's
// silhouette equals its baked twin. Each polygon edge becomes a FacadeEdge that
// the theme's FacadeDecorator details (bay windows, cornice, storefront); a
// triangulated roof cap closes the top. If no decorator is supplied it falls back
// to a flat wall (Phase-1 shell). Pure geometry — no THREE, no textures.
import type { ArchetypeSpec, BuildingSpec, Panel, Vec2 } from "./types";
import { centroid, edgeOutwardNormal, ensureCCW, streetEdgeIndex, triangulate } from "./footprint";
import { PanelBuilder, defaultFlatWall, type FacadeDecorator, type FacadeEdge, type Vec3 } from "./facade";

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
  // grade = highest ground under the footprint; clamp into (base, top) so a lot
  // never loses its whole façade to a bad sample. Windows sit above this line.
  const grade = Math.min(Math.max(spec.grade ?? base, base), top - 1.5);
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
      p0, p1, base, top, grade, frontGround: spec.frontGround, floors, along, normal, length,
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

  // ---- rooftop clutter (flat roofs only): a stairwell bulkhead, a vent or two,
  //      and an occasional rooftop unit — so the roofscape reads from the air/hills
  //      instead of a bare slab. Deterministic, cheap (a handful of boxes). -------
  if (arch.roofType === "flat") roofProps(out, poly, cx, cz, top, edgeRng(spec.seed, 97), arch);

  const panels = out.panels();
  if (roof.indices.length) panels.push(roof);
  return { panels, floors, center: [cx, cz], base, top };
}

/** small deterministic rooftop props inside a footprint (flat roofs). */
function roofProps(out: PanelBuilder, poly: Vec2[], cx: number, cz: number, top: number, rng: () => number, arch: ArchetypeSpec): void {
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const [x, z] of poly) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (z < minz) minz = z; if (z > maxz) maxz = z; }
  const w = maxx - minx, d = maxz - minz;
  if (w < 4 || d < 4) return; // too small to clutter
  const X: Vec3 = [1, 0, 0], Y: Vec3 = [0, 1, 0], Z: Vec3 = [0, 0, 1];
  // keep props inside the footprint bbox with an inset (concave overhang is minor)
  const spot = (fx: number, fz: number): [number, number] => [
    Math.min(maxx - 0.9, Math.max(minx + 0.9, cx + fx)),
    Math.min(maxz - 0.9, Math.max(minz + 0.9, cz + fz)),
  ];
  // stairwell bulkhead near centre
  const [bx, bz] = spot((rng() - 0.5) * w * 0.3, (rng() - 0.5) * d * 0.3);
  out.box(arch.roofMaterial, [bx, top + 0.9, bz], [0.9, 0.9, 1.1], X, Y, Z, true);
  // a couple of low vents
  const nv = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < nv; i++) {
    const [vx, vz] = spot((rng() - 0.5) * w * 0.7, (rng() - 0.5) * d * 0.7);
    out.box("roof.flatTrim", [vx, top + 0.35, vz], [0.35, 0.35, 0.35], X, Y, Z, true);
  }
  // ~30%: a wooden rooftop water tank (a box on stubby legs, iconic on SF/Bay roofs)
  if (rng() < 0.3 && w > 6 && d > 6) {
    const [tx, tz] = spot((rng() - 0.5) * w * 0.5, (rng() - 0.5) * d * 0.5);
    out.box("int.wood", [tx, top + 1.5, tz], [0.7, 0.9, 0.7], X, Y, Z, true);          // tank
    out.box("int.wood", [tx, top + 0.35, tz], [0.75, 0.35, 0.75], X, Y, Z, false);     // frame base
  }
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
