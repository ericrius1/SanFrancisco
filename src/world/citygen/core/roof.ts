import type { ArchetypeSpec, Vec2 } from "./types";
import type { Vec3 } from "./facade";
import { centroid } from "./footprint";

export interface RoofVolume { materialId: string; center: Vec3; half: Vec3; skipBottom: boolean; }

/** small deterministic rooftop props inside a footprint (flat roofs). */
export function roofVolumes(poly: Vec2[], top: number, seed: number, arch: ArchetypeSpec): RoofVolume[] {
  const [cx, cz] = centroid(poly);
  const rng = edgeRng(seed, 97);
  const volumes: RoofVolume[] = [];
  const add = (materialId: string, center: Vec3, half: Vec3, skipBottom = true) => {
    volumes.push({ materialId, center, half, skipBottom });
  };
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const [x, z] of poly) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (z < minz) minz = z; if (z > maxz) maxz = z; }
  const w = maxx - minx, d = maxz - minz;
  if (w < 4 || d < 4) return volumes; // too small to clutter
  // keep props inside the footprint bbox with an inset (concave overhang is minor)
  const spot = (fx: number, fz: number): [number, number] => [
    Math.min(maxx - 0.9, Math.max(minx + 0.9, cx + fx)),
    Math.min(maxz - 0.9, Math.max(minz + 0.9, cz + fz)),
  ];
  // stairwell bulkhead near centre
  const [bx, bz] = spot((rng() - 0.5) * w * 0.3, (rng() - 0.5) * d * 0.3);
  // These are freestanding roof volumes, so every vertical side must render.
  // Their bottom is supplied by the roof cap itself; emitting another DoubleSide
  // face at exactly `top` causes the close-range z-fighting seen from the board.
  add(arch.roofMaterial, [bx, top + 0.9, bz], [0.9, 0.9, 1.1]);
  // a couple of low vents
  const nv = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < nv; i++) {
    const [vx, vz] = spot((rng() - 0.5) * w * 0.7, (rng() - 0.5) * d * 0.7);
    add("roof.flatTrim", [vx, top + 0.35, vz], [0.35, 0.35, 0.35]);
  }
  // ~30%: a wooden rooftop water tank (a box on stubby legs, iconic on SF/Bay roofs)
  if (rng() < 0.3 && w > 6 && d > 6) {
    const [tx, tz] = spot((rng() - 0.5) * w * 0.5, (rng() - 0.5) * d * 0.5);
    add("int.wood", [tx, top + 1.5, tz], [0.7, 0.9, 0.7], false);          // tank
    add("int.wood", [tx, top + 0.35, tz], [0.75, 0.35, 0.75]); // frame base
  }
  return volumes;
}

// local mulberry32 salted per edge (avoids importing rng cycle concerns)
function edgeRng(seed: number, salt: number): () => number {
  let a = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
