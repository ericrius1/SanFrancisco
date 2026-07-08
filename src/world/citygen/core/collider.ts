// Building → collider boxes. Phase 1 emits one oriented wall box per footprint
// edge (yawed to the edge) plus a ground pad — precise to the REAL polygon, so a
// car hitting a re-entrant façade stops on the actual wall instead of a bbox that
// either overhangs the sidewalk or leaves a gap. Interior floor/stair colliders
// arrive with the walkable-interior phase (Phase 4/5). Pure, no THREE.
import type { BuildingSpec, ColliderBox } from "./types";
import { ensureCCW } from "./footprint";

const WALL_T = 0.25; // wall half-thickness (metres)

/** Oriented wall boxes + ground pad in the host world frame. */
export function buildingColliders(spec: BuildingSpec): ColliderBox[] {
  const poly = ensureCCW(spec.poly);
  const base = spec.base;
  const top = spec.top;
  const midY = (base + top) / 2;
  const halfH = Math.max(0.1, (top - base) / 2);
  const boxes: ColliderBox[] = [];

  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % poly.length];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.3) continue; // skip degenerate micro-edges
    const yaw = Math.atan2(dz, dx); // edge direction about +Y
    boxes.push({
      x: (p0[0] + p1[0]) / 2,
      y: midY,
      z: (p0[1] + p1[1]) / 2,
      hx: len / 2,
      hy: halfH,
      hz: WALL_T,
      yaw,
    });
  }

  // ground pad — keeps a car that mounts the footprint from sinking to base-2m
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const [x, z] of poly) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  boxes.push({
    x: (minx + maxx) / 2, y: base - 0.15, z: (minz + maxz) / 2,
    hx: (maxx - minx) / 2, hy: 0.15, hz: (maxz - minz) / 2, yaw: 0,
  });

  return boxes;
}
