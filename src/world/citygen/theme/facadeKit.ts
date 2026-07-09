// Shared façade components used by every SF archetype decorator (Victorian,
// Marina, downtown, SoMa …). Built on the core grammar primitives; each piece
// projects PROUD of the flat wall quad so it reads (a recessed piece would be
// occluded by the wall). Pure geometry, no THREE.
import {
  type FacadeEdge, type Vec3, PanelBuilder, pointOnWall, floorBands, bayCount, aboveGrade,
} from "../core/facade";
import { doorMetrics } from "../core/collider";

// ---- vector helpers ---------------------------------------------------------
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]) || 1;
export const unit = (a: Vec3): Vec3 => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const UP: Vec3 = [0, 1, 0];
/** ground point at fraction t along the edge (y placeholder = 0) */
export const gp = (e: FacadeEdge, t: number): Vec3 => pointOnWall(e, t, 0);

export interface WinMats { frame: string; glass: string; trim: string }

/**
 * A framed, divided-lite window on a face (ground points a→b, y0..y1, outward n).
 * Dark glass proud of the wall + white muntins + frame surround + sill + crown.
 * `arched` adds a shallow arched head (Mediterranean).
 */
export function faceWindow(out: PanelBuilder, a: Vec3, b: Vec3, y0: number, y1: number, n: Vec3, m: WinMats, arched = false): void {
  const along = unit(sub(b, a));
  const W = len(sub(b, a));
  if (W < 0.5 || y1 - y0 < 0.6) return;
  const cA = lerp(a, b, 0.5), midY = (y0 + y1) / 2;
  const off = (p: Vec3, d: number): Vec3 => [p[0] + n[0] * d, p[1], p[2] + n[2] * d];
  const gd = 0.03, md_ = 0.05, fw = 0.05, inset = 0.06;
  const gc = (t: number, yy: number): Vec3 => off([a[0] + (b[0] - a[0]) * t, yy, a[2] + (b[2] - a[2]) * t], gd);
  const gt0 = inset / W, gt1 = 1 - inset / W, gy0 = y0 + inset, gy1 = y1 - inset;
  out.quad(m.glass, gc(gt0, gy0), gc(gt1, gy0), gc(gt1, gy1), gc(gt0, gy1), n);
  // muntin cross
  out.box(m.trim, [cA[0] + n[0] * md_, midY, cA[2] + n[2] * md_], [W / 2 - inset, 0.02, 0.012], along, UP, n, true);
  out.box(m.trim, [cA[0] + n[0] * md_, midY, cA[2] + n[2] * md_], [0.02, (y1 - y0) / 2 - inset, 0.012], along, UP, n, true);
  // frame surround
  const bar = (c: Vec3, ha: number, hu: number): void => out.box(m.frame, off(c, 0.02), [ha, hu, 0.05], along, UP, n, true);
  bar([cA[0], y0, cA[2]], W / 2 + fw, fw);
  bar([cA[0], y1, cA[2]], W / 2 + fw, fw);
  bar([a[0], midY, a[2]], fw, (y1 - y0) / 2 + fw);
  bar([b[0], midY, b[2]], fw, (y1 - y0) / 2 + fw);
  // sill + crown (a chunkier keystone crown when arched)
  out.box(m.trim, off([cA[0], y0 - 0.05, cA[2]], 0.08), [W / 2 + 0.12, 0.05, 0.11], along, UP, n, true);
  out.box(m.trim, off([cA[0], y1 + 0.10, cA[2]], 0.10), [W / 2 + (arched ? 0.05 : 0.15), arched ? 0.14 : 0.08, 0.13], along, UP, n, true);
}

/**
 * A clear, obvious FRONT DOOR on the street edge, at the exact spot the collider
 * leaves its walk-through gap (both read core's doorMetrics), so you can see where
 * to walk in. Proud geometry (a recess would be occluded by the flat wall quad):
 * a dark opening, a door leaf swung ajar, a white frame + threshold step.
 */
