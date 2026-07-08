// Victorian rowhouse façade decorator (Italianate / Stick / Queen Anne).
//
// The signature SF move rendered as REAL geometry: the projecting **canted bay
// window** that runs the upper floors, plus a bracketed **cornice** at the
// roofline and a ground-floor **stoop/garage** band. Non-street faces stay plain
// (flat wall + cornice) to save triangles. Pure geometry via the core grammar
// primitives — no THREE here.
//
// A canted bay cross-section (plan view) is a trapezoid: it leaves the wall at
// [tL,tR], cants inward to a narrower front face, and projects `proj` metres out.
// We extrude that trapezoid across the upper floors and glaze the three outer
// faces per storey.
import {
  type FacadeDecorator, type FacadeEdge, type Vec3,
  PanelBuilder, pointOnWall, outset, floorBands, bayCount,
} from "../core/facade";

const norm3 = (a: Vec3, b: Vec3, c: Vec3): Vec3 => {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
};

/** vertical quad between two ground points (ax,az)&(bx,bz) from y0→y1 */
function wallQuad(out: PanelBuilder, mat: string, a: Vec3, b: Vec3, y0: number, y1: number, nHint?: Vec3): void {
  const bl: Vec3 = [a[0], y0, a[2]], br: Vec3 = [b[0], y0, b[2]];
  const tr: Vec3 = [b[0], y1, b[2]], tl: Vec3 = [a[0], y1, a[2]];
  out.quad(mat, bl, br, tr, tl, nHint ?? norm3(bl, br, tl));
}

export const victorianFacade: FacadeDecorator = (e, out, rng) => {
  const arch = e.arch;
  const wall = arch.wallMaterial;
  const trim = arch.trimMaterial ?? wall;
  const glass = arch.glassMaterial ?? "glass";
  const baseMat = arch.baseMaterial ?? trim;
  const groundH = Math.min(arch.floorH * 1.1, (e.top - e.base) * 0.5);
  const groundTopY = e.base + groundH;
  const nGround: Vec3 = [e.normal[0], 0, e.normal[1]];

  // ---- ground floor band (stoop/garage tone) + upper wall -------------------
  const g0 = pointOnWall(e, 0, 0), g1 = pointOnWall(e, 1, 0);
  wallQuad(out, baseMat, g0, g1, e.base, groundTopY, nGround);
  wallQuad(out, wall, g0, g1, groundTopY, e.top, nGround);

  // stoop door / garage recess on the street face
  if (e.isStreet && e.length > 2.5) {
    const dw = Math.min(2.4, e.length * 0.35);
    const tc = 0.5;
    const dl = pointOnWall(e, tc - dw / 2 / e.length, 0);
    const dr = pointOnWall(e, tc + dw / 2 / e.length, 0);
    // recess panel pushed slightly IN so it reads as an opening
    const din = 0.12;
    const dlI = outset(dl, e, -din), drI = outset(dr, e, -din);
    wallQuad(out, arch.roofMaterial === "roof.flatTrim" ? trim : baseMat, dlI, drI, e.base, groundTopY * 0.92, nGround);
  }

  // ---- canted bay windows over the upper floors (street face only) ----------
  const upper = floorBands(e).filter((b) => b.y0 >= groundTopY - 0.01);
  if (e.isStreet && arch.bayProjection && upper.length >= 1) {
    const proj = arch.bayProjection;
    const nBays = bayCount(e, arch.bayWidth ? arch.bayWidth * 2.6 : 7);
    for (let k = 0; k < nBays; k++) {
      const slot0 = k / nBays, slot1 = (k + 1) / nBays;
      const openFrac = 0.62;                    // bay opening = 62% of the slot
      const mid = (slot0 + slot1) / 2, half = (slot1 - slot0) * openFrac / 2;
      const tL = mid - half, tR = mid + half;
      const cant = (tR - tL) * 0.22;            // how far the front face cants in
      const wallL = pointOnWall(e, tL, 0), wallR = pointOnWall(e, tR, 0);
      const frontL = outset(pointOnWall(e, tL + cant, 0), e, proj);
      const frontR = outset(pointOnWall(e, tR - cant, 0), e, proj);
      const yb = upper[0].y0, yt = e.top;

      // three outer faces: left slant, front, right slant
      wallQuad(out, trim, wallL, frontL, yb, yt);
      wallQuad(out, trim, frontL, frontR, yb, yt, nGround);
      wallQuad(out, trim, frontR, wallR, yb, yt);
      // bay top + bottom caps
      capQuad(out, trim, wallL, frontL, frontR, wallR, yt, true);
      capQuad(out, trim, wallL, frontL, frontR, wallR, yb, false);

      // glaze each upper storey on the front + slanted faces
      for (const band of upper) {
        const gy0 = band.y0 + 0.35, gy1 = band.y1 - 0.25;
        if (gy1 <= gy0) continue;
        glazeFace(out, glass, wallL, frontL, gy0, gy1, e, 0.02);
        glazeFace(out, glass, frontL, frontR, gy0, gy1, e, 0.02);
        glazeFace(out, glass, frontR, wallR, gy0, gy1, e, 0.02);
      }
    }
  } else if (upper.length) {
    // non-street / no-bay: a simple recessed window grid so it isn't a blank slab
    plainWindows(out, e, glass, groundTopY, rng);
  }

  // ---- bracketed cornice at the roofline (wraps all faces) -------------------
  if (arch.cornice && arch.cornice > 0) {
    const c = arch.cornice;
    const y0 = e.top - 0.35, y1 = e.top + 0.15;
    const inA = pointOnWall(e, 0, 0), inB = pointOnWall(e, 1, 0);
    const outA = outset(inA, e, c), outB = outset(inB, e, c);
    wallQuad(out, trim, outA, outB, y0, y1, nGround);              // fascia
    // underside + top slab
    capStrip(out, trim, inA, inB, outA, outB, y1, true);
    capStrip(out, trim, inA, inB, outA, outB, y0, false);
  }
};

