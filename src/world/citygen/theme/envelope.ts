// Silhouette-sized architecture shared by the detailed grammar and landscape
// mesh. Small brackets, window frames and vents remain in the close tier.
import type { FacadeEdge, Vec3 } from "../core/facade";
import { pointOnWall, outset, floorBands } from "../core/facade";

export function isLargeCommercial(e: FacadeEdge): boolean {
  return e.top - e.base >= 24 || e.floors >= 7 || (e.length >= 32 && e.floors >= 4);
}

/** Exact stone-base split used by both tiers of a large commercial facade. */
export function commercialBaseTop(e: FacadeEdge): number {
  const visibleH = e.top - e.grade;
  const bands = floorBands(e);
  const count = e.top - e.base >= 26 ? 2 : 1;
  const candidate = bands[Math.min(count, bands.length) - 1]?.y1 ?? e.base + e.arch.floorH;
  return Math.min(e.grade + visibleH * 0.55,
    Math.max(e.grade + Math.min(visibleH * 0.45, e.arch.floorH * 0.9), candidate));
}

export function cantedBay(e: FacadeEdge): { wallL: Vec3; frontL: Vec3; frontR: Vec3; wallR: Vec3 } {
  return {
    wallL: pointOnWall(e, 0.30, 0),
    frontL: outset(pointOnWall(e, 0.38, 0), e, e.arch.bayProjection ?? 0),
    frontR: outset(pointOnWall(e, 0.62, 0), e, e.arch.bayProjection ?? 0),
    wallR: pointOnWall(e, 0.70, 0),
  };
}

export interface CorniceCrown { center: Vec3; half: Vec3; }
export function corniceCrown(e: FacadeEdge, projection: number, parapet = false): CorniceCrown {
  return {
    center: [
      (e.p0[0] + e.p1[0]) / 2 + e.normal[0] * projection * (parapet ? 0.4 : 0.5),
      e.top - 0.05 + (parapet ? 0.35 : 0.16),
      (e.p0[1] + e.p1[1]) / 2 + e.normal[1] * projection * (parapet ? 0.4 : 0.5),
    ],
    half: [e.length / 2 + (parapet ? 0.08 : 0.05), parapet ? 0.4 : 0.16, projection * (parapet ? 0.7 : 1)],
  };
}
