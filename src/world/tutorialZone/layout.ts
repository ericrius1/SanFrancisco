/**
 * The flight school's plan: every station anchor, and the one authored ground
 * field the whole site stands on.
 *
 * Two rules shape this file.
 *
 * RAISE ONLY. The rendered terrain is a GPU clipmap sampling the baked
 * heightmap; it never sees a JS ground overlay. So an overlay that *lowered*
 * ground would carve collision out from under a surface that is still drawn —
 * a hole you fall through with grass over it. Every authored surface here is
 * therefore `max(base, …)`, and the skate bowl is a raised concrete plinth with
 * the bowl carved out of its top rather than a pit dug into the lawn.
 *
 * ONE HEIGHT FUNCTION. `zoneGroundTop` is both the ground overlay (feet, wheels,
 * the physics carpet, world raycasts) and the source of every vertex in the
 * rendered decks (see ground.ts). They cannot drift apart because they are the
 * same function — the pairing WorldMap.setGroundTopOverlay's contract asks for.
 *
 * Local frame: u = metres east of TUTORIAL_ZONE_CENTER, v = metres south.
 */

import { TUTORIAL_ZONE_CENTER } from "./meta";

export type ZoneLocal = { u: number; v: number };

export function zoneLocal(x: number, z: number): ZoneLocal {
  return { u: x - TUTORIAL_ZONE_CENTER.x, v: z - TUTORIAL_ZONE_CENTER.z };
}

export function zoneWorldX(u: number): number {
  return TUTORIAL_ZONE_CENTER.x + u;
}

export function zoneWorldZ(v: number): number {
  return TUTORIAL_ZONE_CENTER.z + v;
}

// ---------------------------------------------------------------------------
// Station anchors
// ---------------------------------------------------------------------------

/** The stations, west → east, in the order the tutorial walks them. */
export type StationId = "gate" | "course" | "cottage" | "track" | "bowl" | "sky";

export const STATION_ANCHORS: Record<StationId, ZoneLocal> = {
  gate: { u: -96, v: 0 },
  course: { u: -58, v: 0 },
  cottage: { u: -30, v: -34 },
  track: { u: 44, v: 8 },
  bowl: { u: -62, v: 34 },
  sky: { u: -62, v: 6 }
};

/** Entrance arch, straddling the path at the west gate. */
export const ENTRANCE = { u: -90, v: 0, width: 9.4, height: 5.2 } as const;

/** Bunting gates for the first walk — 3.6 m clear, easy to aim at. */
export const WALK_GATES: readonly ZoneLocal[] = [
  { u: -84, v: 0 },
  { u: -72, v: 0 },
  { u: -60, v: 0 }
];
export const WALK_GATE_HALF_WIDTH = 1.8;

/** The windsock the "look around" beat gives your eye something to find. */
export const WINDSOCK = { u: -78, v: -16, height: 7.4 } as const;

/** Sprint lane: chalk edges, a bollard at each end. */
export const SPRINT = { u0: -52, u1: -22, v: 0, halfWidth: 2.6 } as const;

/** Hay-bale hurdle at the end of the lane — one clean jump clears it. */
export const HURDLE = { u: -16, v: 0, halfWidth: 3.2, height: 0.92 } as const;

/**
 * The cottage: a Crissy-Field clapboard hut with a door you actually open.
 * Footprint is authored in local metres; the door is centred on the south wall
 * so it faces the arrival path.
 */
export const COTTAGE = {
  u: STATION_ANCHORS.cottage.u,
  v: STATION_ANCHORS.cottage.v,
  halfU: 4.75,
  halfV: 3.75,
  wall: 0.22,
  wallHeight: 3.1,
  floorLift: 0.42,
  doorWidth: 1.5,
  doorHeight: 2.25,
  /** Door centre on the south wall, and how far out the stoop reaches. */
  doorU: STATION_ANCHORS.cottage.u,
  doorV: STATION_ANCHORS.cottage.v + 3.75,
  stoopDepth: 1.9
} as const;

/** Oval test track: a graded asphalt ribbon on the airfield apron. */
export const TRACK = {
  cu: STATION_ANCHORS.track.u,
  cv: STATION_ANCHORS.track.v,
  a: 48,
  b: 30,
  halfWidth: 3.6,
  /** Height of the paved ribbon over its datum, before banking. */
  lift: 0.16,
  /** Extra rise at the outer edge — enough to feel, not enough to trip. */
  bank: 0.5,
  /** The overlay tapers to nothing across this skirt, so there is no lip. */
  bevel: 1.3
} as const;

