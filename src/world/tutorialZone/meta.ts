/**
 * Boot-safe metadata for the lazy tutorial zone — the flight school on the old
 * Crissy Field airfield. Kept import-free so main/optionalSites can name the
 * place (approach radius, minimap, arrival pose) without pulling the site's
 * geometry chunk in.
 *
 * The plot was chosen by sampling the terrain: a 220 × 140 m rectangle whose
 * ground runs 2.6 → 5.0 m with no roads and 145 m of clearance from the nearest
 * OSM footprint. It is the flattest large lawn inside the city proper, and it
 * is the field the Army actually used to teach people to fly.
 */

/** Zone origin — local (u, v) is (east, south) metres from here. */
export const TUTORIAL_ZONE_CENTER = { x: -1560, z: -1560 } as const;

/**
 * Half-extents of the authored plot, local metres. The east–west span reaches
 * past the entrance so the arrival stands inside the place it names; sampled
 * ground over this rectangle runs 1.8 → 5.0 m, all of it dry and near-level.
 */
export const TUTORIAL_ZONE_HALF_U = 124;
export const TUTORIAL_ZONE_HALF_V = 70;

/**
 * Where the 🎓 button lands you: on the entrance path well back from the west
 * gate, facing east down the whole zone so the first frame reads as a place.
 * Far enough out that the arch frames the field instead of filling the screen
 * (it stands at u = −90 and is 5.2 m tall).
 * Heading convention is the spawn table's (forward = (−sin θ, −cos θ)), so
 * −π/2 faces +x.
 */
export const TUTORIAL_ZONE_ARRIVAL = {
  x: TUTORIAL_ZONE_CENTER.x - 112,
  z: TUTORIAL_ZONE_CENTER.z,
  heading: -Math.PI / 2
} as const;

/** Distance from the zone centre, for prompts and the "you left" check. */
export function distanceToTutorialZone(x: number, z: number): number {
  const du = Math.max(Math.abs(x - TUTORIAL_ZONE_CENTER.x) - TUTORIAL_ZONE_HALF_U, 0);
  const dv = Math.max(Math.abs(z - TUTORIAL_ZONE_CENTER.z) - TUTORIAL_ZONE_HALF_V, 0);
  return Math.hypot(du, dv);
}
