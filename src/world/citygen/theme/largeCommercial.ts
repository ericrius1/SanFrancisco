// Large commercial / office-block façade — the rich treatment for the big
// downtown & warehouse footprints that the plain storefront grid made read as a
// flat window-wall. Early-1900s SF Financial-District / SoMa masonry, composed
// the Chicago-School way (base · shaft · capital):
//
//   • a rusticated STONE BASE (1–2 tall storeys, `lc.stone`) with a taller
//     ground floor and a grand double-height ENTRANCE — a dark portal framed by
//     projecting stone pilasters, a heavy entablature lintel and a keystone,
//     with a glazed transom over the doors;
//   • a SHAFT of regularly gridded windows held in a real frame of vertical
//     PIERS (`lc.pier`, deepest relief → vertical rhythm) crossed by horizontal
//     SPANDREL bands (`lc.band`) at every floor line, so each window reads as
//     recessed masonry rather than a curtain-wall pane;
//   • full-height stone corner pilasters tying base to cap; and
//   • a bracketed CORNICE (`roof.parapet`) under a stepped parapet at the roof.
//
// All real geometry (the world's sun + SSAO shade the relief), authored through
// the core grammar primitives + the shared façadeKit — no THREE here. Every
// piece projects PROUD of the flat wall quad (a recessed piece would be occluded
// by the wall), so the "recess" of a window/portal is read from the deeper stone
// frame around it, exactly like faceWindow's proud-glass trick.
import {
  floorBands, aboveGrade, bayCount,
  type FacadeEdge, type Vec3, type PanelBuilder,
} from "../core/facade";
import type { Rng } from "../core/rng";
import { sub, len, unit, lerp, UP, gp, beltCourse, cornice, faceWindow, type WinMats } from "./facadeKit";

// Relief depths (metres proud of the flat wall). Piers stand deepest, then the
// spandrel bands, then the window frame/glass — so a window sits in a genuine
// masonry recess bounded by the pier×band grid.
const PIER_PROJ = 0.16;
const BAND_PROJ = 0.09;
const COL_W = 3.8; // stately window-bay spacing (metres)

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A lightweight recessed shaft window: one glass sheet a hair proud of the wall
 *  plus a single central mullion (the tall Chicago-window look). Cheap (~12 tris)
 *  because the surrounding pier×band grid supplies the frame — so a big building's
 *  hundreds of windows stay inside the triangle budget. */
function shaftWindow(out: PanelBuilder, a: Vec3, b: Vec3, y0: number, y1: number, n: Vec3, m: WinMats): void {
  const W = len(sub(b, a));
  if (W < 0.6 || y1 - y0 < 0.7) return;
  const along = unit(sub(b, a));
  const off = (p: Vec3, d: number): Vec3 => [p[0] + n[0] * d, p[1], p[2] + n[2] * d];
  const inset = 0.08, gd = 0.03;
  const gt0 = inset / W, gt1 = 1 - inset / W, gy0 = y0 + inset, gy1 = y1 - inset;
  const gc = (t: number, yy: number): Vec3 => off([a[0] + (b[0] - a[0]) * t, yy, a[2] + (b[2] - a[2]) * t], gd);
  out.quad(m.glass, gc(gt0, gy0), gc(gt1, gy0), gc(gt1, gy1), gc(gt0, gy1), n);
  const cA = lerp(a, b, 0.5), midY = (y0 + y1) / 2;
  out.box(m.trim, [cA[0] + n[0] * 0.05, midY, cA[2] + n[2] * 0.05], [0.03, (y1 - y0) / 2 - inset, 0.02], along, UP, n, true);
}

/** A vertical pier (pilaster strip) between two window bays, from y0→y1. */
function pier(out: PanelBuilder, e: FacadeEdge, t: number, y0: number, y1: number, mat: string, halfW: number, proj: number): void {
  if (y1 - y0 < 0.5) return;
  const p = gp(e, clamp(t, 0.004, 0.996));
  const along = unit(sub(gp(e, 1), gp(e, 0)));
  const n3: Vec3 = [e.normal[0], 0, e.normal[1]];
  out.box(mat, [p[0] + n3[0] * proj * 0.5, (y0 + y1) / 2, p[2] + n3[2] * proj * 0.5],
    [halfW, (y1 - y0) / 2, proj], along, UP, n3, true);
}

