// Shared interior primitives: dimensions, the axis-aligned Rect used to lay out
// rooms, and the one box-emitter every interior part calls. City-agnostic, no
// THREE, no textures — just geometry + collider records keyed by material id.
import type { ColliderBox } from "../core/types";
import { PanelBuilder } from "../core/facade";

// --- storey + partition dimensions (metres) --------------------------------
export const FLOOR_H = 3.4;   // storey height (matches the exterior grammar)
export const MAX_FLOORS = 4;  // furnish at most ground + 3 up (budget cap)
export const SLAB = 0.09;     // floor-slab half-thickness
export const WALL_H = 2.6;    // interior partition height (below the ceiling)
export const WALL_T = 0.05;   // partition half-thickness
export const DOOR_W = 1.0;    // clear doorway width
export const DOOR_H = 2.05;   // clear doorway height (a 1.8 m capsule + headroom)
export const INSET = 0.3;     // keep the interior clear of the exterior shell
export const EYE = 1.6;       // picture-hanging / eye height

/** an axis-aligned floorplan rectangle in world x/z (metres). */
export interface Rect { x0: number; x1: number; z0: number; z1: number; }

export const rectW = (r: Rect): number => r.x1 - r.x0;
export const rectD = (r: Rect): number => r.z1 - r.z0;
export const rectCX = (r: Rect): number => (r.x0 + r.x1) / 2;
export const rectCZ = (r: Rect): number => (r.z0 + r.z1) / 2;
export const rectMinDim = (r: Rect): number => Math.min(rectW(r), rectD(r));
export const rectArea = (r: Rect): number => rectW(r) * rectD(r);

/** bounding box of a footprint ring. */
export function bboxOf(poly: readonly (readonly [number, number])[]): Rect {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of poly) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}

/** shrink a rect inward by `d` on all sides (never past its centre). */
export function inset(r: Rect, d: number): Rect {
  const dx = Math.min(d, rectW(r) / 2 - 0.05);
  const dz = Math.min(d, rectD(r) / 2 - 0.05);
  return { x0: r.x0 + dx, x1: r.x1 - dx, z0: r.z0 + dz, z1: r.z1 - dz };
}

/** do two rects overlap (open intersection, small epsilon)? */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 - 1e-4 && a.x1 > b.x0 + 1e-4 && a.z0 < b.z1 - 1e-4 && a.z1 > b.z0 + 1e-4;
}

/**
 * Emit one axis-aligned solid box (all 6 faces) into `out`, and — when `cols`
 * is non-null — a matching collider. This is THE interior workhorse: floors,
 * walls, stair treads and furniture are all boxes, so collider parity with the
 * mesh is automatic (same centre + half-extents).
 */
export function addBox(
  out: PanelBuilder, cols: ColliderBox[] | null, mat: string,
  cx: number, cy: number, cz: number, hx: number, hy: number, hz: number,
): void {
  out.box(mat, [cx, cy, cz], [hx, hy, hz], [1, 0, 0], [0, 1, 0], [0, 0, 1], false);
  if (cols) cols.push({ x: cx, y: cy, z: cz, hx, hy, hz, yaw: 0 });
}
