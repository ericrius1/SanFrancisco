/**
 * The skatepark, expressed once.
 *
 * Every obstacle is a closed-form height function over park-local (x, z), and
 * BOTH the ground overlay and the drawn geometry are generated from these same
 * numbers — so what you roll up is exactly what you see, with no chance of the
 * collision surface and the concrete drifting apart.
 *
 * Local frame: +X runs along the park's long axis (half pipe at −X, bowl at
 * +X), −Z is the street course. Heights are metres relative to the graded deck
 * level: `obstacleHeight` only ever RAISES and `carveDepth` only ever DIGS.
 * The two are kept apart because the drawn slab has to dish for the bowl while
 * the ramps are separate meshes standing on top of it.
 */

import { SKATE_PLAZA_PAD } from "./meta";

export type Box = { x0: number; x1: number; z0: number; z1: number; h: number };
/** Linear wedge: height ramps from 0 at the `from` edge to `h` at the other. */
export type Wedge = Box & { axis: "x" | "z"; rise: 1 | -1 };
/** Circular ramp of horizontal run `run` rising to `h`. `rise: -1` climbs
 *  toward x0/z0, `rise: 1` climbs toward x1/z1. */
export type Transition = Box & { run: number; axis: "x" | "z"; rise: 1 | -1 };
export type Stairs = Box & { steps: number };
/** A round concrete bowl: flat floor at −depth inside a curved wall. */
export type Bowl = { cx: number; cz: number; radius: number; depth: number; wall: number };

// --- the park --------------------------------------------------------------
// 60 × 40 m of concrete: a transition end (half pipe + bowl) and a street
// course, laid out so nothing overlaps and every piece has a run-up.

/** Half pipe: two facing walls with flat between, ridden back and forth in X. */
export const HALFPIPE_W: Transition = { x0: -27, x1: -23.4, z0: 3, z1: 16, h: 2.4, run: 3.6, axis: "x", rise: -1 };
export const HALFPIPE_E: Transition = { x0: -14.6, x1: -11, z0: 3, z1: 16, h: 2.4, run: 3.6, axis: "x", rise: 1 };
/** Platforms behind each lip, so the coping has something to stand on. */
export const HALFPIPE_DECK_W: Box = { x0: -30, x1: -27, z0: 3, z1: 16, h: 2.4 };
export const HALFPIPE_DECK_E: Box = { x0: -11, x1: -8, z0: 3, z1: 16, h: 2.4 };

/** The bowl. A real one is a hole, so the overlay digs and the slab dishes. */
export const BOWL: Bowl = { cx: 15, cz: 9, radius: 9.5, depth: 2.6, wall: 3.6 };

/** Launch bank on the +X edge, for sending it at the street course. */
export const LAUNCH: Wedge = { x0: 24, x1: 29, z0: -10, z1: -1, h: 1.5, axis: "x", rise: 1 };

/** Raised street deck along the −Z edge, with a stair set cut into it. */
export const DECK: Box = { x0: -11, x1: 10, z0: -20, z1: -15, h: 1.4 };
export const DECK_BANK_W: Wedge = { x0: -11, x1: -5, z0: -15, z1: -12.6, h: 1.4, axis: "z", rise: -1 };
export const DECK_BANK_E: Wedge = { x0: 4, x1: 10, z0: -15, z1: -12.6, h: 1.4, axis: "z", rise: -1 };
export const STAIRS: Stairs = { x0: -3, x1: 1, z0: -15, z1: -12.3, h: 1.4, steps: 4 };
/** Hubba: the wide sloped ledge running down the east side of the stairs. */
export const HUBBA: Wedge = { x0: 1.2, x1: 2.6, z0: -15, z1: -12.3, h: 1.4, axis: "z", rise: -1 };
export const HUBBA_BOTTOM = 0.42;

