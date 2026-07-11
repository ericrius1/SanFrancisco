// Victorian rowhouse façade decorator (Italianate / Stick / Queen Anne).
//
// The richness that keeps SF Victorians from reading as plain boxes is DETAIL:
// projecting canted bay windows, deep recessed double-hung windows with frames,
// mullions, sills and crowns, horizontal belt courses between floors, a bracketed
// cornice with corbels + dentils at the roofline, corner boards, and a raised
// stoop with a panelled door. All of it is real geometry (so the sun + SSAO in
// the host actually shade the relief) authored through the core grammar
// primitives — no THREE here.
import {
  type FacadeDecorator, type FacadeEdge, type Vec3,
  PanelBuilder, pointOnWall, outset, floorBands, bayCount, aboveGrade,
} from "../core/facade";
import { wallWithDoorway, frontStoop } from "./facadeKit";
import { doorEligible, doorMetrics } from "../core/collider";

// ---- small vector helpers ---------------------------------------------------
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]) || 1;
const unit = (a: Vec3): Vec3 => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const UP: Vec3 = [0, 1, 0];

/** ground point at fraction t along the edge (y=0 placeholder replaced by caller) */
const gp = (e: FacadeEdge, t: number): Vec3 => pointOnWall(e, t, 0);

/**
 * A deep, framed, double-hung-style window on a face defined by two ground
 * points a→b, spanning y0..y1, with outward normal n. Draws: a recessed glass
 * plane split into panes by mullions, a projecting frame surround, a sill below
 * and a crown/lintel above — the Victorian window signature.
 */
function faceWindow(
  out: PanelBuilder, a: Vec3, b: Vec3, y0: number, y1: number, n: Vec3,
  m: { frame: string; glass: string; trim: string },
): void {
  const along = unit(sub(b, a));
  const W = len(sub(b, a));
  if (W < 0.5 || y1 - y0 < 0.6) return;
  const cA = lerp(a, b, 0.5);
  const midY = (y0 + y1) / 2;
  const off = (p: Vec3, d: number): Vec3 => [p[0] + n[0] * d, p[1], p[2] + n[2] * d];
  // A glass pane must sit PROUD of the wall — the flat wall quad already covers
  // this cell, so a recessed pane would be occluded (that was why windows never
  // showed). Glass a hair in front, muntins in front of that, frame around it.
  const gd = 0.03;   // glass proud of wall
  const md_ = 0.05;  // muntin bars proud
  const fw = 0.05;   // frame width
  const glassCorner = (t: number, yy: number): Vec3 =>
    off([a[0] + (b[0] - a[0]) * t, yy, a[2] + (b[2] - a[2]) * t], gd);
  // single dark glass sheet filling the opening (inset a touch from the frame)
  const inset = 0.06;
  const gt0 = inset / W, gt1 = 1 - inset / W;
  const gy0 = y0 + inset, gy1 = y1 - inset;
  out.quad(m.glass, glassCorner(gt0, gy0), glassCorner(gt1, gy0), glassCorner(gt1, gy1), glassCorner(gt0, gy1), n);

  // muntins: a white cross dividing the sash into 2×2 lites (thin bars proud of glass)
  const muntin = (ha: number, hu: number, cx: Vec3): void =>
    out.box(m.trim, [cx[0] + n[0] * md_, cx[1], cx[2] + n[2] * md_], [ha, hu, 0.012], along, UP, n, true);
  muntin(W / 2 - inset, 0.02, [cA[0], midY, cA[2]]);                 // horizontal bar
  muntin(0.02, (y1 - y0) / 2 - inset, [cA[0], midY, cA[2]]);         // vertical bar

  // projecting frame surround (four slim boxes proud of the wall)
  const bar = (c: Vec3, ha: number, hu: number): void =>
    out.box(m.frame, off([c[0], c[1], c[2]], 0.02), [ha, hu, 0.05], along, UP, n, true);
  bar([cA[0], y0, cA[2]], W / 2 + fw, fw);            // bottom
  bar([cA[0], y1, cA[2]], W / 2 + fw, fw);            // top
  bar([a[0], midY, a[2]], fw, (y1 - y0) / 2 + fw);    // left
  bar([b[0], midY, b[2]], fw, (y1 - y0) / 2 + fw);    // right

  // sill below + crowned lintel above (project further for relief)
  out.box(m.trim, off([cA[0], y0 - 0.05, cA[2]], 0.08), [W / 2 + 0.12, 0.05, 0.11], along, UP, n, true);
  out.box(m.trim, off([cA[0], y1 + 0.10, cA[2]], 0.10), [W / 2 + 0.15, 0.08, 0.13], along, UP, n, true);
}

