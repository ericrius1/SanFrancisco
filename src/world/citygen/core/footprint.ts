// Polygon utilities for footprint-faithful massing. Pure 2D math, no THREE.
// Coordinates are [x, z] in the host world frame.
import type { Vec2 } from "./types";

/** signed area (>0 = counter-clockwise in an x-right / z-down frame) */
export function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return a / 2;
}

export function centroid(poly: Vec2[]): Vec2 {
  let cx = 0, cz = 0;
  for (const [x, z] of poly) { cx += x; cz += z; }
  return [cx / poly.length, cz / poly.length];
}

/** return the ring in a known winding (counter-clockwise, area > 0). */
export function ensureCCW(poly: Vec2[]): Vec2[] {
  return signedArea(poly) < 0 ? [...poly].reverse() : poly;
}

/** unit outward normal of edge p0→p1 for a CCW ring (in x/z). Outward = to the
 *  right of the travel direction when the ring is CCW in an x-right/z-down frame. */
export function edgeOutwardNormal(p0: Vec2, p1: Vec2): Vec2 {
  const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
  const len = Math.hypot(dx, dz) || 1;
  // rotate the edge direction -90° → outward for CCW rings in this frame
  return [dz / len, -dx / len];
}

/** index of the "street" edge — Phase 1 heuristic = the longest edge.
 *  TODO(Phase 5): make this road-network aware (edge whose outward normal points
 *  at the nearest open street) so entrances never face an alley. */
export function streetEdgeIndex(poly: Vec2[]): number {
  let best = 0, bestLen = -1;
  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i], p1 = poly[(i + 1) % poly.length];
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (len > bestLen) { bestLen = len; best = i; }
  }
  return best;
}

/**
 * Ear-clipping triangulation of a simple polygon (handles the concave L/T/U
 * footprints common in SF — a centroid fan would produce inverted triangles on
 * those). Returns triangle index triples into `poly`. Assumes CCW winding.
 */
export function triangulate(poly: Vec2[]): number[] {
  const n = poly.length;
  const out: number[] = [];
  if (n < 3) return out;
  const idx = Array.from({ length: n }, (_, i) => i);

  const area2 = (a: Vec2, b: Vec2, c: Vec2) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  const pointInTri = (p: Vec2, a: Vec2, b: Vec2, c: Vec2) => {
    const d1 = area2(p, a, b), d2 = area2(p, b, c), d3 = area2(p, c, a);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };

  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (area2(a, b, c) <= 0) continue; // reflex or degenerate — not an ear
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (pointInTri(poly[j], a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate polygon — bail with what we have
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}
