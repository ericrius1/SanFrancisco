// Building → collider boxes. One oriented wall box per footprint edge (yawed to
// the edge) plus a ground pad — precise to the REAL polygon, so a car hitting a
// re-entrant façade stops on the actual wall instead of a bbox. With `door`, the
// street-facing edge (longest) gets a walk-through gap: its wall becomes two side
// segments + a lintel above the opening, so the player can enter. Pure, no THREE.
import type { BuildingSpec, ColliderBox } from "./types";
import { ensureCCW, streetEdgeIndex } from "./footprint";

const WALL_T = 0.25; // wall half-thickness (metres)

/** THE single source of truth for where the front door goes on an edge of length
 *  `len` (a building base→top). Both the collider gap and the visible door (the
 *  theme's frontDoor) read this so they line up exactly. */
export function doorMetrics(len: number, base: number, top: number): { tc: number; halfW: number; head: number } {
  return {
    tc: len > 6 ? 0.24 : 0.5,               // door centre fraction along the edge
    halfW: Math.min(0.9, len * 0.16),       // half the door width (metres)
    head: Math.min(2.5, (top - base) * 0.55), // door head height above base
  };
}

/** Minimal shape the door predicate needs — a theme's FacadeEdge satisfies it,
 *  and the collider builds a matching literal per polygon edge. */
export interface DoorEdge {
  isStreet: boolean;
  length: number;
  base: number;
  top: number;
  /** highest ground under the footprint (defaults to base) */
  grade?: number;
}

/** THE single predicate for "this edge gets a front door" — called by BOTH the
 *  collider (walk-through gap) and every theme façade (visible door + wall hole),
 *  so a collider gap exists IFF a visible doorway is drawn. Requires the street
 *  edge, enough length for a leaf, and enough of the opening clearing the ground
 *  line to be a usable entrance (a heavily-buried hillside base takes no door on
 *  either side and stays a solid skirt). */
export function doorEligible(e: DoorEdge): boolean {
  if (!e.isStreet || e.length <= 2.2) return false;
  const grade = e.grade ?? e.base;
  const { head } = doorMetrics(e.length, e.base, e.top);
  return e.base + head - Math.max(e.base, grade) > 0.8;
}

export interface DoorOpening {
  /** which edge got the door (longest / street), for the caller to place the visual */
  edge: number;
  /** door centre fraction along that edge, and half-width in metres */
  tCenter: number; halfW: number;
  /** door head height above base (walk-through clearance) */
  head: number;
}

/** Oriented wall boxes + ground pad. If `withDoor`, cut a doorway in the street
 *  edge and return where it is (so the theme can align the visual door). */
export function buildingColliders(spec: BuildingSpec, withDoor = false): { boxes: ColliderBox[]; door: DoorOpening | null } {
  const poly = ensureCCW(spec.poly);
  const base = spec.base;
  const top = spec.top;
  const midY = (base + top) / 2;
  const halfH = Math.max(0.1, (top - base) / 2);
  const boxes: ColliderBox[] = [];
  const streetI = withDoor ? streetEdgeIndex(poly) : -1;
  let door: DoorOpening | null = null;

  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % poly.length];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.3) continue;
    const yaw = Math.atan2(dz, dx);
    const ux = dx / len, uz = dz / len; // unit along edge

    if (doorEligible({ isStreet: i === streetI, length: len, base, top, grade: spec.grade })) {
      // doorway split: door centred (offset for wide lots) with a lintel above
      const { tc, halfW, head } = doorMetrics(len, base, top);
      const dCenter = tc * len;                  // metres from p0
      const gapL = dCenter - halfW, gapR = dCenter + halfW;
      const midHalf = halfH, ly = midY;
      // left segment (p0 → gapL)
      if (gapL > 0.15) {
        const s = gapL / 2;
        boxes.push({ x: p0[0] + ux * s, y: ly, z: p0[1] + uz * s, hx: s, hy: midHalf, hz: WALL_T, yaw });
      }
      // right segment (gapR → end)
      if (len - gapR > 0.15) {
        const s = (len - gapR) / 2;
        boxes.push({ x: p0[0] + ux * (gapR + s), y: ly, z: p0[1] + uz * (gapR + s), hx: s, hy: midHalf, hz: WALL_T, yaw });
      }
      // lintel above the opening (head → top)
      const lintelH = Math.max(0.05, (top - (base + head)) / 2);
      boxes.push({ x: p0[0] + ux * dCenter, y: base + head + lintelH, z: p0[1] + uz * dCenter, hx: halfW, hy: lintelH, hz: WALL_T, yaw });
      door = { edge: i, tCenter: tc, halfW, head };
    } else {
      boxes.push({ x: (p0[0] + p1[0]) / 2, y: midY, z: (p0[1] + p1[1]) / 2, hx: len / 2, hy: halfH, hz: WALL_T, yaw });
    }
  }

  // ground pad — keeps a car that mounts the footprint from sinking
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const [x, z] of poly) {
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  boxes.push({ x: (minx + maxx) / 2, y: base - 0.15, z: (minz + maxz) / 2, hx: (maxx - minx) / 2, hy: 0.15, hz: (maxz - minz) / 2, yaw: 0 });

  return { boxes, door };
}
