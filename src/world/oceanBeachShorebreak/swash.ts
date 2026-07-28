/**
 * The Ocean Beach shorebreak — what a set wave does once it has finished
 * breaking: the bore that slams into the sand, the sheet that races up the
 * beach face, the backwash that drains it away, and the dark wet band left
 * behind while the sand dries.
 *
 * It is driven by the SAME crest train as the offshore surf field
 * (world/oceanBeachWaves.ts): a wave you watch stand up out the back is the
 * wave that washes over your feet, at the right moment, with the right size.
 *
 * The model is written in ELEVATION, not in distance. A wave arrives carrying
 * enough energy to push water up to some height above sea level, and every
 * grain of sand below that line is wet. Run-up distance then falls out of the
 * real beach profile for free — a flat section gets a long, thin wash and the
 * steep scarp gets a short slap — and the swash edge is a terrain contour,
 * which is exactly the scalloped, wandering shape a real waterline has. No
 * authored curve reproduces that as cheaply.
 */

import { clamp, float, floor, fract, hash, mix, pow, saturate, sin, step } from "three/tsl";
import { OCEAN_BEACH_SURF } from "../oceanBeachWaves";

/** TSL node graphs do not compose across ops with generics; any keeps it readable. */
type N = any;

export const SHOREBREAK = {
  /**
   * Sea-level frame, metres. The trough the sheet drains to between waves —
   * below the ocean handoff, so a full backwash genuinely bares the sand
   * instead of leaving a permanent film halfway up the beach.
   */
  drawdownY: -0.9,
  /**
   * Run-up elevation of the smallest and the biggest waves in a set. Ocean
   * Beach's face runs about 1:8, so these are roughly 8 m and 27 m of wash
   * across the sand.
   */
  climbMin: 1.3,
  climbMax: 3.5,
  /**
   * Share of the set period spent rushing up the sand; the rest drains back.
   * Real swash is strongly asymmetric — the up-rush is over in a few seconds
   * and the backwash takes three times as long.
   */
  upFraction: 0.26,
  /** Backwash easing. >1 hangs high, then lets go. */
  drainPower: 1.5,
  /**
   * Seconds of visibly dark sand after the water has pulled back off it.
   * Comfortably longer than the ~16 s between waves, so the low beach never
   * blinks fully dry between them the way a shorter memory makes it.
   */
  dryTime: 13,
  /**
   * Sand below this elevation belongs to the ocean sheet (water.ts draws its
   * own surface and shore foam up to +0.55 m of floor height). Handing off
   * here keeps two transparent sheets from fighting over the same pixels.
   */
  handoffY: 0.16,
  handoffBand: 0.34,
  /** Metres the sheet floats above the sand, to beat terrain-LOD z-fighting. */
  lift: 0.07,
  /** Extra height carried by the leading bore, metres at full rush. */
  boreLift: 0.5,
  /** Horizontal metres behind the edge that the bore's froth occupies. */
  boreReach: 13,
  /** Horizontal metres of lacy, fizzing edge at the front of the sheet. */
  edgeReach: 5
} as const;

/** Seconds between crests arriving at the sand. */
export const SWASH_PERIOD = OCEAN_BEACH_SURF.spacing / OCEAN_BEACH_SURF.speed;

/**
 * Whole wavelengths added to the cycle counter so it never goes negative.
 * `hash()` casts its seed to uint, and a negative cycle index would collapse
 * every early wave onto the same run-up height. A multiple of the spacing
 * leaves the phase untouched.
 */
const PHASE_BIAS = OCEAN_BEACH_SURF.spacing * 160;

/**
 * How high wave `cycle` pushes its water, in metres above sea level.
 *
 * Two rhythms, deliberately incommensurate: a per-wave grain, and the slow
 * grouping that makes sets — three or four that barely wet the sand, then the
 * one that runs up to the towels. `z` adds along-beach cusps so the same wave
 * reaches further in the rip hollows than on the bars.
 */
function swashClimb(cycle: N, z: N): N {
  const grain = hash(cycle);
  const set = sin(cycle.mul(0.83)).mul(0.5).add(0.5);
  const energy = saturate(grain.mul(0.42).add(set.mul(0.58)));
  const cusp = sin(z.mul(0.0031).add(cycle.mul(0.7))).mul(0.5).add(0.5);
  return mix(float(SHOREBREAK.climbMin), float(SHOREBREAK.climbMax), energy)
    .mul(mix(float(0.8), float(1), cusp));
}

/**
 * Normalised 0…1 wash shape over one cycle: a fast, decelerating rush that
 * tops out at `upFraction`, then a slower drain back to nothing. Both branches
 * meet at 1 on the turn and at 0 on both ends of the cycle, so the sheet is
 * continuous across a wrap — which matters, because the phase also varies
 * ALONG the beach and every wrap is a seam if the ends disagree.
 */
