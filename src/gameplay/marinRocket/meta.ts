import type { WorldMap } from "../../world/heightmap";

/** Open western shoulder of the Marin Headlands, clear of the tunnel portals
 * and the denser redwood valleys. The launch heading points out over the
 * Pacific so the first powered climb clears the landscape. */
export const MARIN_ROCKET_SITE = {
  x: -4_640,
  z: -5_690,
  heading: Math.PI / 2
} as const;

export const MARIN_ROCKET_LABEL = "Marin Orbital Launch Field";

// Exact baked DEM sample at the pad center. Optional sites can hydrate before
// their high-resolution terrain tile arrives, when baseGroundTop still reads
// the coarser overview; anchoring authored hard-surface geometry avoids a later
// 1–2 m terrain pop burying the apron.
export const MARIN_ROCKET_PAD_GROUND_Y = 82.57;

export const MARIN_ROCKET_ARRIVAL = {
  x: MARIN_ROCKET_SITE.x + 18,
  z: MARIN_ROCKET_SITE.z + 4,
  heading: MARIN_ROCKET_SITE.heading
} as const;

export function marinRocketArrivalForDestination(
  map: WorldMap,
  x: number,
  z: number,
  label?: string
): { x: number; y: number; z: number; heading: number } | null {
  const named = label?.trim().toLocaleLowerCase() === MARIN_ROCKET_LABEL.toLocaleLowerCase();
  const pinned = Math.hypot(x - MARIN_ROCKET_SITE.x, z - MARIN_ROCKET_SITE.z) <= 14;
  if (!named && !pinned) return null;
  return {
    ...MARIN_ROCKET_ARRIVAL,
    y: map.effectiveGround(MARIN_ROCKET_ARRIVAL.x, MARIN_ROCKET_ARRIVAL.z) + 1.5
  };
}