/** Grand double-height entrance on the street base: a dark portal (proud so it
 *  reads through the base quad) framed by projecting stone pilasters + a heavy
 *  lintel + keystone, with a glazed transom over the doors and a broad stoop
 *  slab. Aligned to the walk-through gap the collider cuts (tc), so it matches. */
function grandEntrance(out: PanelBuilder, e: FacadeEdge, base: number, topY: number, mats: { stone: string; door: string; glass: string }): void {
  const y0 = Math.max(base, e.grade);
  if (topY - y0 < 2.0 || e.length < 3) return;
  const halfW = Math.min(2.2, e.length * 0.13);
  const tc = e.length > 6 ? 0.24 : 0.5; // MATCH core/collider.ts doorway centre
  const along = unit(sub(gp(e, 1), gp(e, 0)));
  const n3: Vec3 = [e.normal[0], 0, e.normal[1]];
  const dl = gp(e, tc - halfW / e.length), dr = gp(e, tc + halfW / e.length);
  const cD = lerp(dl, dr, 0.5);
  const off = (p: Vec3, d: number, yy: number): Vec3 => [p[0] + n3[0] * d, yy, p[2] + n3[2] * d];
  const transomY = Math.min(y0 + 3.0, topY - 1.2); // door head; glazed transom above

  // dark door leaves + glazed transom, a hair proud so they win over the base quad
  out.quad(mats.door, off(dl, 0.03, y0), off(dr, 0.03, y0), off(dr, 0.03, transomY), off(dl, 0.03, transomY), n3);
  out.quad(mats.glass, off(dl, 0.03, transomY + 0.12), off(dr, 0.03, transomY + 0.12), off(dr, 0.03, topY - 0.12), off(dl, 0.03, topY - 0.12), n3);
  // transom bar between doors and fanlight
  out.box(mats.stone, [cD[0] + n3[0] * 0.14, transomY + 0.06, cD[2] + n3[2] * 0.14], [halfW + 0.06, 0.08, 0.16], along, UP, n3, true);

  // projecting stone pilasters flanking the opening (the real "recess" frame)
  const midY = (y0 + topY) / 2;
  out.box(mats.stone, [dl[0] + n3[0] * 0.12, midY, dl[2] + n3[2] * 0.12], [0.34, (topY - y0) / 2, 0.22], along, UP, n3, true);
  out.box(mats.stone, [dr[0] + n3[0] * 0.12, midY, dr[2] + n3[2] * 0.12], [0.34, (topY - y0) / 2, 0.22], along, UP, n3, true);
  // heavy entablature lintel across the head + a projecting keystone
  out.box(mats.stone, [cD[0] + n3[0] * 0.14, topY + 0.22, cD[2] + n3[2] * 0.14], [halfW + 0.6, 0.34, 0.26], along, UP, n3, true);
  out.box(mats.stone, [cD[0] + n3[0] * 0.22, topY + 0.04, cD[2] + n3[2] * 0.22], [0.24, 0.32, 0.3], along, UP, n3, true);
  // broad stoop slab at the threshold
  out.box(mats.stone, [cD[0] + n3[0] * 0.28, y0 + 0.08, cD[2] + n3[2] * 0.28], [halfW + 0.5, 0.08, 0.28], along, UP, n3, true);
}

/** The rich large-commercial treatment for one wall segment. Called by the
 *  downtown decorator when a building trips the "large" test; fully authors this
 *  edge (all faces), so the small downtown storefront look is untouched. */
