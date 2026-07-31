/**
 * Boot-safe metadata for the Golden Gate Park skatepark. Numbers only — the
 * geometry, the ground overlay and the grind rails all live behind the
 * optional-site dynamic import.
 *
 * Sited on the open dune shelf in the west end of Golden Gate Park, a couple
 * of hundred metres behind the archery range's shooting line. That is a
 * deliberate engineering choice as much as a scenic one: a plaza has to raise
 * and grade the ground it sits on, and the downtown waterfront blocks are
 * already layered with authored decks and citygen colliders that a runtime
 * ground sheet fights with — bodies wedge on the result. Out here the ground
 * is the map's own terrain and nothing else claims it, so the graded slab,
 * the physics carpet and the granite you can see all agree.
 */
export const SKATE_PLAZA_CENTER = { x: -5647, z: 2179 } as const;

/** Tutorial arrival: on the open street-course deck, already facing into it. */
export const SKATE_PLAZA_ARRIVAL = {
  x: SKATE_PLAZA_CENTER.x,
  z: SKATE_PLAZA_CENTER.z - 10,
  heading: 0
} as const;

/** Plaza yaw (radians). Angled off the world axes so it reads as authored. */
export const SKATE_PLAZA_YAW = 0.28;

/** Inner (fully graded) half-extents and the taper ring outside them. */
export const SKATE_PLAZA_PAD = { hx: 24, hz: 15, taper: 8, kerb: 0.12 } as const;

/** Conservative planar radius used for the ground-overlay early-out. */
export const SKATE_PLAZA_RADIUS =
  Math.hypot(SKATE_PLAZA_PAD.hx + SKATE_PLAZA_PAD.taper, SKATE_PLAZA_PAD.hz + SKATE_PLAZA_PAD.taper);

/**
 * Is (x, z) on the plaza's graded footprint?
 *
 * Pure geometry over the constants above — no plaza instance required — so the
 * region systems that plant Golden Gate Park can keep their trees and blades
 * off the granite from boot, long before the plaza itself streams in. A tree
 * growing out of the middle of a skate plaza is exactly the kind of thing a
 * lazily-loaded site cannot fix after the fact.
 */
export function inSkatePlazaFootprint(x: number, z: number, margin = 0): boolean {
  const dx = x - SKATE_PLAZA_CENTER.x;
  const dz = z - SKATE_PLAZA_CENTER.z;
  const c = Math.cos(SKATE_PLAZA_YAW);
  const s = Math.sin(SKATE_PLAZA_YAW);
  const lx = Math.abs(dx * c - dz * s);
  const lz = Math.abs(dx * s + dz * c);
  const { hx, hz, taper } = SKATE_PLAZA_PAD;
  return lx <= hx + taper + margin && lz <= hz + taper + margin;
}