/** horizontal cap across the 4-point bay trapezoid at height y */
function capQuad(out: PanelBuilder, mat: string, wallL: Vec3, frontL: Vec3, frontR: Vec3, wallR: Vec3, y: number, up: boolean): void {
  const n: Vec3 = up ? [0, 1, 0] : [0, -1, 0];
  const a: Vec3 = [wallL[0], y, wallL[2]], b: Vec3 = [frontL[0], y, frontL[2]];
  const c: Vec3 = [frontR[0], y, frontR[2]], d: Vec3 = [wallR[0], y, wallR[2]];
  out.quad(mat, a, b, c, d, n);
}

/** horizontal strip between an inner edge and an outset edge (cornice slab) */
function capStrip(out: PanelBuilder, mat: string, inA: Vec3, inB: Vec3, outA: Vec3, outB: Vec3, y: number, up: boolean): void {
  const n: Vec3 = up ? [0, 1, 0] : [0, -1, 0];
  out.quad(mat, [inA[0], y, inA[2]], [inB[0], y, inB[2]], [outB[0], y, outB[2]], [outA[0], y, outA[2]], n);
}

/** glass pane covering most of a face between two ground points, outset a hair */
function glazeFace(out: PanelBuilder, mat: string, a: Vec3, b: Vec3, y0: number, y1: number, e: FacadeEdge, push: number): void {
  const n = norm3([a[0], y0, a[2]], [b[0], y0, b[2]], [a[0], y1, a[2]]);
  const ao: Vec3 = [a[0] + n[0] * push, 0, a[2] + n[2] * push];
  const bo: Vec3 = [b[0] + n[0] * push, 0, b[2] + n[2] * push];
  out.quad(mat, [ao[0], y0, ao[2]], [bo[0], y0, bo[2]], [bo[0], y1, bo[2]], [ao[0], y1, ao[2]], n);
}

/** simple per-storey recessed window band on a flat wall (non-street faces) */
function plainWindows(out: PanelBuilder, e: FacadeEdge, glass: string, groundTopY: number, rng: () => number): void {
  const n: Vec3 = [e.normal[0], 0, e.normal[1]];
  const cols = bayCount(e, 3.2);
  for (const band of floorBands(e)) {
    if (band.y0 < groundTopY - 0.01) continue;
    const gy0 = band.y0 + 0.4, gy1 = band.y1 - 0.35;
    if (gy1 <= gy0) continue;
    for (let c = 0; c < cols; c++) {
      if (rng() < 0.06) continue; // an occasional blank bay
      const t0 = (c + 0.28) / cols, t1 = (c + 0.72) / cols;
      const a = outset(pointOnWall(e, t0, 0), e, 0.02);
      const b = outset(pointOnWall(e, t1, 0), e, 0.02);
      out.quad(glass, [a[0], gy0, a[2]], [b[0], gy0, b[2]], [b[0], gy1, b[2]], [a[0], gy1, a[2]], n);
    }
  }
}