function washShape(u: N): N {
  const a = SHOREBREAK.upFraction;
  const rise = saturate(u.div(a)).oneMinus();
  const gUp = rise.mul(rise).oneMinus();
  const drain = saturate(u.sub(a).div(1 - a));
  const gDown = pow(drain, SHOREBREAK.drainPower).oneMinus();
  return mix(gUp, gDown, step(a, u));
}

export type SwashState = {
  /** 0…1 phase through this row's wash cycle; 0 is the moment of the crash. */
  u: N;
  /** Water-surface elevation of the wash right now, metres above sea level. */
  runupY: N;
  /** How high this wave will reach in total. */
  climb: N;
  /** How high the previous wave reached (the wet sand still remembers it). */
  climbPrev: N;
  /** Which wave this is — a stable integer id for per-wave variation. */
  cycle: N;
};

/**
 * Where the wash is, right now, at this point along the beach.
 *
 * `shoreX` is the row's true waterline X (baked per vertex from the terrain —
 * the analytic `oceanBeachApproxShoreX` fit wanders up to 50 m off the real
 * y=0 crossing, which is four metres of elevation on this beach face).
 */
export function swashState(z: N, shoreX: N, t: N): SwashState {
  const b = OCEAN_BEACH_SURF;
  // Twin of oceanBeachCrestX()'s sandbar bend. The same wiggle that makes the
  // offshore crests peel makes the wash arrive obliquely and sweep down-beach.
  const peel = sin(z.mul(0.0052).add(t.mul(0.18))).mul(13)
    .add(sin(z.mul(0.0017).sub(t.mul(0.09))).mul(6));
  // q counts crests that have reached THIS row's waterline: floor picks the
  // wave, fract says how far through its wash we are.
  const q = t
    .mul(b.speed)
    .add(peel)
    .add(PHASE_BIAS + b.offshoreCrest)
    .sub(shoreX)
    .div(b.spacing)
    .toVar();
  const cycle = floor(q).toVar();
  const u = fract(q).toVar();
  const climb = swashClimb(cycle, z).toVar();
  const climbPrev = swashClimb(cycle.sub(1), z).toVar();
  const runupY = mix(float(SHOREBREAK.drawdownY), climb, washShape(u)).toVar();
  return { u, runupY, climb, climbPrev, cycle };
}

/**
 * Phase at which the drain crosses elevation `y` on its way down, for a wave
 * that topped out at `climb`. Used to date the wet sand: everything the water
 * has touched carries a timestamp, and the beach dries from the top down.
 */
function drainCrossing(y: N, climb: N): N {
  const a = SHOREBREAK.upFraction;
  const g = saturate(y.sub(SHOREBREAK.drawdownY).div(climb.sub(SHOREBREAK.drawdownY)));
  const drain = pow(saturate(g.oneMinus()), 1 / SHOREBREAK.drainPower);
  return drain.mul(1 - a).add(a);
}

/**
 * 0…1 how wet this sand still looks: 1 under live water or just behind the
 * retreating edge, fading out over `dryTime` seconds. Two cycles of memory is
 * enough — the last wave's line, plus the bigger one before it that is still
 * drying higher up the beach. That second line is what makes a beach read as
 * a beach and not as a wet stripe.
 */
export function swashWetness(sandY: N, state: SwashState): N {
  const { u, climb, climbPrev } = state;
  const cur = drainCrossing(sandY, climb);
  const prev = drainCrossing(sandY, climbPrev);
  // Reached this cycle AND the water has already gone back past it.
  const doneCur = step(sandY, climb).mul(step(cur, u));
  const agePrev = u.add(1).sub(prev);
  const age = mix(mix(float(99), agePrev, step(sandY, climbPrev)), u.sub(cur), doneCur);
  const dry = saturate(age.mul(SWASH_PERIOD).div(SHOREBREAK.dryTime));
  // Saturated sand does not fade linearly: it stays dark, then goes at the
  // end. That non-linearity is what gives the last wave's high-water mark a
  // readable edge instead of a soft airbrushed gradient.
  const held = pow(dry.oneMinus(), 0.6);
  // Sand permanently below the drawdown never dries out at all.
  const soaked = step(sandY, float(SHOREBREAK.drawdownY));
  return clamp(held.add(soaked), 0, 1);
}

/**
 * Fade the sheet out where the ocean's own surface takes over, so the two
 * transparent layers never argue about the same strip of wet sand.
 */
export function shorebreakHandoff(sandY: N): N {
  return saturate(sandY.sub(SHOREBREAK.handoffY).div(SHOREBREAK.handoffBand));
}