/** horizontal projecting belt/string course across the whole edge at height y */
function beltCourse(out: PanelBuilder, e: FacadeEdge, y: number, mat: string, depth = 0.06, h = 0.07): void {
  const a = gp(e, 0), b = gp(e, 1);
  const c: Vec3 = [(a[0] + b[0]) / 2, y, (a[2] + b[2]) / 2];
  const along = unit(sub([b[0], y, b[2]], [a[0], y, a[2]]));
  out.box(mat, [c[0] + e.normal[0] * depth * 0.5, y, c[2] + e.normal[1] * depth * 0.5],
    [e.length / 2, h, depth], along, UP, [e.normal[0], 0, e.normal[1]], true);
}

/** bracketed cornice: crown slab + a row of corbel brackets + a dentil band */
function bracketedCornice(out: PanelBuilder, e: FacadeEdge, mat: string, proj: number): void {
  const along = unit(sub(gp(e, 1), gp(e, 0)));
  const n3: Vec3 = [e.normal[0], 0, e.normal[1]];
  const crownY = e.top - 0.05;
  const cc: Vec3 = [(gp(e, 0)[0] + gp(e, 1)[0]) / 2, crownY, (gp(e, 0)[2] + gp(e, 1)[2]) / 2];
  // main crown slab
  out.box(mat, [cc[0] + n3[0] * proj * 0.5, crownY + 0.16, cc[2] + n3[2] * proj * 0.5],
    [e.length / 2 + 0.05, 0.16, proj], along, UP, n3, false);
  // dentil band just under the crown
  out.box(mat, [cc[0] + n3[0] * proj * 0.3, crownY - 0.05, cc[2] + n3[2] * proj * 0.3],
    [e.length / 2, 0.06, proj * 0.6], along, UP, n3, true);
  // corbel brackets, evenly spaced
  const nB = Math.max(2, Math.round(e.length / 1.6));
  for (let i = 0; i < nB; i++) {
    const t = (i + 0.5) / nB;
    const p = gp(e, t);
    out.box(mat, [p[0] + n3[0] * proj * 0.55, crownY - 0.22, p[2] + n3[2] * proj * 0.55],
      [0.07, 0.2, proj * 0.7], along, UP, n3, true);
  }
}

/** ground-level panelled + trimmed door at the entrance (aligned with the
 *  walk-through gap the collider cuts in the street wall, so you enter here). */
