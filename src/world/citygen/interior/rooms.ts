// Floorplan partitioning + the shell pieces (partition walls, floor slabs,
// ceilings). A floor's bbox is split into a small grid of rooms; every pair of
// edge-adjacent rooms is joined by a 1 m doorway so the whole plan is walkable
// as one connected graph. Concave/odd footprints degrade gracefully — the grid
// is clamped to the inset bbox and rooms simply may not fill a notch.
import type { ColliderBox } from "../core/types";
import { PanelBuilder, type Vec3 } from "../core/facade";
import type { Rng } from "../core/rng";
import {
  addBox, DOOR_H, DOOR_W, SLAB, WALL_H, WALL_T,
  type Rect, rectW, rectD, rectCX, rectCZ, overlaps,
} from "./common";

/** axis a wall segment EXTENDS along: "x" = a line at constant z, "z" = constant x. */
export type Axis = "x" | "z";

export interface Wall {
  axis: Axis;
  /** the constant coordinate (z when axis "x", x when axis "z") */
  line: number;
  /** span endpoints along `axis` */
  s0: number; s1: number;
  /** doorway centre + clear width along `axis` */
  door: number; doorW: number;
}

const MIN_ROOM = 2.2; // a room narrower than this in either axis isn't split out

/** grid dimensions [cols, rows] for a target room count, biased to the long axis. */
function gridDims(target: number, w: number, d: number): [number, number] {
  if (target <= 1) return [1, 1];
  if (target === 2) return w >= d ? [2, 1] : [1, 2];
  if (target === 3) return w >= d ? [3, 1] : [1, 3];
  return [2, 2];
}

/** interior grid-line coordinates from a..b split into n cells, lightly jittered. */
function gridLines(a: number, b: number, n: number, r: Rng): number[] {
  const out = [a];
  for (let i = 1; i < n; i++) {
    const t = i / n + (r() - 0.5) * 0.1; // keep < 1/n so lines stay ordered
    out.push(a + (b - a) * t);
  }
  out.push(b);
  return out;
}

/** a doorway centre + width for a shared edge spanning s0..s1. */
function doorway(s0: number, s1: number, r: Rng): { c: number; w: number } {
  const span = s1 - s0;
  const w = Math.min(DOOR_W, Math.max(0.7, span - 0.4));
  const lo = s0 + 0.2 + w / 2, hi = s1 - 0.2 - w / 2;
  const c = hi <= lo ? (s0 + s1) / 2 : lo + r() * (hi - lo);
  return { c, w };
}

/**
 * Partition `area` (an already-inset bbox) into up to `target` rooms on a grid,
 * returning the room rects plus the partition walls (one per shared cell edge,
 * each already carrying a doorway). `target` is clamped so no room is thinner
 * than MIN_ROOM.
 */
export function partition(area: Rect, target: number, r: Rng): { rooms: Rect[]; walls: Wall[] } {
  const w = rectW(area), d = rectD(area);
  const maxCols = Math.max(1, Math.floor(w / MIN_ROOM));
  const maxRows = Math.max(1, Math.floor(d / MIN_ROOM));
  let [cols, rows] = gridDims(Math.max(1, target), w, d);
  cols = Math.min(cols, maxCols);
  rows = Math.min(rows, maxRows);

  const xs = gridLines(area.x0, area.x1, cols, r);
  const zs = gridLines(area.z0, area.z1, rows, r);

  const rooms: Rect[] = [];
  for (let c = 0; c < cols; c++)
    for (let rr = 0; rr < rows; rr++)
      rooms.push({ x0: xs[c], x1: xs[c + 1], z0: zs[rr], z1: zs[rr + 1] });

  const walls: Wall[] = [];
  // vertical partitions (constant x) between columns, one segment per row
  for (let c = 1; c < cols; c++)
    for (let rr = 0; rr < rows; rr++) {
      const dw = doorway(zs[rr], zs[rr + 1], r);
      walls.push({ axis: "z", line: xs[c], s0: zs[rr], s1: zs[rr + 1], door: dw.c, doorW: dw.w });
    }
  // horizontal partitions (constant z) between rows, one segment per column
  for (let rr = 1; rr < rows; rr++)
    for (let c = 0; c < cols; c++) {
      const dw = doorway(xs[c], xs[c + 1], r);
      walls.push({ axis: "x", line: zs[rr], s0: xs[c], s1: xs[c + 1], door: dw.c, doorW: dw.w });
    }
  return { rooms, walls };
}

