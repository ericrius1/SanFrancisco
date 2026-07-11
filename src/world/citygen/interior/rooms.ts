// Floorplan partitioning + the shell pieces (partition walls, floor slabs,
// ceilings). A floor's bbox is split into a small grid of rooms; every pair of
// edge-adjacent rooms is joined by a 1 m doorway so the whole plan is walkable
// as one connected graph. Concave/odd footprints degrade gracefully — the grid
// is clamped to the inset bbox and rooms simply may not fill a notch.
import type { ColliderBox } from "../core/types";
import { PanelBuilder, type Vec3 } from "../core/facade";
import type { Rng } from "../core/rng";
import {
  addBox, APPROACH_D, CIRCULATION_W, DOOR_H, DOOR_W, SLAB, WALL_H, WALL_T,
  clampPoint, intersectRect, rectAround,
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
  /** rooms joined by this opening. */
  a: number; b: number;
}

/** Explicit room-to-room opening, used by furnishing and clearance tests. */
export interface Portal {
  id: number;
  a: number; b: number;
  axis: Axis;
  line: number;
  center: number;
  width: number;
  /** full two-sided approach footprint, before clipping to either room. */
  keepout: Rect;
}

export interface EntryAccess { point: readonly [number, number]; keepout: Rect; }
export interface StairAccess { room: number; point: readonly [number, number]; keepout: Rect; }
export interface CirculationPlan {
  /** Per-room clear rectangles. Their union contains a >=1.2 m centre path. */
  byRoom: Rect[][];
  hubs: (readonly [number, number])[];
  entryRoom: number;
  width: number;
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
function doorway(s0: number, s1: number, r: Rng, preferred?: number): { c: number; w: number } {
  const span = s1 - s0;
  const w = Math.min(DOOR_W, Math.max(0.7, span - 0.4));
  const lo = s0 + 0.2 + w / 2, hi = s1 - 0.2 - w / 2;
  const c = hi <= lo ? (s0 + s1) / 2
    : preferred === undefined ? lo + r() * (hi - lo) : Math.max(lo, Math.min(hi, preferred));
  return { c, w };
}

/**
 * Partition `area` (an already-inset bbox) into up to `target` rooms on a grid,
 * returning the room rects plus the partition walls (one per shared cell edge,
 * each already carrying a doorway). `target` is clamped so no room is thinner
 * than MIN_ROOM.
 */
export function partition(area: Rect, target: number, r: Rng, entryVista?: Rect | null): { rooms: Rect[]; walls: Wall[]; portals: Portal[] } {
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
      // A partition running lengthwise inside the front-door sightline would be
      // a permanent wall beside/through the player's capsule. Treat that shared
      // room edge as fully open; the rooms remain distinct furnishing zones.
      const alongEntry = !!entryVista && xs[c] >= entryVista.x0 && xs[c] <= entryVista.x1
        && zs[rr] < entryVista.z1 && zs[rr + 1] > entryVista.z0;
      const dw = alongEntry
        ? { c: (zs[rr] + zs[rr + 1]) / 2, w: zs[rr + 1] - zs[rr] }
        : doorway(zs[rr], zs[rr + 1], r);
      walls.push({ axis: "z", line: xs[c], s0: zs[rr], s1: zs[rr + 1], door: dw.c, doorW: dw.w,
        a: (c - 1) * rows + rr, b: c * rows + rr });
    }
  // horizontal partitions (constant z) between rows, one segment per column
  for (let rr = 1; rr < rows; rr++)
    for (let c = 0; c < cols; c++) {
      // Crossing partitions keep a normal 1.5 m portal, centred on the portion
      // of the entry vista that actually meets this room span. This creates a
      // readable sequence of aligned openings without turning every plan into a
      // corridor.
      const crossesEntry = !!entryVista && zs[rr] >= entryVista.z0 && zs[rr] <= entryVista.z1
        && xs[c] < entryVista.x1 && xs[c + 1] > entryVista.x0;
      const overlap0 = entryVista ? Math.max(xs[c], entryVista.x0) : 0;
      const overlap1 = entryVista ? Math.min(xs[c + 1], entryVista.x1) : 0;
      const preferred = crossesEntry ? (overlap0 + overlap1) / 2 : undefined;
      let dw = doorway(xs[c], xs[c + 1], r, preferred);
      if (preferred !== undefined) {
        const clearL = dw.c - dw.w / 2, clearR = dw.c + dw.w / 2;
        // Very short room spans can clamp the portal away from the desired axis,
        // leaving a thin jamb inside the capsule's view. In that rare case a
        // fully open shared edge is cleaner than a visibly off-centre doorway.
        if (clearL > preferred - 0.42 || clearR < preferred + 0.42)
          dw = { c: (xs[c] + xs[c + 1]) / 2, w: xs[c + 1] - xs[c] };
      }
      walls.push({ axis: "x", line: zs[rr], s0: xs[c], s1: xs[c + 1], door: dw.c, doorW: dw.w,
        a: c * rows + rr - 1, b: c * rows + rr });
    }
  const portals: Portal[] = walls.map((w, id) => ({
    id, a: w.a, b: w.b, axis: w.axis, line: w.line, center: w.door, width: w.doorW,
    keepout: w.axis === "x"
      ? rectAround(w.door, w.line, Math.max(CIRCULATION_W, w.doorW), APPROACH_D * 2)
      : rectAround(w.line, w.door, APPROACH_D * 2, Math.max(CIRCULATION_W, w.doorW)),
  }));
  return { rooms, walls, portals };
}

