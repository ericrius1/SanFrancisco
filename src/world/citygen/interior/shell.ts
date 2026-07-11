// Interior-facing perimeter treatment. Exterior facade materials are DoubleSide,
// so without this lining a room shows clapboard/brick on its inside face. This pass
// adds calm plaster, base/crown trim, framed daylight panels and optional curtains.
// The ground-floor front-door span is explicitly cut out.
import { PanelBuilder, type Vec3 } from "../core/facade";
import { WALL_H, type Rect } from "./common";
import type { InteriorStyle } from "./style";

export interface FrontOpening {
  edge: number;
  tc: number;
  halfW: number;
  y0: number;
  y1: number;
}

export interface ShellDressing {
  /** Furniture-free footprints immediately inside dressed windows. */
  windowKeepouts: Rect[];
}

export function dressInteriorShell(
  out: PanelBuilder,
  poly: readonly (readonly [number, number])[],
  floorY: number,
  storeyH: number,
  style: InteriorStyle,
  opening: FrontOpening | null,
): ShellDressing {
  const windowKeepouts: Rect[] = [];
  const top = floorY + Math.min(storeyH - 0.12, Math.max(WALL_H + 0.35, 3.05));
  const liningOff = 0.105;
  const UP: Vec3 = [0, 1, 0];

  for (let edge = 0; edge < poly.length; edge++) {
    const [x0, z0] = poly[edge], [x1, z1] = poly[(edge + 1) % poly.length];
    const ex = x1 - x0, ez = z1 - z0, L = Math.hypot(ex, ez);
    if (L < 0.5) continue;
    const ux = ex / L, uz = ez / L;
    // buildInterior supplies an ensureCCW ring. Its left-hand edge normal is
    // therefore always inward—even for concave lots whose arithmetic vertex
    // centroid can sit outside an edge half-plane. A centroid-side flip here used
    // to push lining, windows and keepouts through the exterior on those homes.
    const nx = -uz, nz = ux;
    const along: Vec3 = [ux, 0, uz], normal: Vec3 = [nx, 0, nz];
    const at = (t: number, y: number, off = liningOff): Vec3 => [x0 + ex * t + nx * off, y, z0 + ez * t + nz * off];

    const wallSpan = (t0: number, t1: number, y0: number, y1: number) => {
      if (t1 - t0 < 0.004 || y1 - y0 < 0.04) return;
      out.quad(style.wall, at(t0, y0), at(t1, y0), at(t1, y1), at(t0, y1), normal);
    };
    const trimSpan = (t0: number, t1: number, y: number, hy: number, proud: number) => {
      if (t1 - t0 < 0.004) return;
      const tc = (t0 + t1) / 2, len = (t1 - t0) * L;
      out.box(style.trim, at(tc, y, liningOff + proud), [len / 2, hy, 0.035], along, UP, normal, false);
    };

    const isDoor = !!opening && opening.edge === edge && Math.abs(opening.y0 - floorY) < 0.2;
    let door0 = -1, door1 = -1;
    if (isDoor && opening) {
      door0 = Math.max(0, opening.tc - opening.halfW / L);
      door1 = Math.min(1, opening.tc + opening.halfW / L);
      wallSpan(0, door0, floorY, top);
      wallSpan(door1, 1, floorY, top);
      wallSpan(door0, door1, opening.y1, top);
      trimSpan(0, door0, floorY + 0.09, 0.07, 0.035);
      trimSpan(door1, 1, floorY + 0.09, 0.07, 0.035);
      // Interior casing around the opening; there is intentionally no back panel.
      const dMid = (opening.y0 + opening.y1) / 2;
      for (const t of [door0, door1]) out.box(style.trim, at(t, dMid, liningOff + 0.055), [0.055, (opening.y1 - opening.y0) / 2, 0.05], along, UP, normal, false);
      trimSpan(door0, door1, opening.y1 + 0.055, 0.055, 0.055);
    } else {
      wallSpan(0, 1, floorY, top);
      trimSpan(0, 1, floorY + 0.09, 0.07, 0.035);
    }
    trimSpan(0, 1, top - 0.055, style.tier === 2 ? 0.085 : 0.055, 0.035);
    if (style.tier === 2) trimSpan(0, 1, floorY + 1.02, 0.035, 0.03); // restrained picture rail / wainscot cap

    if (L < 1.9) continue;
    const nWin = Math.max(1, Math.floor(L / style.windowSpacing));
    const winW = Math.min(style.windowWidth, L / nWin - 0.42);
    if (winW < 0.55) continue;
    const wy0 = floorY + (style.family === "industrial" ? 0.72 : 0.82);
    const wy1 = Math.min(top - 0.38, wy0 + (style.tier === 2 ? 1.58 : style.family === "industrial" ? 1.48 : 1.25));
    for (let wi = 0; wi < nWin; wi++) {
      const tc = (wi + 0.5) / nWin;
      const halfT = winW / (2 * L), t0 = tc - halfT, t1 = tc + halfT;
      if (isDoor && t1 > door0 - 0.08 && t0 < door1 + 0.08) continue;
      const proud = liningOff + 0.022;
      out.quad("int.window", at(t0, wy0, proud), at(t1, wy0, proud), at(t1, wy1, proud), at(t0, wy1, proud), normal);
      // A tiny layered city view keeps these daylight panels from reading as
      // flat blue rectangles. Haze and three varied silhouettes are visual-only
      // quads a few millimetres forward, still cheap enough to merge per material.
      const viewProud = proud + 0.012;
      const horizon = wy0 + (wy1 - wy0) * 0.30;
      out.quad("int.window.haze", at(t0, wy0, viewProud), at(t1, wy0, viewProud), at(t1, horizon, viewProud), at(t0, horizon, viewProud), normal);
      for (let bi = 0; bi < 3; bi++) {
        const slot0 = t0 + (t1 - t0) * (bi / 3 + 0.045);
        const slot1 = t0 + (t1 - t0) * ((bi + 1) / 3 - 0.045);
        const skylineH = (wy1 - wy0) * (0.12 + 0.055 * ((edge + wi + bi) % 3));
        out.quad("int.window.city", at(slot0, wy0, viewProud + 0.006), at(slot1, wy0, viewProud + 0.006),
          at(slot1, wy0 + skylineH, viewProud + 0.006), at(slot0, wy0 + skylineH, viewProud + 0.006), normal);
      }
      const midY = (wy0 + wy1) / 2, halfH = (wy1 - wy0) / 2;
      const bar = (t: number, yy: number, ha: number, hu: number) => out.box(
        "int.trim", at(t, yy, proud + 0.035), [ha, hu, 0.035], along, UP, normal, false,
      );
      bar(tc, wy0 - 0.045, winW / 2 + 0.09, 0.045);
      bar(tc, wy1 + 0.045, winW / 2 + 0.09, 0.045);
      bar(t0, midY, 0.045, halfH + 0.09);
      bar(t1, midY, 0.045, halfH + 0.09);
      bar(tc, midY, 0.028, halfH); // centre mullion
      if (style.tier >= 1) bar(tc, wy0 + (wy1 - wy0) * 0.52, winW / 2, 0.025);

      if (style.curtains) {
        for (const side of [-1, 1]) {
          const t = tc + side * (halfT + 0.055);
          out.box(style.fabric, at(t, midY - 0.03, proud + 0.07), [0.11, halfH + 0.16, 0.045], along, UP, normal, false);
        }
        bar(tc, wy1 + 0.16, winW / 2 + 0.22, 0.025);
      }

      // AABB of a 0.72 m-deep no-furniture zone inside this oriented window.
      const a = at(t0, floorY, liningOff), b = at(t1, floorY, liningOff);
      const c = [a[0] + nx * 0.72, a[2] + nz * 0.72] as const;
      const d = [b[0] + nx * 0.72, b[2] + nz * 0.72] as const;
      windowKeepouts.push({
        x0: Math.min(a[0], b[0], c[0], d[0]) - 0.06,
        x1: Math.max(a[0], b[0], c[0], d[0]) + 0.06,
        z0: Math.min(a[2], b[2], c[1], d[1]) - 0.06,
        z1: Math.max(a[2], b[2], c[1], d[1]) + 0.06,
      });
    }
  }
  return { windowKeepouts };
}