/** one solid wall span (a box of material int.wall) with an optional collider. */
function wallSpan(
  out: PanelBuilder, cols: ColliderBox[] | null,
  axis: Axis, line: number, s0: number, s1: number, y0: number, y1: number,
): void {
  if (s1 - s0 < 0.04 || y1 - y0 < 0.04) return;
  const cy = (y0 + y1) / 2, hy = (y1 - y0) / 2;
  const cs = (s0 + s1) / 2, hs = (s1 - s0) / 2;
  if (axis === "x") addBox(out, cols, "int.wall", cs, cy, line, hs, hy, WALL_T);
  else addBox(out, cols, "int.wall", line, cy, cs, WALL_T, hy, hs);
}

/**
 * Build all partition walls for one floor at height `floorY`. Each wall is split
 * into the solid spans on either side of its doorway (colliders on those), with
 * a header/lintel above the opening (no collider — it clears a 1.8 m capsule).
 */
export function buildWalls(out: PanelBuilder, cols: ColliderBox[], walls: Wall[], floorY: number): void {
  const yTop = floorY + WALL_H;
  for (const wl of walls) {
    const d0 = wl.door - wl.doorW / 2, d1 = wl.door + wl.doorW / 2;
    const openable = d1 < wl.s1 - 0.02 || d0 > wl.s0 + 0.02;
    if (openable) {
      wallSpan(out, cols, wl.axis, wl.line, wl.s0, d0, floorY, yTop);
      wallSpan(out, cols, wl.axis, wl.line, d1, wl.s1, floorY, yTop);
      const lintel = floorY + DOOR_H;
      wallSpan(out, null, wl.axis, wl.line, d0, d1, lintel, yTop); // header over the door
    } else {
      // opening spans the whole edge → leave it fully open (no wall)
    }
  }
}

/** a single horizontal quad over rect `r` at height `y`, facing up (+y) or down. */
function quadXZ(out: PanelBuilder, mat: string, r: Rect, y: number, up: boolean): void {
  const A: Vec3 = [r.x0, y, r.z0], B: Vec3 = [r.x1, y, r.z0];
  const C: Vec3 = [r.x1, y, r.z1], D: Vec3 = [r.x0, y, r.z1];
  if (up) out.quad(mat, A, D, C, B, [0, 1, 0]);
  else out.quad(mat, A, B, C, D, [0, -1, 0]);
}

/**
 * A horizontal deck (floor slab or ceiling) over `area`, optionally with a
 * rectangular `hole` (the stairwell) subtracted — emitted as up to four border
 * strips so you can walk around / see up the shaft. Colliders are added per
 * strip only when `cols` is supplied (floors collide, ceilings don't).
 */
export function deck(
  out: PanelBuilder, cols: ColliderBox[] | null, mat: string,
  area: Rect, hole: Rect | null, y: number, up: boolean,
): void {
  // the quad is the walk surface at `y`; the collider sits just under it so its
  // TOP == `y` (you stand exactly on the drawn floor, no float).
  const emit = (p: Rect): void => {
    if (rectW(p) < 0.06 || rectD(p) < 0.06) return;
    quadXZ(out, mat, p, y, up);
    if (cols) cols.push({ x: rectCX(p), y: y - SLAB, z: rectCZ(p), hx: rectW(p) / 2, hy: SLAB, hz: rectD(p) / 2, yaw: 0 });
  };
  if (!hole || !overlaps(area, hole)) { emit(area); return; }
  const h: Rect = {
    x0: Math.max(area.x0, hole.x0), x1: Math.min(area.x1, hole.x1),
    z0: Math.max(area.z0, hole.z0), z1: Math.min(area.z1, hole.z1),
  };
  if (h.z0 > area.z0) emit({ x0: area.x0, x1: area.x1, z0: area.z0, z1: h.z0 }); // south
  if (h.z1 < area.z1) emit({ x0: area.x0, x1: area.x1, z0: h.z1, z1: area.z1 }); // north
  if (h.x0 > area.x0) emit({ x0: area.x0, x1: h.x0, z0: h.z0, z1: h.z1 });       // west
  if (h.x1 < area.x1) emit({ x0: h.x1, x1: area.x1, z0: h.z0, z1: h.z1 });       // east
}

/**
 * Faithful ground slab from the real (possibly concave) footprint triangulation,
 * so the entry floor matches the exterior shell exactly. One bbox collider backs
 * it (concave overhang is a non-issue for standing on it).
 */
export function polyGroundSlab(
  out: PanelBuilder, cols: ColliderBox[], poly: readonly (readonly [number, number])[],
  tris: number[], y: number, bb: Rect,
): void {
  const verts: Vec3[] = poly.map(([x, z]) => [x, y, z]);
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const a = verts[tris[t]], c = verts[tris[t + 1]], d = verts[tris[t + 2]];
    out.quad("int.floor", a, c, d, a, [0, 1, 0]);
  }
  cols.push({ x: rectCX(bb), y: y - SLAB, z: rectCZ(bb), hx: rectW(bb) / 2, hy: SLAB, hz: rectD(bb) / 2, yaw: 0 });
}