export function largeCommercialFacade(e: FacadeEdge, out: PanelBuilder, _rng: Rng): void {
  const arch = e.arch;
  const wall = arch.wallMaterial;                         // per-building body colour (kept)
  const trim = arch.trimMaterial ?? "trim.victorian";
  const glass = arch.glassMaterial ?? "glass";
  const stone = "lc.stone", band = "lc.band", pierMat = "lc.pier", roofTrim = "roof.parapet";
  const wm: WinMats = { frame: trim, glass, trim };
  const n3: Vec3 = [e.normal[0], 0, e.normal[1]];
  const along = unit(sub(gp(e, 1), gp(e, 0)));

  const base = e.base, top = e.top, H = top - base;
  const bands = floorBands(e);

  // ---- tripartite split: stone base · shaft · cap --------------------------
  const nBase = H >= 26 ? 2 : 1;                          // 2-storey base on the tall ones
  let baseTopY = bands[Math.min(nBase, bands.length) - 1]?.y1 ?? base + arch.floorH;
  baseTopY = clamp(baseTopY, base + Math.min(H * 0.5, arch.floorH * 0.9), base + H * 0.42);

  // ---- backdrop wall (stone base tone below, body colour above) ------------
  const g0 = gp(e, 0), g1 = gp(e, 1);
  out.quad(stone, [g0[0], base, g0[2]], [g1[0], base, g1[2]], [g1[0], baseTopY, g1[2]], [g0[0], baseTopY, g0[2]], n3);
  out.quad(wall, [g0[0], baseTopY, g0[2]], [g1[0], baseTopY, g1[2]], [g1[0], top, g1[2]], [g0[0], top, g0[2]], n3);

  // water-table string course capping the stone base
  beltCourse(out, e, baseTopY, stone, 0.13, 0.22);

  // ---- base storey: grand entrance (street) + flanking tall windows --------
  const cols = bayCount(e, COL_W);
  const baseWinY0 = aboveGrade(e, base + 0.9);
  const baseWinY1 = baseTopY - 0.7;
  if (e.isStreet && e.length > 6) {
    grandEntrance(out, e, base, baseTopY - 0.55, { stone, door: "citygen.door", glass });
    // tall shopfront-scale windows in the outer bays, clear of the central portal
    for (let c = 0; c < cols; c++) {
      const t = (c + 0.5) / cols;
      if (Math.abs(t - (e.length > 6 ? 0.24 : 0.5)) < 0.14) continue; // skip the entrance bay(s)
      faceWindow(out, gp(e, (c + 0.2) / cols), gp(e, (c + 0.8) / cols), baseWinY0, baseWinY1, n3, wm);
    }
  } else {
    // non-street base: an even arcade of tall windows
    for (let c = 0; c < cols; c++) {
      faceWindow(out, gp(e, (c + 0.2) / cols), gp(e, (c + 0.8) / cols), baseWinY0, baseWinY1, n3, wm);
    }
  }

  // ---- shaft: pier×band grid holding the recessed window rows --------------
  const shaftBands = bands.filter((b) => b.y0 >= baseTopY - 0.01);
  // spandrel band between each pair of window rows (top of each shaft floor,
  // skipping the very top row which meets the cornice)
  for (let k = 0; k < shaftBands.length - 1; k++) beltCourse(out, e, shaftBands[k].y1, band, BAND_PROJ, 0.5);
  // recessed windows, one per bay per shaft floor
  for (const b of shaftBands) {
    const wy0 = aboveGrade(e, b.y0 + 0.55), wy1 = b.y1 - 0.4;
    for (let c = 0; c < cols; c++) shaftWindow(out, gp(e, (c + 0.28) / cols), gp(e, (c + 0.72) / cols), wy0, wy1, n3, wm);
  }
  // vertical piers on the bay boundaries (interior in `lc.pier`; the two ends are
  // full-height stone corner pilasters that tie the base to the cornice)
  for (let c = 0; c <= cols; c++) {
    const t = c / cols;
    if (c === 0 || c === cols) pier(out, e, t, base, top, stone, 0.42, PIER_PROJ + 0.03);
    else pier(out, e, t, baseTopY, top, pierMat, 0.27, PIER_PROJ);
  }

  // ---- capital: frieze + bracketed cornice + stepped parapet ---------------
  beltCourse(out, e, top - 0.95, stone, 0.10, 0.34);               // entablature frieze
  cornice(out, e, roofTrim, (arch.cornice ?? 0.25) + 0.35, "bracketed");
  // stepped parapet cap above the cornice (solid band + a centred raised step)
  const cc: Vec3 = [(g0[0] + g1[0]) / 2, 0, (g0[2] + g1[2]) / 2];
  out.box(roofTrim, [cc[0] + n3[0] * 0.06, top + 0.6, cc[2] + n3[2] * 0.06], [e.length / 2 + 0.06, 0.28, 0.16], along, UP, n3, false);
  out.box(roofTrim, [cc[0] + n3[0] * 0.06, top + 1.1, cc[2] + n3[2] * 0.06], [Math.max(1.2, e.length * 0.18), 0.34, 0.18], along, UP, n3, false);
}
