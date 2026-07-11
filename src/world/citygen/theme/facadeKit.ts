// Shared façade components used by every SF archetype decorator (Victorian,
// Marina, downtown, SoMa …). Built on the core grammar primitives; each piece
// projects PROUD of the flat wall quad so it reads (a recessed piece would be
// occluded by the wall). Pure geometry, no THREE.
import {
  type FacadeEdge, type Vec3, PanelBuilder, pointOnWall, floorBands, bayCount, aboveGrade,
} from "../core/facade";
import { doorMetrics, doorEligible, STOOP_MAX_RISE } from "../core/collider";

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
 * Street-edge backdrop wall with a REAL doorway HOLE cut where the collider leaves
 * its walk-through gap. The single quad is replaced by a left jamb wall, a right
 * jamb wall and a header over the opening (plus a solid skirt below grade on a
 * hillside); the door column itself is left OPEN, so no wall quad covers the
 * collider gap — you walk straight through. Reads core's doorMetrics/doorEligible,
 * so the hole ⟺ the collider gap ⟺ the visible leaf drawn by frontDoor/stoopAndDoor.
 * Only the flat backdrop is cut here — windows/trim/door are proud geometry authored
 * separately, so the door leaf still occludes the LOD prism behind the hole and the
 * upper-floor window layout is untouched. Falls back to one solid quad on any edge
 * that takes no door.
 */
export function wallWithDoorway(out: PanelBuilder, e: FacadeEdge, mat: string, yBottom: number, yTop: number, n: Vec3): void {
  const seg = (t0: number, t1: number, y0: number, y1: number): void => {
    const a = gp(e, t0), b = gp(e, t1);
    out.quad(mat, [a[0], y0, a[2]], [b[0], y0, b[2]], [b[0], y1, b[2]], [a[0], y1, a[2]], n);
  };
  if (!doorEligible(e)) { seg(0, 1, yBottom, yTop); return; }
  const { tc, halfW, sill, openTop } = doorMetrics(e.length, e.base, e.top, e.grade);
  const dCenter = tc * e.length;
  const fL = Math.max(0, (dCenter - halfW) / e.length);   // opening left fraction
  const fR = Math.min(1, (dCenter + halfW) / e.length);   // opening right fraction
  const holeBase = Math.max(yBottom, sill);               // buried foundation skirt stays solid
  const holeTop = Math.min(yTop, openTop);                // walk-through clearance above the sill
  // Even a thin overlap matters when grade lifts the opening across a storey
  // boundary. Treating <0.6 m as solid left horizontal wall bands in the live
  // aperture on hillsides.
  if (holeTop - holeBase < 0.001 || fR - fL < 0.001) { seg(0, 1, yBottom, yTop); return; }
  if (holeBase - yBottom > 0.001) seg(fL, fR, yBottom, holeBase); // skirt under the opening
  if (fL > 0.001) seg(0, fL, yBottom, yTop);              // left jamb wall
  if (fR < 0.999) seg(fR, 1, yBottom, yTop);              // right jamb wall
  if (yTop - holeTop > 0.02) seg(fL, fR, holeTop, yTop);  // header over the opening
}

/**
 * Simple stone steps descending from the raised door SILL down to the street
 * terrain in front (e.frontGround, host-supplied; falls back to the building
 * base), centred on the doorway and projecting outward — the visible half of the
 * walkable stoop ramp the collider adds on a downhill approach (core/collider's
 * appendStoop). Same rise source, same slope envelope and the SAME ≤3 m cap as
 * the collider ramp, so steps are drawn IFF the walkable ramp exists. Stacked
 * solid boxes: the lowest step reaches furthest into the street, each higher
 * step sets back toward the wall along the ramp incline. No-op on a flat lot.
 * Shared so every archetype's raised entry reads the same way.
 */
