import { tunables } from "../../core/persist";

/**
 * Street skating, tuned for the shape of San Francisco: a push is a real kick
 * (a discrete shove, not a throttle), flat ground bleeds speed, and gravity
 * along the terrain grade is the ONLY way to get properly fast. Bombing a
 * Castro-grade hill should pin you at `maxSpeed`; pushing on the flat tops out
 * near `pushSpeed` and no further.
 */
export const SKATE_TUNING = tunables("movement.skate", {
  maxSpeed: { v: 27, min: 6, max: 60, step: 0.5, label: "top speed" },
  pushSpeed: { v: 11.5, min: 3, max: 30, step: 0.5, label: "push top speed" },
  pushKick: { v: 3.4, min: 0.5, max: 10, step: 0.1, label: "push kick" },
  pushInterval: { v: 0.58, min: 0.2, max: 1.5, step: 0.02, label: "push cadence" },
  brake: { v: 13, min: 2, max: 40, step: 0.5, label: "brake" },
  // Coast drag is deliberately tiny: rolling should feel like urethane, so a
  // hill's speed survives the flat at the bottom of it.
  rollDrag: { v: 0.12, min: 0.02, max: 2, step: 0.01, label: "roll drag" },
  // Extra drag once you are past what pushing can achieve — keeps a bomb from
  // running away forever without capping the fun part.
  fastDrag: { v: 0.06, min: 0, max: 2, step: 0.01, label: "high-speed drag" },
  gravity: { v: 19, min: 6, max: 40, step: 0.5, label: "gravity" },
  /** Fraction of gravity that acts along the grade (1 = frictionless slope). */
  slopePull: { v: 0.78, min: 0, max: 1.5, step: 0.02, label: "hill pull" },
  steerRate: { v: 1.9, min: 0.4, max: 6, step: 0.05, label: "carve rate" },
  carveLean: { v: 0.5, min: 0, max: 1.4, step: 0.02, label: "carve lean" },
  /** How hard a hard carve scrubs speed (powerslides bleed more). */
  carveScrub: { v: 0.55, min: 0, max: 3, step: 0.05, label: "carve scrub" },
  slideScrub: { v: 5.5, min: 0.5, max: 20, step: 0.1, label: "powerslide scrub" },

  // --- ollie ---------------------------------------------------------------
  ollieMin: { v: 5.4, min: 2, max: 14, step: 0.1, label: "ollie (tap)" },
  ollieMax: { v: 8.8, min: 3, max: 22, step: 0.1, label: "ollie (charged)" },
  ollieCharge: { v: 0.36, min: 0.1, max: 1.2, step: 0.02, label: "crouch time" },
  /** Speed bonus folded into the pop, so hauling into a gap sends you. */
  ollieSpeedBoost: { v: 0.1, min: 0, max: 0.5, step: 0.01, label: "ollie speed bonus" },

  // --- air -----------------------------------------------------------------
  airSpin: { v: 4.2, min: 1, max: 12, step: 0.1, label: "air spin rate" },
  airFlip: { v: 7.2, min: 2, max: 18, step: 0.1, label: "air flip rate" },
  /** Auto-level authority as the deck nears the ground — forgiving landings. */
  landingAssist: { v: 6.5, min: 0, max: 20, step: 0.25, label: "landing level assist" },
  /** Beyond this much tilt (rad) at touchdown you eat it. */
  bailAngle: { v: 1.15, min: 0.3, max: 2.2, step: 0.05, label: "bail angle" },
  bailTime: { v: 1.15, min: 0.2, max: 3, step: 0.05, label: "bail recovery" },

  // --- grinds --------------------------------------------------------------
  grindSnap: { v: 1.15, min: 0.3, max: 3, step: 0.05, label: "grind snap radius" },
  grindDrag: { v: 0.55, min: 0, max: 4, step: 0.05, label: "grind drag" },
  grindMin: { v: 2.4, min: 0.5, max: 10, step: 0.1, label: "min grind speed" },
  grindPop: { v: 6.2, min: 1, max: 16, step: 0.1, label: "pop-out" },
  /** How fast the balance meter runs away when you leave it alone. */
  grindDrift: { v: 0.45, min: 0, max: 4, step: 0.02, label: "grind drift" },
  grindCorrect: { v: 1.9, min: 0.2, max: 6, step: 0.05, label: "grind correction" },

  // --- manuals -------------------------------------------------------------
  manualDrift: { v: 0.62, min: 0, max: 4, step: 0.02, label: "manual drift" },
  manualCorrect: { v: 2.1, min: 0.2, max: 6, step: 0.05, label: "manual correction" },
  manualPitch: { v: 0.42, min: 0.1, max: 1, step: 0.02, label: "manual pitch" },

  // Collider origin above the road. NOT the deck height — see SKATE_DECK_DROP
  // in mesh.ts; the deck hangs 0.275 m below this, so its top rides 0.175 m up
  // and the wheels touch the road exactly.
  ride: { v: 0.45 }
});
