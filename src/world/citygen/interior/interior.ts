// Walkable Victorian interior — a PURE FUNCTION of (spec). Built lazily only when
// the player actually steps inside (the ring gates it on the footprint), and
// thrown away when they leave, so nothing pays for an interior nobody is in.
//
// What it builds, in world space (same frame as the exterior, so no transform):
//   • a floor slab per storey (you stand on each floor) with a warm ceiling glow,
//   • a switchback stair threading every floor (real step colliders — you climb it),
//   • a little parlour/apartment furniture per floor (emissive-lit),
//   • no interior walls — the exterior shell is DoubleSide, so its inner face is
//     the room wall for free.
// Determinism: all variation from spec.seed via mulberry32. Emissive-only lighting
// (no THREE lights — the app has a fixed LightPool).
import type { BuildingSpec, ColliderBox, Panel } from "../core/types";
import { PanelBuilder, type Vec3 } from "../core/facade";
import { ensureCCW, triangulate } from "../core/footprint";
import { rng, type Rng } from "../core/rng";

export interface BuiltInterior {
  panels: Panel[];
  colliders: ColliderBox[];
  floors: number;
}

const FLOOR_H = 3.4;
const MAX_FLOORS = 4;      // furnish at most ground + 3 up (mesh/collider budget)
const SLAB = 0.12;         // floor slab half-thickness

function bbox(poly: readonly (readonly [number, number])[]) {
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const [x, z] of poly) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (z < minz) minz = z; if (z > maxz) maxz = z; }
  return { minx, maxx, minz, maxz, w: maxx - minx, d: maxz - minz };
}

/** a solid emissive/box piece of furniture + its collider */
function furn(out: PanelBuilder, cols: ColliderBox[], mat: string, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, collide = true): void {
  out.box(mat, [cx, cy, cz], [hx, hy, hz], [1, 0, 0], [0, 1, 0], [0, 0, 1], false);
  if (collide) cols.push({ x: cx, y: cy, z: cz, hx, hy, hz, yaw: 0 });
}

/** a flat horizontal floor laid from the footprint triangulation at height y */
function slab(out: PanelBuilder, mat: string, poly: readonly (readonly [number, number])[], tris: number[], y: number): void {
  const verts: Vec3[] = poly.map(([x, z]) => [x, y, z]);
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const a = verts[tris[t]], c = verts[tris[t + 1]], d = verts[tris[t + 2]];
    out.quad(mat, a, c, d, a, [0, 1, 0]); // 4th pt = 1st → one triangle (2nd is degenerate)
  }
}

export function buildVictorianInterior(spec: BuildingSpec): BuiltInterior {
  const poly = ensureCCW(spec.poly);
  const tris = triangulate(poly);
  const bb = bbox(poly);
  const base = spec.base;
  const height = spec.top - spec.base;
  const nFloors = Math.max(1, Math.min(MAX_FLOORS, Math.round(height / FLOOR_H)));
  const r: Rng = rng(spec.seed, 202);
  const out = new PanelBuilder();
  const cols: ColliderBox[] = [];

  const cx = (bb.minx + bb.maxx) / 2, cz = (bb.minz + bb.maxz) / 2;

  // ---- floor slabs (stand on each storey) + ceiling glow ---------------------
  for (let i = 0; i < nFloors; i++) {
    const y = base + i * FLOOR_H;
    slab(out, "int.floor", poly, tris, y + SLAB);
    // floor collider = footprint bbox slab (concave overhang is minor indoors)
    cols.push({ x: cx, y: y, z: cz, hx: bb.w / 2, hy: SLAB, hz: bb.d / 2, yaw: 0 });
    // warm ceiling glow just under the next floor
    const gy = base + (i + 1) * FLOOR_H - 0.12;
    out.box("int.glow", [cx, gy, cz], [Math.min(1.2, bb.w * 0.3), 0.04, Math.min(1.2, bb.d * 0.3)], [1, 0, 0], [0, 1, 0], [0, 0, 1], false);
  }

  // ---- switchback stair in the back-left corner, floor to floor --------------
  const stairW = 1.0;
  const sx0 = bb.minx + 0.4, sz0 = bb.minz + 0.4;
  for (let i = 0; i < nFloors - 1; i++) {
    const y0 = base + i * FLOOR_H + SLAB;
    const steps = 8, rise = (FLOOR_H) / steps, run = 0.28;
    for (let s = 0; s < steps; s++) {
      const sy = y0 + rise * (s + 0.5);
      const sxc = sx0 + stairW / 2;
      const szc = sz0 + run * (s + 0.5);
      furn(out, cols, "int.wood", sxc, sy, szc, stairW / 2, rise / 2, run / 2);
    }
  }

  // ---- furniture per storey (parlour on ground, apartments above) -----------
  for (let i = 0; i < nFloors; i++) {
    const y = base + i * FLOOR_H + SLAB;
    // hug the +x wall so the stair/entry stays clear
    const fx = bb.maxx - 1.0;
    if (i === 0) {
      // parlour: sofa + low table + fireplace glow
      furn(out, cols, "int.sofa", fx, y + 0.35, cz + 0.6, 0.9, 0.35, 0.4);
      furn(out, cols, "int.wood", fx - 0.1, y + 0.25, cz - 0.6, 0.5, 0.25, 0.35);
      furn(out, cols, "int.glow", bb.minx + 0.5, y + 0.6, cz, 0.15, 0.6, 0.5, false); // hearth
    } else {
      // apartment: bed + dresser
      furn(out, cols, "int.sofa", fx, y + 0.3, cz + 0.7, 0.95, 0.3, 0.6);
      furn(out, cols, "int.wood", fx, y + 0.45, cz - 0.9, 0.5, 0.45, 0.3);
    }
    if (r() < 0.5) furn(out, cols, "int.wood", cx + (r() - 0.5) * bb.w * 0.4, y + 0.4, cz + (r() - 0.5) * bb.d * 0.4, 0.35, 0.4, 0.35);
  }

  return { panels: out.panels(), colliders: cols, floors: nFloors };
}