export function frontStoop(out: PanelBuilder, e: FacadeEdge, mat: string): void {
  if (!doorEligible(e)) return;
  const { tc, halfW, sill } = doorMetrics(e.length, e.base, e.top, e.grade);
  const fg = e.frontGround ?? e.base;
  const rise = sill - fg;
  if (rise <= 0.25 || rise > STOOP_MAX_RISE) return; // MATCH core/collider appendStoop's gate
  const n: Vec3 = [e.normal[0], 0, e.normal[1]];
  const along = unit(sub(gp(e, 1), gp(e, 0)));
  const c = gp(e, tc);
  const run = rise / Math.tan(0.56);          // MATCH the collider ramp's incline
  const nSteps = Math.min(8, Math.max(2, Math.round(rise / 0.4)));
  const stepH = rise / nSteps, tread = run / nSteps;
  for (let s = 0; s < nSteps; s++) {
    const topY = fg + (s + 1) * stepH;          // step s top surface
    const proj = (nSteps - s) * tread;          // lowest step projects furthest out
    const cx = c[0] + n[0] * (proj / 2), cz = c[2] + n[2] * (proj / 2);
    // solid to just below street level so the flight reads as masonry, not slabs
    const y0 = fg - 0.25;
    out.box(mat, [cx, (y0 + topY) / 2, cz], [halfW + 0.25, (topY - y0) / 2, proj / 2], along, UP, n, false);
  }
}

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

/** Window authored on an edge, split around the live doorway whenever its
 * vertical span intersects the opening. Direct callers and windowGrid share
 * this so a short bay cannot leave glass/trim in a raised entrance. */
export function faceWindowAvoidDoor(
  out: PanelBuilder, e: FacadeEdge, t0: number, t1: number, y0: number, y1: number,
  n: Vec3, m: WinMats, arched = false,
): void {
  if (!doorEligible(e)) { faceWindow(out, gp(e, t0), gp(e, t1), y0, y1, n, m, arched); return; }
  const dm = doorMetrics(e.length, e.base, e.top, e.grade);
  if (y1 <= dm.sill + 0.02 || y0 >= dm.openTop - 0.02) {
    faceWindow(out, gp(e, t0), gp(e, t1), y0, y1, n, m, arched);
    return;
  }
  const pad = 0.12 / e.length;
  const door0 = dm.tc - dm.halfW / e.length - pad;
  const door1 = dm.tc + dm.halfW / e.length + pad;
  if (t1 <= door0 || t0 >= door1) { faceWindow(out, gp(e, t0), gp(e, t1), y0, y1, n, m, arched); return; }
  if (door0 > t0) faceWindow(out, gp(e, t0), gp(e, Math.min(t1, door0)), y0, y1, n, m, arched);
  if (door1 < t1) faceWindow(out, gp(e, Math.max(t0, door1)), gp(e, t1), y0, y1, n, m, arched);
}

/**
 * A clear, obvious FRONT DOOR on the street edge, at the exact spot the collider
 * leaves its walk-through gap (both read core's doorMetrics), so you can see where
 * to walk in. Proud geometry (a recess would be occluded by the flat wall quad):
 * a dark opening, a CLOSED door leaf, a white frame + threshold step. The leaf is
 * emitted under its own "citygen.doorleaf" bucket (NOT m.door) so mergePanels
 * gives it a dedicated sub-mesh the ring runtime can find by name, hide, and
 * replace with a live hinged twin when the player opens it with E.
 */
