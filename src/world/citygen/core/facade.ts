// Split-grammar façade primitives (CGA-style), city-agnostic. A theme's
// FacadeDecorator receives one wall segment (FacadeEdge) + a PanelBuilder and
// authors the detail: split into floors, repeat bays, protrude bay-window boxes,
// cap with a cornice. No THREE, no textures — just geometry pushed into panels
// keyed by material id. The host resolves material ids to real materials.
//
// Frame: world metres, Y up. A wall segment runs from p0→p1 along the ground; a
// point on the wall plane is `pointOnWall(edge, t, y)` for t∈[0,1] along the
// segment and world height y; `outset` pushes a point out along the wall's
// outward normal (bay windows, cornices project outward).
import type { ArchetypeSpec, Panel, Vec2 } from "./types";

export interface FacadeEdge {
  /** endpoints of the wall segment on the ground (x,z) */
  p0: Vec2;
  p1: Vec2;
  base: number;
  top: number;
  /** highest ground line under the building — no window/ground-floor detail is
   *  drawn below this (defaults to base on flat lots). The wall itself still runs
   *  base→top; only detail respects grade, so a sloped lot keeps a solid skirt
   *  instead of half-buried windows. */
  grade: number;
  /** live terrain just outside the street door (host-supplied; defaults to base).
   *  The front stoop reads this so its steps match the walkable ramp collider. */
  frontGround?: number;
  floors: number;
  /** unit direction p0→p1 in x/z */
  along: Vec2;
  /** unit OUTWARD normal in x/z */
  normal: Vec2;
  /** segment length (metres) */
  length: number;
  /** true = this face fronts the street (gets the full treatment) */
  isStreet: boolean;
  /** the archetype spec (material ids, floorH, grammar params) for this building */
  arch: ArchetypeSpec;
}

export type Vec3 = [number, number, number];

/** world point on the wall plane at fraction t along the segment, height y */
export function pointOnWall(e: FacadeEdge, t: number, y: number): Vec3 {
  const d = t * e.length;
  return [e.p0[0] + e.along[0] * d, y, e.p0[1] + e.along[1] * d];
}

/** push a world point outward along the edge normal by `d` metres */
export function outset(p: Vec3, e: FacadeEdge, d: number): Vec3 {
  return [p[0] + e.normal[0] * d, p[1], p[2] + e.normal[1] * d];
}

const UV_SCALE = 3.0;

/** Accumulates geometry into one Panel per material id. */
export class PanelBuilder {
  #byMat = new Map<string, Panel>();

  #panel(matId: string): Panel {
    let p = this.#byMat.get(matId);
    if (!p) this.#byMat.set(matId, (p = { materialId: matId, positions: [], normals: [], uvs: [], indices: [] }));
    return p;
  }

  /** a quad given four world corners in CCW order (bl, br, tr, tl) + a normal.
   *  UVs come from the quad's own width/height so texel density stays uniform. */
  quad(matId: string, bl: Vec3, br: Vec3, tr: Vec3, tl: Vec3, n: Vec3): void {
    const p = this.#panel(matId);
    const b = p.positions.length / 3;
    const w = Math.hypot(br[0] - bl[0], br[1] - bl[1], br[2] - bl[2]) / UV_SCALE;
    const h = Math.hypot(tl[0] - bl[0], tl[1] - bl[1], tl[2] - bl[2]) / UV_SCALE;
    p.positions.push(bl[0], bl[1], bl[2], br[0], br[1], br[2], tr[0], tr[1], tr[2], tl[0], tl[1], tl[2]);
    for (let k = 0; k < 4; k++) p.normals.push(n[0], n[1], n[2]);
    p.uvs.push(0, 0, w, 0, w, h, 0, h);
    p.indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }

  /**
   * An oriented box from a center, with basis vectors (unit `along`, `up`,
   * `normal`) and half-sizes on each. `skipBack` drops the -normal face (used for
   * bay windows flush against the wall so no z-fighting interior face renders).
   */
  box(matId: string, center: Vec3, half: Vec3, along: Vec3, up: Vec3, normal: Vec3, skipBack = false): void {
    const s = (a: number, u: number, n: number): Vec3 => [
      center[0] + along[0] * a + up[0] * u + normal[0] * n,
      center[1] + along[1] * a + up[1] * u + normal[1] * n,
      center[2] + along[2] * a + up[2] * u + normal[2] * n,
    ];
    const [ha, hu, hn] = half;
    // 8 corners
    const c = {
      lbf: s(-ha, -hu, hn), rbf: s(ha, -hu, hn),
      rtf: s(ha, hu, hn), ltf: s(-ha, hu, hn),
      lbb: s(-ha, -hu, -hn), rbb: s(ha, -hu, -hn),
      rtb: s(ha, hu, -hn), ltb: s(-ha, hu, -hn),
    };
    const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
    this.quad(matId, c.lbf, c.rbf, c.rtf, c.ltf, normal);                 // front (+n)
    this.quad(matId, c.lbf, c.ltf, c.ltb, c.lbb, neg(along));             // left (-a)
    this.quad(matId, c.rbf, c.rbb, c.rtb, c.rtf, along);                  // right (+a)
    this.quad(matId, c.ltf, c.rtf, c.rtb, c.ltb, up);                     // top (+u)
    this.quad(matId, c.lbb, c.rbb, c.rbf, c.lbf, neg(up));                // bottom (-u)
    if (!skipBack) this.quad(matId, c.rbb, c.lbb, c.ltb, c.rtb, neg(normal)); // back (-n)
  }

  panels(): Panel[] {
    return [...this.#byMat.values()].filter((p) => p.indices.length > 0);
  }
}

import type { Rng } from "./rng";

/** A theme authors one wall segment's detail into `out`. Pure + deterministic
 *  (all variation from `rng`). This is the ONLY hook a city theme needs to
 *  implement to control façade look; core/massing calls it per polygon edge. */
export type FacadeDecorator = (edge: FacadeEdge, out: PanelBuilder, rng: Rng) => void;

/** Fallback decorator: one flat quad from base to top (the Phase-1 shell look). */
export const defaultFlatWall: FacadeDecorator = (e, out) => {
  const n: Vec3 = [e.normal[0], 0, e.normal[1]];
  out.quad(e.arch.wallMaterial, pointOnWall(e, 0, e.base), pointOnWall(e, 1, e.base), pointOnWall(e, 1, e.top), pointOnWall(e, 0, e.top), n);
};

/** even floor bands between base and top */
export function floorBands(e: FacadeEdge): { y0: number; y1: number; i: number }[] {
  const out: { y0: number; y1: number; i: number }[] = [];
  const h = (e.top - e.base) / e.floors;
  for (let i = 0; i < e.floors; i++) out.push({ y0: e.base + i * h, y1: e.base + (i + 1) * h, i });
  return out;
}

/** integer bay count for a target bay width, ≥1 */
export function bayCount(e: FacadeEdge, targetWidth: number): number {
  return Math.max(1, Math.round(e.length / targetWidth));
}

/** Lift a windowsill / ground-floor detail bottom to the grade line so nothing is
 *  drawn below the highest ground under the building (the buried-window fix). A
 *  small margin keeps the sill trim clear of the dirt. */
export function aboveGrade(e: FacadeEdge, y0: number): number {
  return Math.max(y0, e.grade + 0.15);
}
