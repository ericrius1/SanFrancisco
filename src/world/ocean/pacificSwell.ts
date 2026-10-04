import { OCEAN_BEACH_SURF } from "../oceanBeachWaves";

/**
 * Open-Pacific ground swell (CPU half; the GPU twin is pacificSwellNode.ts and
 * must stay in lockstep — boats, boards and swimmers ride THIS height while
 * the renderer displaces and shades with the twin).
 *
 * Outside the Golden Gate the sea is not the bay: long-period swell generated
 * by storms a thousand kilometres out rolls in under the wind sea. Two trains
 * — a 13 s westerly (≈264 m crests) and a 10 s west-southwesterly (≈156 m) —
 * beat against each other into sets. They fade through the strait (a rotated
 * u = x − 0.45·z front that runs from Fort Point to Lime Point, so Richardson
 * Bay and the Marina stay calm), die in shoaling water, and yield entirely to
 * the authored Ocean Beach surf strip, which already owns its own sets.
 */

export const PACIFIC_SWELL = {
  /** Mask front: fully open ocean at u ≤ uOpen, bay at u ≥ uBay. */
  uOpen: -2700,
  uBay: -1200,
  /** Depth band (m) over which the swell builds from shore to open water. */
  shoalMin: 2.5,
  shoalMax: 14,
  trains: [
    // amplitude (m), wavenumber k (rad/m), angular freq ω (rad/s), dir x, dir z, phase
    { a: 0.78, k: 0.0238, w: 0.483, dx: 0.98, dz: 0.2, p: 0 },
    { a: 0.38, k: 0.0403, w: 0.628, dx: 0.94, dz: -0.34, p: 1.7 }
  ],
  stripFeather: 60
} as const;

let floorSampler: ((x: number, z: number) => number) | null = null;

/** The bathymetry the shoaling fade reads (the water module registers the map). */
export function setPacificSwellFloor(sample: ((x: number, z: number) => number) | null): void {
  floorSampler = sample;
}

function smooth01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** 0 in the bay … 1 on the open Pacific (shoaling and surf strip excluded). */
export function pacificSwellMask(x: number, z: number): number {
  const s = PACIFIC_SWELL;
  const u = x - 0.45 * z;
  const open = smooth01((s.uBay - u) / (s.uBay - s.uOpen));
  if (open <= 0) return 0;
  const b = OCEAN_BEACH_SURF;
  const f = s.stripFeather;
  const inStrip =
    smooth01((x - (b.minX - f)) / f) * (1 - smooth01((x - b.maxX) / f)) *
    smooth01((z - (b.minZ - f)) / f) * (1 - smooth01((z - b.maxZ) / f));
  return open * (1 - inStrip);
}

/** Shoaling fade from the sea floor height under (x,z). */
export function pacificSwellShoal(floorHeight: number): number {
  const s = PACIFIC_SWELL;
  return smooth01((-floorHeight - s.shoalMin) / (s.shoalMax - s.shoalMin));
}

/** Ground-swell height (m) at world (x,z), sea time t. */
export function pacificSwellHeight(x: number, z: number, t: number): number {
  const mask = pacificSwellMask(x, z);
  if (mask <= 0) return 0;
  const shoal = floorSampler ? pacificSwellShoal(floorSampler(x, z)) : 1;
  if (shoal <= 0) return 0;
  let h = 0;
  for (const tr of PACIFIC_SWELL.trains) {
    h += tr.a * Math.sin(tr.k * (tr.dx * x + tr.dz * z) - tr.w * t + tr.p);
  }
  return h * mask * shoal;
}