function stoopAndDoor(out: PanelBuilder, e: FacadeEdge, base: number, groundTopY: number, m: { base: string; trim: string }): void {
  // MATCH core/collider.ts doorway: tc + width + sill/openTop, so the visual door
  // is exactly the walk-through gap (raised to the sill, capped at openTop).
  const { tc, halfW, sill, openTop } = doorMetrics(e.length, e.base, e.top, e.grade);
  const dw = halfW * 2;
  const along = unit(sub(gp(e, 1), gp(e, 0)));
  const n3: Vec3 = [e.normal[0], 0, e.normal[1]];
  const dl = gp(e, tc - dw / 2 / e.length), dr = gp(e, tc + dw / 2 / e.length);
  const doorBase = sill + 0.02;
  const doorTop = openTop;

  // a single flat threshold slab at the doorsill (cosmetic)
  const cSill = lerp(dl, dr, 0.5);
  out.box(m.trim, [cSill[0] + n3[0] * 0.2, base + 0.06, cSill[2] + n3[2] * 0.2], [dw / 2 + 0.2, 0.06, 0.2], along, UP, n3, true);

  // The wall quad behind is cut open (wallWithDoorway), so this reads as a real
  // entrance: a dark entry backing filling the opening (a hair proud so it occludes
  // the LOD prism through the hole) + a CLOSED panelled leaf + a trim surround.
  // The leaf is emitted under its own "citygen.doorleaf" bucket (NOT m.door) so
  // mergePanels gives it a dedicated sub-mesh the ring runtime can find by name,
  // hide, and replace with a live hinged twin when the player opens it with E.
  // Hinge at the LEFT jamb (dl = dCenter − halfW viewed from the street); proud
  // 0.055 so no face is coplanar with the 0.02 backing or the 0.09 trim front.
  const inw = (p: Vec3, d: number, yy: number): Vec3 => [p[0] + n3[0] * d, yy, p[2] + n3[2] * d];
  // Dedicated backing bucket: ring.ts hides/restores this with the baked leaf.
  // A generic citygen.room quad stayed opaque after opening and visually sealed
  // the doorway even though its collider gap was live.
  out.quad("citygen.doorback", inw(dl, 0.02, doorBase), inw(dr, 0.02, doorBase), inw(dr, 0.02, doorTop), inw(dl, 0.02, doorTop), n3);
  const leafHalf = halfW * 0.96, dMid = (sill + openTop) / 2;
  const hinge = inw(dl, 0.055, dMid);
  out.box("citygen.doorleaf", [hinge[0] + along[0] * leafHalf, dMid, hinge[2] + along[2] * leafHalf], [leafHalf, (openTop - sill) / 2 - 0.02, 0.03], along, UP, n3, true);
  // surround
  const cA = lerp(dl, dr, 0.5), midY = (doorBase + doorTop) / 2;
  out.box(m.trim, [cA[0] + n3[0] * 0.03, doorTop + 0.06, cA[2] + n3[2] * 0.03], [dw / 2 + 0.14, 0.1, 0.06], along, UP, n3, true);
  out.box(m.trim, [dl[0] + n3[0] * 0.03, midY, dl[2] + n3[2] * 0.03], [0.08, (doorTop - doorBase) / 2, 0.06], along, UP, n3, true);
  out.box(m.trim, [dr[0] + n3[0] * 0.03, midY, dr[2] + n3[2] * 0.03], [0.08, (doorTop - doorBase) / 2, 0.06], along, UP, n3, true);
}