export function frontDoor(out: PanelBuilder, e: FacadeEdge, m: { door: string; trim: string }): void {
  if (e.length <= 2.2) return;
  const { tc, halfW, head } = doorMetrics(e.length, e.base, e.top);
  const n: Vec3 = [e.normal[0], 0, e.normal[1]];
  const along = unit(sub(gp(e, 1), gp(e, 0)));
  const c = gp(e, tc);
  const y0 = Math.max(e.base, e.grade), y1 = y0 + head, midY = (y0 + y1) / 2, hH = (y1 - y0) / 2;
  const off = (p: Vec3, d: number): Vec3 => [p[0] + n[0] * d, p[1], p[2] + n[2] * d];
  const pt = (t: number, yy: number, d: number): Vec3 => off([c[0] + along[0] * t, yy, c[2] + along[2] * t], d);
  // dark opening panel (proud a hair so it isn't occluded by the wall quad)
  out.quad("citygen.room", pt(-halfW, y0, 0.03), pt(halfW, y0, 0.03), pt(halfW, y1, 0.03), pt(-halfW, y1, 0.03), n);
  // door leaf, only slightly ajar so its FACE reads as an obvious door (a wide-open
  // leaf goes edge-on and disappears against the storefront glazing). leafW = half
  // the opening → hinged at the left jamb, the leaf covers the full opening width.
  const ang = 0.26, leafW = halfW * 0.98;
  const swingDir: Vec3 = [along[0] * Math.cos(ang) + n[0] * Math.sin(ang), 0, along[2] * Math.cos(ang) + n[2] * Math.sin(ang)];
  const swingNorm: Vec3 = [-swingDir[2], 0, swingDir[0]];
  const hinge = pt(-halfW, midY, 0.03);
  const lc: Vec3 = [hinge[0] + swingDir[0] * leafW, midY, hinge[2] + swingDir[2] * leafW];
  out.box(m.door, lc, [leafW, hH - 0.04, 0.03], swingDir, UP, swingNorm, true);
  // white frame: jambs + lintel, proud
  out.box(m.trim, off(pt(-halfW, midY, 0), 0.05), [0.06, hH + 0.06, 0.07], along, UP, n, true);
  out.box(m.trim, off(pt(halfW, midY, 0), 0.05), [0.06, hH + 0.06, 0.07], along, UP, n, true);
  out.box(m.trim, off(pt(0, y1, 0), 0.06), [halfW + 0.06, 0.07, 0.08], along, UP, n, true);
  // threshold step
  out.box(m.trim, off([c[0], y0 - 0.06, c[2]], 0.13), [halfW + 0.16, 0.06, 0.16], along, UP, n, true);
}

/** even grid of framed windows on a wall span (piers between). */
export function windowGrid(out: PanelBuilder, e: FacadeEdge, m: WinMats, bandY0: number, arched = false, colW = 3.2): void {
  const n: Vec3 = [e.normal[0], 0, e.normal[1]];
  const cols = bayCount(e, colW);
  for (const band of floorBands(e)) {
    if (band.y0 < bandY0 - 0.01) continue;
    // lift the sill to grade; a row fully below the ground line is dropped
    // (faceWindow bails when the opening shrinks under 0.6 m).
    const wy0 = aboveGrade(e, band.y0 + 0.45), wy1 = band.y1 - 0.28;
    for (let c = 0; c < cols; c++) {
      faceWindow(out, gp(e, (c + 0.24) / cols), gp(e, (c + 0.76) / cols), wy0, wy1, n, m, arched);
    }
  }
}

/** horizontal projecting belt/string course across the whole edge at height y */
export function beltCourse(out: PanelBuilder, e: FacadeEdge, y: number, mat: string, depth = 0.06, h = 0.07): void {
  const a = gp(e, 0), b = gp(e, 1);
  const along = unit(sub([b[0], y, b[2]], [a[0], y, a[2]]));
  out.box(mat, [(a[0] + b[0]) / 2 + e.normal[0] * depth * 0.5, y, (a[2] + b[2]) / 2 + e.normal[1] * depth * 0.5],
    [e.length / 2, h, depth], along, UP, [e.normal[0], 0, e.normal[1]], true);
}

/** cornice at the roofline. style: "bracketed" (Victorian corbels+dentils),
 *  "tile" (Mediterranean overhang), or "parapet" (flat commercial cap). */