function dist2ToRect(r: Rect, x: number, z: number): number {
  const dx = x < r.x0 ? r.x0 - x : x > r.x1 ? x - r.x1 : 0;
  const dz = z < r.z0 ? r.z0 - z : z > r.z1 ? z - r.z1 : 0;
  return dx * dx + dz * dz;
}

/** Two overlapping axis-aligned strips make a generous L route inside one room. */
function route(cell: Rect, a: readonly [number, number], b: readonly [number, number], xFirst: boolean): Rect[] {
  const h = CIRCULATION_W / 2;
  const aa = clampPoint(cell, a[0], a[1], h);
  const bb = clampPoint(cell, b[0], b[1], h);
  const elbow: readonly [number, number] = xFirst ? [bb[0], aa[1]] : [aa[0], bb[1]];
  const strip = (p: readonly [number, number], q: readonly [number, number]): Rect => ({
    x0: Math.min(p[0], q[0]) - h, x1: Math.max(p[0], q[0]) + h,
    z0: Math.min(p[1], q[1]) - h, z1: Math.max(p[1], q[1]) + h,
  });
  const out: Rect[] = [];
  for (const candidate of [strip(aa, elbow), strip(elbow, bb)]) {
    const clipped = intersectRect(candidate, cell);
    if (clipped) out.push(clipped);
  }
  return out;
}

/**
 * Build the circulation contract before any prop is placed.  Every room owns a
 * central hub; each incident portal, the front entrance and the stair landing are
 * joined to that hub by 1.2 m strips. Since every partition edge exposes a Portal,
 * the room graph and the physical clear route are connected by construction.
 */
export function planCirculation(
  rooms: Rect[], portals: Portal[], entry: EntryAccess | null, stair: StairAccess | null,
): CirculationPlan {
  const byRoom = rooms.map(() => [] as Rect[]);
  const hubs = rooms.map((r) => [rectCX(r), rectCZ(r)] as const);
  for (let i = 0; i < rooms.length; i++) {
    const hub = rectAround(hubs[i][0], hubs[i][1], CIRCULATION_W, CIRCULATION_W);
    const clipped = intersectRect(hub, rooms[i]);
    if (clipped) byRoom[i].push(clipped);
  }

  const connect = (room: number, point: readonly [number, number], extra?: Rect) => {
    if (!rooms[room]) return;
    if (extra) { const c = intersectRect(extra, rooms[room]); if (c) byRoom[room].push(c); }
    const xFirst = rectW(rooms[room]) >= rectD(rooms[room]);
    byRoom[room].push(...route(rooms[room], hubs[room], point, xFirst));
  };

  for (const p of portals) {
    const point = p.axis === "x" ? [p.center, p.line] as const : [p.line, p.center] as const;
    connect(p.a, point, p.keepout);
    connect(p.b, point, p.keepout);
  }

  let entryRoom = -1;
  if (entry && rooms.length) {
    let best = Infinity;
    for (let i = 0; i < rooms.length; i++) {
      const d2 = dist2ToRect(rooms[i], entry.point[0], entry.point[1]);
      if (d2 < best) { best = d2; entryRoom = i; }
    }
    connect(entryRoom, entry.point, entry.keepout);
  }
  if (stair && rooms[stair.room]) connect(stair.room, stair.point, stair.keepout);

  return { byRoom, hubs, entryRoom, width: CIRCULATION_W };
}