/** Funbox with a kicker on each side and a bar over the top. */
export const FUNBOX: Box = { x0: -5, x1: 5, z0: -9, z1: -4, h: 0.6 };
export const FUNBOX_KICK_W: Wedge = { x0: -8.5, x1: -5, z0: -9, z1: -4, h: 0.6, axis: "x", rise: 1 };
export const FUNBOX_KICK_E: Wedge = { x0: 5, x1: 8.5, z0: -9, z1: -4, h: 0.6, axis: "x", rise: -1 };

/** Waxed concrete ledges. */
export const LEDGE_W: Box = { x0: -26, x1: -17, z0: -3, z1: -1.7, h: 0.45 };
export const LEDGE_E: Box = { x0: 17, x1: 26, z0: -18, z1: -16.7, h: 0.45 };

export const BOXES: readonly Box[] = [
  HALFPIPE_DECK_W,
  HALFPIPE_DECK_E,
  DECK,
  FUNBOX,
  LEDGE_W,
  LEDGE_E
];
export const WEDGES: readonly Wedge[] = [
  LAUNCH,
  DECK_BANK_W,
  DECK_BANK_E,
  FUNBOX_KICK_W,
  FUNBOX_KICK_E
];
export const TRANSITIONS: readonly Transition[] = [HALFPIPE_W, HALFPIPE_E];

/** Grind lines, in park-local metres. `y` is the top of the edge. */
export type LocalRail = {
  id: string;
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  kind: "rail" | "ledge" | "coping";
  /** Deck-top height above the line — a round bar sits between the trucks. */
  lift: number;
  /** Drawn as a steel bar (false = it's the edge of something solid). */
  draw: boolean;
  /** Stand the bar on posts. Coping is a lip bolted to concrete, not a fence. */
  posts?: boolean;
};

const RAIL_LIFT = 0.09;
const LEDGE_LIFT = 0.0;
/** Coping runs right around the bowl rim as a ring of chords. */
const BOWL_COPING_SEGMENTS = 8;

function bowlCoping(): LocalRail[] {
  const out: LocalRail[] = [];
  for (let i = 0; i < BOWL_COPING_SEGMENTS; i++) {
    const a = (i / BOWL_COPING_SEGMENTS) * Math.PI * 2;
    const b = ((i + 1) / BOWL_COPING_SEGMENTS) * Math.PI * 2;
    out.push({
      id: `bowl-coping-${i}`,
      ax: BOWL.cx + Math.cos(a) * BOWL.radius,
      ay: 0,
      az: BOWL.cz + Math.sin(a) * BOWL.radius,
      bx: BOWL.cx + Math.cos(b) * BOWL.radius,
      by: 0,
      bz: BOWL.cz + Math.sin(b) * BOWL.radius,
      kind: "coping",
      lift: 0.07,
      draw: true,
      posts: false
    });
  }
  return out;
}

export const RAILS: readonly LocalRail[] = [
  { id: "hp-coping-w", ax: -27, ay: 2.4, az: 4, bx: -27, by: 2.4, bz: 15, kind: "coping", lift: 0.07, draw: true, posts: false },
  { id: "hp-coping-e", ax: -11, ay: 2.4, az: 4, bx: -11, by: 2.4, bz: 15, kind: "coping", lift: 0.07, draw: true, posts: false },
  ...bowlCoping(),
  { id: "flatbar-w", ax: -26, ay: 0.4, az: -12, bx: -6, by: 0.4, bz: -12, kind: "rail", lift: RAIL_LIFT, draw: true },
  { id: "flatbar-e", ax: 6, ay: 0.62, az: -12, bx: 26, by: 0.62, bz: -12, kind: "rail", lift: RAIL_LIFT, draw: true },
  { id: "funbox-bar", ax: -5.6, ay: FUNBOX.h + 0.36, az: -6.5, bx: 5.6, by: FUNBOX.h + 0.36, bz: -6.5, kind: "rail", lift: RAIL_LIFT, draw: true },
  { id: "funbox-edge", ax: -4.9, ay: FUNBOX.h, az: -4.1, bx: 4.9, by: FUNBOX.h, bz: -4.1, kind: "ledge", lift: LEDGE_LIFT, draw: false },
  { id: "handrail", ax: -4, ay: DECK.h + 0.94, az: -15, bx: -4, by: 0.94, bz: -11.6, kind: "rail", lift: RAIL_LIFT, draw: true },
  { id: "hubba", ax: 1.9, ay: HUBBA.h, az: -15, bx: 1.9, by: HUBBA_BOTTOM, bz: -12.3, kind: "ledge", lift: LEDGE_LIFT, draw: false },
  { id: "ledge-w", ax: -25.4, ay: LEDGE_W.h, az: -2.35, bx: -17.6, by: LEDGE_W.h, bz: -2.35, kind: "ledge", lift: LEDGE_LIFT, draw: false },
  { id: "ledge-e", ax: 17.6, ay: LEDGE_E.h, az: -17.35, bx: 25.4, by: LEDGE_E.h, bz: -17.35, kind: "ledge", lift: LEDGE_LIFT, draw: false }
];

