import type { HullSpec } from '../boat/buoyancy';
export const YACHT_HULL: HullSpec = { halfLength:37, halfBeam:9.5, draft:2.1, freeboard:3.15, rideHeight:.15 };

/** Sealed cabins only: the cut stays strictly inside the actual hull footprint. */
export const YACHT_CABIN_MIN = [-6.7, -3, -24.1] as const;
export const YACHT_CABIN_MAX = [6.7, 7.1, 12] as const;
