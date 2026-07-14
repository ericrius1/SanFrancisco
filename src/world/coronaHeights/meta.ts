export type CoronaXZ = readonly [x: number, z: number];

/** Highest rendered point in the shipped heightfield. */
export const CORONA_HEIGHTS_SUMMIT = { x: 408, z: 2760 } as const;

/** OSM way 38025784 — Corona Heights Dog Play Area. */
export const CORONA_DOG_PARK: readonly CoronaXZ[] = [
  [325.72, 2728.49],
  [330.12, 2729.44],
  [339.39, 2730.28],
  [358.81, 2718.47],
  [387.78, 2707.78],
  [401.72, 2705.57],
  [410.71, 2706.15],
  [405.81, 2695.76],
  [410.34, 2682.36],
  [408.82, 2678.87],
  [399.63, 2678.48],
  [386.37, 2682.08],
  [358.43, 2694.09],
  [341.07, 2707.59],
  [330.49, 2720.34]
] as const;