const inside = (b: { x0: number; x1: number; z0: number; z1: number }, x: number, z: number) =>
  x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1;

/** Circular ramp profile: height at horizontal distance `d` up from the base. */
export function transitionHeight(t: Transition, d: number): number {
  const R = (t.run * t.run + t.h * t.h) / (2 * t.h);
  const dd = Math.min(t.run, Math.max(0, d));
  return R - Math.sqrt(Math.max(0, R * R - dd * dd));
}

/** Everything the park RAISES above deck level at park-local (x, z). */
export function obstacleHeight(x: number, z: number): number {
  let h = 0;
  for (const b of BOXES) if (inside(b, x, z)) h = Math.max(h, b.h);
  for (const w of WEDGES) {
    if (!inside(w, x, z)) continue;
    const u = w.axis === "x" ? (x - w.x0) / (w.x1 - w.x0) : (z - w.z0) / (w.z1 - w.z0);
    h = Math.max(h, w.h * (w.rise === 1 ? u : 1 - u));
  }
  for (const t of TRANSITIONS) {
    if (!inside(t, x, z)) continue;
    const along = t.axis === "x" ? x : z;
    const lo = t.axis === "x" ? t.x0 : t.z0;
    const hi = t.axis === "x" ? t.x1 : t.z1;
    h = Math.max(h, transitionHeight(t, t.rise === -1 ? hi - along : along - lo));
  }
  if (inside(STAIRS, x, z)) {
    const u = (z - STAIRS.z0) / (STAIRS.z1 - STAIRS.z0);
    const step = Math.min(STAIRS.steps, Math.floor((1 - u) * STAIRS.steps) + 1);
    h = Math.max(h, (step / STAIRS.steps) * STAIRS.h);
  }
  if (inside(HUBBA, x, z)) {
    const u = 1 - (z - HUBBA.z0) / (HUBBA.z1 - HUBBA.z0);
    h = Math.max(h, HUBBA_BOTTOM + (HUBBA.h - HUBBA_BOTTOM) * u);
  }
  return h;
}

/**
 * Everything the park DIGS below deck level — i.e. the bowl. Negative or zero.
 */
export function carveDepth(x: number, z: number): number {
  const r = Math.hypot(x - BOWL.cx, z - BOWL.cz);
  if (r >= BOWL.radius) return 0;
  const d = BOWL.radius - r; // distance in from the rim
  if (d >= BOWL.wall) return -BOWL.depth;
  const R = (BOWL.wall * BOWL.wall + BOWL.depth * BOWL.depth) / (2 * BOWL.depth);
  const back = BOWL.wall - d;
  return -(BOWL.depth - (R - Math.sqrt(Math.max(0, R * R - back * back))));
}

/** 0 outside the park, 1 on the graded slab, smooth across the taper ring. */
export function padBlend(x: number, z: number): number {
  const { hx, hz, taper } = SKATE_PLAZA_PAD;
  const ox = Math.max(0, Math.abs(x) - hx);
  const oz = Math.max(0, Math.abs(z) - hz);
  const d = Math.hypot(ox, oz);
  if (d >= taper) return 0;
  const u = 1 - d / taper;
  return u * u * (3 - 2 * u);
}