/** one solid wall span (a box of material int.wall) with an optional collider. */
function wallSpan(
  out: PanelBuilder, cols: ColliderBox[] | null,
  mat: string, axis: Axis, line: number, s0: number, s1: number, y0: number, y1: number,
): void {
  if (s1 - s0 < 0.04 || y1 - y0 < 0.04) return;
  const cy = (y0 + y1) / 2, hy = (y1 - y0) / 2;
  const cs = (s0 + s1) / 2, hs = (s1 - s0) / 2;
  if (axis === "x") addBox(out, cols, mat, cs, cy, line, hs, hy, WALL_T);
  else addBox(out, cols, mat, line, cy, cs, WALL_T, hy, hs);
}

/**
 * Build all partition walls for one floor at height `floorY`. Each wall is split
 * into the solid spans on either side of its doorway (colliders on those), with
 * a header/lintel above the opening (no collider — it clears a 1.8 m capsule).
 */
export function buildWalls(
  out: PanelBuilder, cols: ColliderBox[], walls: Wall[], floorY: number,
  trim = "int.trim", wallMat = "int.wall", wallHeight = WALL_H,
): void {
  const yTop = floorY + wallHeight;
  for (const wl of walls) {
    const d0 = wl.door - wl.doorW / 2, d1 = wl.door + wl.doorW / 2;
    const openable = d1 < wl.s1 - 0.02 || d0 > wl.s0 + 0.02;
    if (openable) {
      wallSpan(out, cols, wallMat, wl.axis, wl.line, wl.s0, d0, floorY, yTop);
      wallSpan(out, cols, wallMat, wl.axis, wl.line, d1, wl.s1, floorY, yTop);
      const lintel = floorY + DOOR_H;
      wallSpan(out, null, wallMat, wl.axis, wl.line, d0, d1, lintel, yTop); // header over the door
      // slim casing makes the room transition intentional instead of a raw hole.
      const h = DOOR_H / 2;
      if (wl.axis === "x") {
        addBox(out, null, trim, d0, floorY + h, wl.line, 0.045, h, WALL_T + 0.025);
        addBox(out, null, trim, d1, floorY + h, wl.line, 0.045, h, WALL_T + 0.025);
        addBox(out, null, trim, wl.door, floorY + DOOR_H + 0.045, wl.line, wl.doorW / 2 + 0.045, 0.045, WALL_T + 0.025);
      } else {
        addBox(out, null, trim, wl.line, floorY + h, d0, WALL_T + 0.025, h, 0.045);
        addBox(out, null, trim, wl.line, floorY + h, d1, WALL_T + 0.025, h, 0.045);
        addBox(out, null, trim, wl.line, floorY + DOOR_H + 0.045, wl.door, WALL_T + 0.025, 0.045, wl.doorW / 2 + 0.045);
      }
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
  tris: number[], y: number, bb: Rect, mat = "int.floor",
): void {
  const verts: Vec3[] = poly.map(([x, z]) => [x, y, z]);
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const a = verts[tris[t]], c = verts[tris[t + 1]], d = verts[tris[t + 2]];
    out.quad(mat, a, c, d, a, [0, 1, 0]);
  }
  cols.push({ x: rectCX(bb), y: y - SLAB, z: rectCZ(bb), hx: rectW(bb) / 2, hy: SLAB, hz: rectD(bb) / 2, yaw: 0 });
}