/** Start/finish, on the track's north apex, and the lap direction (clockwise
 *  seen from above: leave the line heading east). */
export const TRACK_START = { u: TRACK.cu, v: TRACK.cv - TRACK.b } as const;

/** Cones down the inside of the first bend — a line to follow, not an obstacle. */
export const TRACK_CONE_ANGLES: readonly number[] = [
  0.16, 0.32, 0.48, 0.64, 0.8, 1.12, 1.44, 1.76, 2.08, 2.4, 2.72, 3.04,
  3.36, 3.68, 4.0, 4.32, 4.64, 4.96, 5.28, 5.6, 5.92
];

/**
 * The bowl: a raised concrete pad with a quarter-pipe transition carved into
 * it. Flat floor, curved wall, coping, deck — then a grass berm all the way
 * down to grade so you can walk, drive or ride up onto it from any side.
 */
export const BOWL = {
  cu: STATION_ANCHORS.bowl.u,
  cv: STATION_ANCHORS.bowl.v,
  /** Flat floor out to here. */
  floorRadius: 6,
  /** Coping sits at this radius — the top of the transition. */
  copingRadius: 13,
  /** Flat deck from the coping out to here. */
  deckRadius: 17,
  /** Berm blends deck → natural grade by here. */
  bermRadius: 25.5,
  /** Deck height above the bowl datum. */
  deckLift: 3,
  /** Floor height above the bowl datum — never below grade, by construction. */
  floorLift: 0.5
} as const;

/** Grind rail across the deck, just outside the coping. */
export const BOWL_RAIL = {
  u0: BOWL.cu - 11,
  u1: BOWL.cu + 11,
  v: BOWL.cv - 15.2,
  height: 0.62
} as const;

/**
 * Flight rings: six hoops climbing north off the bowl deck and out over the
 * shore, drifting west so the last one frames the Golden Gate. Heights are
 * metres above one datum — the ground under the first ring — so the course
 * climbs in a straight line instead of following the seabed down once it
 * leaves the shore (see the ring datum in props.ts).
 *
 * Sized for a newcomer on their first flight, not for a course record. The
 * hoops are wide (6–8 m radius) and sit ~22 m apart, which is the part that
 * actually makes them flyable: a phoenix at speed covers the gap in about a
 * second, and a tighter spacing leaves no room to correct a line before the
 * next hoop is already past. The climb is shallow for the same reason — 4 m of
 * altitude per 22 m of travel is a glide, not a scramble.
 */
export type FlightRing = { u: number; v: number; height: number; radius: number };

export const FLIGHT_RINGS: readonly FlightRing[] = [
  { u: -62, v: 8, height: 8, radius: 8 },
  { u: -66, v: -14, height: 12, radius: 7.6 },
  { u: -71, v: -36, height: 16, radius: 7.2 },
  { u: -77, v: -58, height: 20, radius: 6.8 },
  { u: -84, v: -80, height: 24, radius: 6.4 },
  { u: -92, v: -102, height: 28, radius: 6 }
];

// ---------------------------------------------------------------------------
// The authored ground field
// ---------------------------------------------------------------------------

/**
 * Datums sampled once at build time, from the ground as it exists *before* this
 * site's overlay is installed.
 *
 * Only the surfaces that must be LEVEL take a datum. A poured bowl and a
 * floorboard floor are level or they are wrong; the track is not — a road
 * follows its ground, and a level ribbon laid over even this gentle a field
 * would stand a metre proud at its low end with nothing but its own kerb to
 * climb. The ribbon therefore rides on `base` and only adds its crown.
 */
export type ZoneGrades = { bowl: number; cottage: number };

export function sampleZoneGrades(map: {
  groundTop(x: number, z: number): number;
}): ZoneGrades {
  const at = (l: { u: number; v: number }) => map.groundTop(zoneWorldX(l.u), zoneWorldZ(l.v));
  return {
    bowl: at(STATION_ANCHORS.bowl),
    cottage: at(COTTAGE)
  };
}

const smoothstep = (t: number) => {
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};

/** Signed metric distance from the track ribbon's centreline (negative inside). */
export function trackOffset(u: number, v: number): number {
  const du = u - TRACK.cu;
  const dv = v - TRACK.cv;
  const q = Math.hypot(du / TRACK.a, dv / TRACK.b);
  if (q === 0) return -TRACK.a;
  // Along the ray through this point the ellipse sits at |p| / q, so the
  // distance to it is |p| · (q − 1) / q — exact on a circle, and close enough
  // on a 48 × 30 oval that the ribbon reads as constant width.
  const r = Math.hypot(du, dv);
  return (r * (q - 1)) / q;
}