export function cornice(out: PanelBuilder, e: FacadeEdge, mat: string, proj: number, style: "bracketed" | "tile" | "parapet"): void {
  const along = unit(sub(gp(e, 1), gp(e, 0)));
  const n3: Vec3 = [e.normal[0], 0, e.normal[1]];
  const y = e.top - 0.05;
  const cc: Vec3 = [(gp(e, 0)[0] + gp(e, 1)[0]) / 2, y, (gp(e, 0)[2] + gp(e, 1)[2]) / 2];
  const at = (yy: number, p: number, hy: number, hx = e.length / 2 + 0.05, hz = proj) =>
    out.box(mat, [cc[0] + n3[0] * p, yy, cc[2] + n3[2] * p], [hx, hy, hz], along, UP, n3, false);
  if (style === "parapet") {
    at(y + 0.35, proj * 0.4, 0.4, e.length / 2 + 0.08, proj * 0.7); // solid parapet band
    return;
  }
  at(y + 0.16, proj * 0.5, 0.16); // crown slab (both bracketed + tile)
  if (style === "bracketed") {
    at(y - 0.05, proj * 0.3, 0.06, e.length / 2, proj * 0.6); // dentils
    const nB = Math.max(2, Math.round(e.length / 1.6));
    for (let i = 0; i < nB; i++) {
      const p = gp(e, (i + 0.5) / nB);
      out.box(mat, [p[0] + n3[0] * proj * 0.55, y - 0.22, p[2] + n3[2] * proj * 0.55], [0.07, 0.2, proj * 0.7], along, UP, n3, true);
    }
  } else {
    at(y + 0.02, proj * 0.75, 0.08, e.length / 2 + 0.05, proj * 1.15); // deep tile overhang
  }
}

/** vertical corner boards / quoins on the two ends of a street face */
export function cornerBoards(out: PanelBuilder, e: FacadeEdge, mat: string, w = 0.07): void {
  const along = unit(sub(gp(e, 1), gp(e, 0)));
  const n3: Vec3 = [e.normal[0], 0, e.normal[1]];
  for (const t of [0.012, 0.988]) {
    const p = gp(e, t);
    out.box(mat, [p[0] + n3[0] * 0.025, (e.base + e.top) / 2, p[2] + n3[2] * 0.025], [w, (e.top - e.base) / 2, 0.04], along, UP, n3, true);
  }
}

/** ground-floor storefront: bulkhead + tall glazing + signband + fabric awning */
export function storefront(out: PanelBuilder, e: FacadeEdge, y0: number, y1: number, m: { glass: string; trim: string; awn: string; sign: string }): void {
  const n: Vec3 = [e.normal[0], 0, e.normal[1]];
  const along = unit(sub(gp(e, 1), gp(e, 0)));
  y0 = Math.max(y0, e.grade); // start the shopfront at the ground line, not below it
  if (y1 - y0 < 1.2) return;  // ground floor fully buried on this (uphill) face → plain wall
  const bulk = y0 + 0.5, glassTop = y1 - 0.7;
  const cols = bayCount(e, 3.6);
  for (let c = 0; c < cols; c++) {
    faceWindow(out, gp(e, (c + 0.1) / cols), gp(e, (c + 0.9) / cols), bulk, glassTop, n, { frame: m.trim, glass: m.glass, trim: m.trim });
  }
  // signband
  out.box(m.sign, [(gp(e, 0)[0] + gp(e, 1)[0]) / 2 + n[0] * 0.06, glassTop + 0.35, (gp(e, 0)[2] + gp(e, 1)[2]) / 2 + n[1] * 0.06],
    [e.length / 2, 0.3, 0.06], along, UP, n, true);
  // fabric awning above the sign
  out.box(m.awn, [(gp(e, 0)[0] + gp(e, 1)[0]) / 2 + n[0] * 0.55, y1 - 0.05, (gp(e, 0)[2] + gp(e, 1)[2]) / 2 + n[1] * 0.55],
    [e.length / 2 - 0.2, 0.06, 0.5], along, UP, n, true);
}

/** ground-floor garage door (panelled) — Marina under-house garage */
export function garageDoor(out: PanelBuilder, e: FacadeEdge, y0: number, y1: number, m: { door: string; trim: string }, arched = false): void {
  const n: Vec3 = [e.normal[0], 0, e.normal[1]];
  const along = unit(sub(gp(e, 1), gp(e, 0)));
  y0 = Math.max(y0, e.grade); // sit the garage at grade so it isn't sunk into the hill
  if (y1 - y0 < 1.2) return;
  const w = Math.min(3.0, e.length * 0.5), tc = e.length > 6 ? 0.72 : 0.5;
  const dl = gp(e, tc - w / 2 / e.length), dr = gp(e, tc + w / 2 / e.length);
  const top = Math.min(y1 - 0.2, y0 + 2.4);
  const cD = lerp(dl, dr, 0.5), midY = (y0 + 0.1 + top) / 2;
  out.box(m.door, [cD[0] - n[0] * 0.06, midY, cD[2] - n[1] * 0.06], [w / 2, (top - y0 - 0.1) / 2, 0.06], along, UP, n, true);
  out.box(m.trim, [cD[0] + n[0] * 0.02, top + (arched ? 0.16 : 0.08), cD[2] + n[1] * 0.02], [w / 2 + 0.12, arched ? 0.16 : 0.08, 0.08], along, UP, n, true);
}
