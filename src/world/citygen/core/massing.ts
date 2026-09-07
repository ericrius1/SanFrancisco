// Footprint-faithful massing — the "no shift" guarantee.
//
// Extrudes the REAL footprint from `base` to `top` so a generated building's
// silhouette equals its baked twin. Each polygon edge becomes a FacadeEdge that
// the theme's FacadeDecorator details (bay windows, cornice, storefront); a
// triangulated roof cap closes the top. If no decorator is supplied it falls back
// to a flat wall (Phase-1 shell). Pure geometry — no THREE, no textures.
import type { ArchetypeSpec, BuildingSpec, ModuleInstance, Panel, Vec2 } from "./types";
import { centroid, edgeOutwardNormal, ensureCCW, streetEdgeIndex, triangulate } from "./footprint";
import { roofVolumes } from "./roof";
import { PanelBuilder, defaultFlatWall, pointOnWall, type FacadeDecorator, type FacadeEdge, type Vec3 } from "./facade";

export interface Massing {
  panels: Panel[];
  /** kit-of-parts window instances (drawn instanced; see core/types.ModuleInstance) */
  instances: ModuleInstance[];
  /** material-id table the instances index into */
  matTable: string[];
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
  // foot = lowest ground the walls must reach, sampled OUTSIDE the footprint
  // (render/foundation.ts). Never above `base`, which the façades already cover.
  const foot = Math.min(spec.foot ?? base, base);
  // Visible storeys begin at live grade, matching the doorway sill, interiors
  // and chunk-LOD window grid. Counting from the buried low foundation shifted
  // upper facade bands down across raised doors on hillsides.
  const floors = Math.max(1, Math.round(Math.max(0.1, top - grade) / arch.floorH));
  const streetI = streetEdgeIndex(poly, spec.streetEdge);

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
      isStreet: i === streetI, doorAllowed: spec.doorAllowed, arch,
    };
    // Seed salt per edge so each face varies but stays deterministic.
    decorate(edge, out, edgeRng(spec.seed, i));
    // ---- foundation skirt: plain wall from `foot` up to the baked `base` -----
    // The façade above starts at `base`, which is the lowest ground the BAKE
    // found INSIDE the footprint. A lot on a cliff lip (Point Lobos above Sutro
    // Baths) drops away just outside its own edges, so that wall bottom hangs in
    // the air on the downhill side. This is the same skirt the chunk LOD has
    // always drawn (render/lod.ts appendPrism) — the near tier simply never grew
    // one. Undecorated on purpose: it is below the ground line, so it must never
    // carry windows or storefront detail.
    if (base > foot + 0.05) {
      const n: Vec3 = [normal[0], 0, normal[1]];
      out.quad(
        arch.baseMaterial ?? arch.wallMaterial,
        pointOnWall(edge, 0, foot), pointOnWall(edge, 1, foot),
        pointOnWall(edge, 1, base), pointOnWall(edge, 0, base),
        n,
      );
    }
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
  // A CCW polygon in XZ faces -Y in Three's XYZ basis. Keep the actual
  // triangle front aligned with its +Y normal: DoubleSide otherwise flips the
  // normal when viewed from above and incorrectly shades the roof from below.
  for (let i = 0; i < tris.length; i += 3) roof.indices.push(tris[i], tris[i + 2], tris[i + 1]);

  // ---- rooftop clutter (flat roofs only): a stairwell bulkhead, a vent or two,
  //      and an occasional rooftop unit — so the roofscape reads from the air/hills
  //      instead of a bare slab. Deterministic, cheap (a handful of boxes). -------
  if (arch.roofType === "flat") {
    for (const volume of roofVolumes(poly, top, spec.seed, arch)) {
      out.box(volume.materialId, volume.center, volume.half, [1, 0, 0], [0, 1, 0], [0, 0, 1], false, volume.skipBottom);
    }
  }

  const panels = out.panels();
  if (roof.indices.length) panels.push(roof);
  return { panels, instances: out.moduleInstances(), matTable: out.matTable(), floors, center: [cx, cz], base, top };
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
