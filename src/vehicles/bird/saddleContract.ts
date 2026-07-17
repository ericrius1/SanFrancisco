/**
 * Phoenix saddle anchors in bird-root local space. The driver sits forward;
 * two friends share the wider rear bench. Keep these anchors independent of
 * the lazily loaded saddle art so multiplayer can resolve seats before the GLB
 * has finished hydrating.
 */
export const PHOENIX_DRIVER_SEAT = [0, 0.96, -0.48] as const;
export const PHOENIX_PASSENGER_SEATS = [
  [-0.56, 0.94, 0.42],
  [0.56, 0.94, 0.42]
] as const;

export const PHOENIX_PASSENGER_CAPACITY = PHOENIX_PASSENGER_SEATS.length;