/** Height of the paved ribbon at a point, or null when the point is off it. */
function trackTop(u: number, v: number, base: number): number | null {
  const d = Math.abs(trackOffset(u, v));
  const edge = TRACK.halfWidth + TRACK.bevel;
  if (d > edge) return null;
  const t = Math.min(1, d / TRACK.halfWidth);
  const crown = TRACK.lift + TRACK.bank * t * t;
  // Outside the paved half-width the surface falls linearly to the ground it
  // is sitting on, so the ribbon has a kerb you drive over, not one you hit.
  const skirt = d <= TRACK.halfWidth ? 1 : 1 - (d - TRACK.halfWidth) / TRACK.bevel;
  return base + crown * skirt;
}

/** Height of the bowl plinth at a point, or null when the point is off it. */
function bowlTop(u: number, v: number, datum: number, base: number): number | null {
  const r = Math.hypot(u - BOWL.cu, v - BOWL.cv);
  if (r > BOWL.bermRadius) return null;
  const deck = datum + BOWL.deckLift;
  if (r >= BOWL.deckRadius) {
    // Grass berm: the level deck blends into whatever ground is out there, so
    // you can walk, drive or ride up onto the pad from any bearing.
    const t = smoothstep((r - BOWL.deckRadius) / (BOWL.bermRadius - BOWL.deckRadius));
    return deck + (base - deck) * t;
  }
  if (r >= BOWL.copingRadius) return deck;
  if (r <= BOWL.floorRadius) return datum + BOWL.floorLift;
  // Quarter-circle transition: vertical at the coping, flat at the floor —
  // the profile a real bowl is poured to.
  const t = (r - BOWL.floorRadius) / (BOWL.copingRadius - BOWL.floorRadius);
  const rise = 1 - Math.sqrt(Math.max(0, 1 - t * t));
  return datum + BOWL.floorLift + (BOWL.deckLift - BOWL.floorLift) * rise;
}

/** Height of the cottage floor plinth + its stoop, or null when off both. */
function cottageTop(u: number, v: number, datum: number, base: number): number | null {
  const du = Math.abs(u - COTTAGE.u);
  const dv = Math.abs(v - COTTAGE.v);
  const bevel = 0.8;
  const halfU = COTTAGE.halfU + COTTAGE.wall;
  const halfV = COTTAGE.halfV + COTTAGE.wall;
  const floor = datum + COTTAGE.floorLift;
  // The stoop is a shallow ramp out from the door, so you walk in rather than
  // step up — a first door should never be a thing you can fail to mount.
  const onStoop =
    Math.abs(u - COTTAGE.doorU) <= COTTAGE.doorWidth * 0.9 &&
    v > COTTAGE.v &&
    v <= COTTAGE.doorV + COTTAGE.stoopDepth;
  if (onStoop) {
    const t = smoothstep(Math.min(1, (COTTAGE.doorV + COTTAGE.stoopDepth - v) / COTTAGE.stoopDepth));
    return base + (floor - base) * t;
  }
  if (du > halfU + bevel || dv > halfV + bevel) return null;
  const over = Math.max(du - halfU, dv - halfV, 0);
  const t = smoothstep(over / bevel);
  return floor + (base - floor) * t;
}

/**
 * The site's ground overlay. Composes with whatever is already installed (it
 * receives the previous result as `base`) and never returns less than it.
 */
export function zoneGroundTop(u: number, v: number, base: number, grades: ZoneGrades): number {
  let top = base;
  const track = trackTop(u, v, base);
  if (track !== null && track > top) top = track;
  const bowl = bowlTop(u, v, grades.bowl, base);
  if (bowl !== null && bowl > top) top = bowl;
  const cottage = cottageTop(u, v, grades.cottage, base);
  if (cottage !== null && cottage > top) top = cottage;
  return top;
}

/** True inside the authored footprint — the overlay is a no-op outside it. */
export function inAuthoredGround(u: number, v: number): boolean {
  return (
    Math.abs(u - TRACK.cu) <= TRACK.a + 8 &&
    Math.abs(v - TRACK.cv) <= TRACK.b + 8
  ) ||
    Math.hypot(u - BOWL.cu, v - BOWL.cv) <= BOWL.bermRadius + 1 ||
    (Math.abs(u - COTTAGE.u) <= COTTAGE.halfU + 3 && Math.abs(v - COTTAGE.v) <= COTTAGE.halfV + COTTAGE.stoopDepth + 3);
}