export const victorianFacade: FacadeDecorator = (e, out, rng) => {
  const arch = e.arch;
  const wall = arch.wallMaterial;
  const trim = arch.trimMaterial ?? wall;
  const glass = arch.glassMaterial ?? "glass";
  const baseMat = arch.baseMaterial ?? trim;
  const n3: Vec3 = [e.normal[0], 0, e.normal[1]];
  const bands = floorBands(e);
  const groundTopY = bands[0]?.y1 ?? e.base + arch.floorH;
  const wm = { frame: trim, glass, trim };

  // ---- flat wall (ground band in base tone, upper in wall tone) -------------
  // the ground band is cut open at the doorway so the collider's walk-through gap
  // isn't backed by a solid quad; the upper band spans the whole edge.
  const g0 = gp(e, 0), g1 = gp(e, 1);
  wallWithDoorway(out, e, baseMat, e.base, groundTopY, n3);
  out.quad(wall, [g0[0], groundTopY, g0[2]], [g1[0], groundTopY, g1[2]], [g1[0], e.top, g1[2]], [g0[0], e.top, g0[2]], n3);

  // corner boards (vertical trim at the façade ends) on the street face
  if (e.isStreet) {
    for (const t of [0.012, 0.988]) {
      const p = gp(e, t), along = unit(sub(g1, g0));
      out.box(trim, [p[0] + n3[0] * 0.025, (e.base + e.top) / 2, p[2] + n3[2] * 0.025],
        [0.07, (e.top - e.base) / 2, 0.04], along, UP, n3, true);
    }
  }

  // ---- ground floor: stoop + door on the street face -----------------------
  // On a hillside lot the ground floor can be buried up to `grade`; only lay the
  // stoop/door/garden window when enough of it clears the ground line.
  const gBase = Math.max(e.base, e.grade);
  if (doorEligible(e)) {
    frontStoop(out, e, baseMat); // stone steps up to the raised stoop (downhill lots)
    stoopAndDoor(out, e, gBase, groundTopY, { base: baseMat, trim });
    // a ground-floor bay/garden window on the other side of the door
    const gw0 = gp(e, 0.62), gw1 = gp(e, 0.92);
    faceWindow(out, gw0, gw1, aboveGrade(e, e.base + 0.7), groundTopY - 0.25, n3, wm);
  }

  // ---- upper floors ---------------------------------------------------------
  const upper = bands.filter((b) => b.y0 >= groundTopY - 0.01);

  // belt course at each floor line
  for (const b of upper) beltCourse(out, e, b.y0, trim);

  if (e.isStreet && arch.bayProjection && upper.length >= 1) {
    // canted bay over ~55% of the façade; flanking wall gets its own windows
    const proj = arch.bayProjection;
    const bl = 0.30, br = 0.70;                    // bay opening fraction
    const cant = (br - bl) * 0.2;
    const wallL = gp(e, bl), wallR = gp(e, br);
    const frontL = outset(gp(e, bl + cant), e, proj);
    const frontR = outset(gp(e, br - cant), e, proj);
    // start the projecting bay at the ground line so it never juts out below grade
    const yb = Math.max(upper[0].y0, e.grade), yt = e.top;
    const fL: Vec3 = [frontL[0], 0, frontL[2]], fR: Vec3 = [frontR[0], 0, frontR[2]];
    const nFrontU = unit(sub(fR, fL)); const nFront: Vec3 = [nFrontU[2], 0, -nFrontU[0]];
    const nLU = unit(sub(fL, [wallL[0], 0, wallL[2]])); const nL: Vec3 = [nLU[2], 0, -nLU[0]];
    const nRU = unit(sub([wallR[0], 0, wallR[2]], fR)); const nR: Vec3 = [nRU[2], 0, -nRU[0]];

    // bay shell faces are BODY colour (the bay is part of the house, trimmed only
    // at its window frames + corners); flat cap on top
    const q = (p0: Vec3, p1: Vec3, nn: Vec3) =>
      out.quad(wall, [p0[0], yb, p0[2]], [p1[0], yb, p1[2]], [p1[0], yt, p1[2]], [p0[0], yt, p0[2]], nn);
    q(wallL, frontL, nL); q(frontL, frontR, nFront); q(frontR, wallR, nR);
    out.quad(trim, [wallL[0], yt, wallL[2]], [frontL[0], yt, frontL[2]], [frontR[0], yt, frontR[2]], [wallR[0], yt, wallR[2]], UP);

    // windows on each bay face + flanking wall, per storey
    for (const band of upper) {
      const wy0 = aboveGrade(e, band.y0 + 0.45), wy1 = band.y1 - 0.2;
      faceWindow(out, frontL, frontR, wy0, wy1, nFront, wm);
      faceWindow(out, wallL, frontL, wy0, wy1, nL, wm);
      faceWindow(out, frontR, wallR, wy0, wy1, nR, wm);
      // flanking windows left & right of the bay
      faceWindow(out, gp(e, 0.06), gp(e, 0.24), wy0, wy1, n3, wm);
      faceWindow(out, gp(e, 0.76), gp(e, 0.94), wy0, wy1, n3, wm);
    }
  } else {
    // non-street / no-bay faces: an even grid of framed windows
    const cols = bayCount(e, 3.4);
    for (const band of upper) {
      const wy0 = aboveGrade(e, band.y0 + 0.45), wy1 = band.y1 - 0.25;
      for (let c = 0; c < cols; c++) {
        if (rng() < 0.05) continue;
        faceWindow(out, gp(e, (c + 0.24) / cols), gp(e, (c + 0.76) / cols), wy0, wy1, n3, wm);
      }
    }
  }

  // ---- bracketed cornice at the roofline (wraps all faces) ------------------
  bracketedCornice(out, e, trim, (arch.cornice ?? 0.4) + 0.15);
};