export function frontDoor(out: PanelBuilder, e: FacadeEdge, m: { door: string; trim: string }): void {
  if (!doorEligible(e)) return;
  const { tc, halfW, sill, openTop } = doorMetrics(e.length, e.base, e.top, e.grade);
  const n: Vec3 = [e.normal[0], 0, e.normal[1]];
  const along = unit(sub(gp(e, 1), gp(e, 0)));
  const c = gp(e, tc);
  const y0 = sill, y1 = openTop, midY = (y0 + y1) / 2, hH = (y1 - y0) / 2;
  const off = (p: Vec3, d: number): Vec3 => [p[0] + n[0] * d, p[1], p[2] + n[2] * d];
  const pt = (t: number, yy: number, d: number): Vec3 => off([c[0] + along[0] * t, yy, c[2] + along[2] * t], d);
  // Closed-door occluder (proud a hair so it isn't occluded by the wall quad).
  // It deliberately has its OWN bucket: the runtime hides it together with the
  // baked leaf while the live hinged door is open. Keeping this in the generic
  // citygen.room bucket left an opaque black quad across an otherwise passable
  // doorway, so the leaf appeared to vanish instead of revealing the interior.
  out.quad("citygen.doorback", pt(-halfW, y0, 0.03), pt(halfW, y0, 0.03), pt(halfW, y1, 0.03), pt(-halfW, y1, 0.03), n);
  // door leaf, authored fully CLOSED: it lies in the doorway plane (a hair proud
  // so no face is coplanar with the wall/LOD prism), hinged at the LEFT jamb
  // (dCenter − halfW viewed from the street) and spanning the opening. leafW =
  // half the opening → covers the full opening width. The ring runtime hides this
  // baked leaf + swings a dynamic twin from the same hinge when opened.
  const leafW = halfW * 0.96;
  const hinge = pt(-halfW, midY, 0.035);
  const lc: Vec3 = [hinge[0] + along[0] * leafW, midY, hinge[2] + along[2] * leafW];
  out.box("citygen.doorleaf", lc, [leafW, hH - 0.02, 0.03], along, UP, n, true);
  // Relief is authored into the SAME runtime-owned bucket, so the closed and
  // live leaves share a panelled silhouette and every piece hides atomically on
  // handoff. Even with one wood material, proud faces catch enough light to read.
  const leafAt = (x: number, yy: number, d: number): Vec3 => [
    hinge[0] + along[0] * x + n[0] * d, yy, hinge[2] + along[2] * x + n[2] * d,
  ];
  for (const yy of [midY - hH * 0.42, midY + hH * 0.42])
    out.box("citygen.doorleaf", leafAt(leafW * 0.92, yy, 0.052), [leafW * 0.56, hH * 0.22, 0.018], along, UP, n, true);
  out.box("citygen.doorleaf", leafAt(leafW * 1.67, midY, 0.072), [0.045, 0.075, 0.035], along, UP, n, true);
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
      faceWindowAvoidDoor(out, e, (c + 0.24) / cols, (c + 0.76) / cols, wy0, wy1, n, m, arched);
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
  // Storefront glazing used to span straight across the operable person door.
  // The baked leaf hid it while closed, but opening revealed an intact window
  // behind a passable collider gap. Cut every affected bay around the exact same
  // doorMetrics interval used by the wall, leaf and collision system.
  const dm = doorEligible(e) ? doorMetrics(e.length, e.base, e.top, e.grade) : null;
  const doorT0 = dm ? dm.tc - (dm.halfW + 0.12) / e.length : -1;
  const doorT1 = dm ? dm.tc + (dm.halfW + 0.12) / e.length : -1;
  const pane = (t0: number, t1: number) => {
    if ((t1 - t0) * e.length < 0.5) return;
    faceWindow(out, gp(e, t0), gp(e, t1), bulk, glassTop, n, { frame: m.trim, glass: m.glass, trim: m.trim });
  };
  for (let c = 0; c < cols; c++) {
    const t0 = (c + 0.1) / cols, t1 = (c + 0.9) / cols;
    if (!dm || t1 <= doorT0 || t0 >= doorT1) pane(t0, t1);
    else {
      pane(t0, Math.min(t1, doorT0));
      pane(Math.max(t0, doorT1), t1);
    }
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
  const { sill, openTop } = doorMetrics(e.length, e.base, e.top, e.grade);
  y0 = Math.max(y0, sill); // sit the garage at the sill (grade) so it isn't sunk into the hill
  if (y1 - y0 < 1.2) return;
  const w = Math.min(3.0, e.length * 0.5), tc = e.length > 6 ? 0.72 : 0.5;
  // A narrow Marina face cannot carry both a garage and the person door. Never
  // draw a permanent garage slab behind the operable leaf; preserve the walk-in
  // entrance and let the remaining facade read as stucco instead.
  const person = doorMetrics(e.length, e.base, e.top, e.grade);
  if (Math.abs(tc * e.length - person.tc * e.length) < w / 2 + person.halfW + 0.22) return;
  const dl = gp(e, tc - w / 2 / e.length), dr = gp(e, tc + w / 2 / e.length);
  const top = Math.min(y1 - 0.2, Math.max(y0 + 2.4, openTop));
  const cD = lerp(dl, dr, 0.5), midY = (y0 + 0.1 + top) / 2;
  out.box(m.door, [cD[0] - n[0] * 0.06, midY, cD[2] - n[1] * 0.06], [w / 2, (top - y0 - 0.1) / 2, 0.06], along, UP, n, true);
  out.box(m.trim, [cD[0] + n[0] * 0.02, top + (arched ? 0.16 : 0.08), cD[2] + n[1] * 0.02], [w / 2 + 0.12, arched ? 0.16 : 0.08, 0.08], along, UP, n, true);
}
