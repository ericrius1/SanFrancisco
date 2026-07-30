/**
 * Grindable edges, as world-space line segments.
 *
 * A rail is intent, not geometry: whoever draws a handrail, a granite ledge or
 * a coping lip also registers the line a skater's trucks can lock onto, and the
 * skate controller does the rest. Registrations are keyed by owner so a site
 * that unloads takes its rails with it.
 *
 * The registry stays a flat array on purpose — a skate spot contributes on the
 * order of a dozen segments, and the per-step query is a short allocation-free
 * scan (the result is written into one shared record, never a new object).
 */

export type GrindKind =
  /** Round steel handrail/flat bar — sparks, and the deck locks square to it. */
  | "rail"
  /** Wide concrete or granite edge — slower, more forgiving, no sparks. */
  | "ledge"
  /** Ramp/bowl coping — a rail you arrive at from below, off a transition. */
  | "coping";

export type GrindRail = {
  id: string;
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  kind: GrindKind;
  /** Deck-top height above the segment line (the trucks straddle the bar). */
  lift: number;
};

export type GrindHit = {
  rail: GrindRail;
  /** Parametric position along the segment, 0..1. */
  t: number;
  /** Closest point on the segment. */
  px: number;
  py: number;
  pz: number;
  /** Unit direction a→b (XZ), plus the segment's vertical grade. */
  dx: number;
  dz: number;
  grade: number;
  /** Segment length (m). */
  length: number;
  /** +1 if the skater is travelling a→b, −1 for b→a. */
  sign: number;
};

const rails: GrindRail[] = [];
const owners = new Map<string, GrindRail[]>();

/** Replaces any prior registration under the same owner. */
export function registerGrindRails(owner: string, list: readonly GrindRail[]): void {
  unregisterGrindRails(owner);
  const own = list.slice();
  owners.set(owner, own);
  for (const r of own) rails.push(r);
}

export function unregisterGrindRails(owner: string): void {
  const own = owners.get(owner);
  if (!own) return;
  owners.delete(owner);
  for (const r of own) {
    const i = rails.indexOf(r);
    if (i >= 0) rails.splice(i, 1);
  }
}

export function grindRailCount(): number {
  return rails.length;
}

/** Every registered rail, for debug draws. Do not mutate. */
export function allGrindRails(): readonly GrindRail[] {
  return rails;
}

// One shared result record: the query runs every physics step.
const HIT: GrindHit = {
  rail: null as unknown as GrindRail,
  t: 0,
  px: 0,
  py: 0,
  pz: 0,
  dx: 0,
  dz: 1,
  grade: 0,
  length: 1,
  sign: 1
};

/**
 * Nearest rail the deck can lock onto right now, or null.
 *
 * A lock needs three things: the trucks near the line in plan view, the deck
 * within a shallow vertical band around it (you catch a rail dropping onto it,
 * or rising just past its lip out of a transition), and travel roughly ALONG
 * the bar — sideways contact is a collision, not a grind. `align` is the cosine
 * the caller demands between velocity and the bar (boardslides come in flatter,
 * so the controller relaxes it when the deck is airborne).
 */
export function findGrindRail(
  x: number,
  y: number,
  z: number,
  vx: number,
  vz: number,
  radius: number,
  up: number,
  down: number,
  align: number
): GrindHit | null {
  const speed = Math.hypot(vx, vz);
  if (speed < 1e-3) return null;
  const ivs = 1 / speed;
  let best: GrindRail | null = null;
  let bestD2 = radius * radius;
  let bestT = 0;

  for (const r of rails) {
    const ex = r.bx - r.ax;
    const ez = r.bz - r.az;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-6) continue;
    let t = ((x - r.ax) * ex + (z - r.az) * ez) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = r.ax + ex * t;
    const cz = r.az + ez * t;
    const dx = x - cx;
    const dz = z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= bestD2) continue;
    // Vertical band around the bar's top, biased upward: you land ON rails.
    const cy = r.ay + (r.by - r.ay) * t + r.lift;
    const dy = y - cy;
    if (dy > up || dy < -down) continue;
    // Travelling along the bar, either way down it.
    const inv = 1 / Math.sqrt(len2);
    const dot = Math.abs((vx * ex + vz * ez) * inv * ivs);
    if (dot < align) continue;
    best = r;
    bestD2 = d2;
    bestT = t;
  }

  if (!best) return null;
  const ex = best.bx - best.ax;
  const ez = best.bz - best.az;
  const len = Math.hypot(ex, ez);
  const inv = 1 / len;
  HIT.rail = best;
  HIT.t = bestT;
  HIT.px = best.ax + ex * bestT;
  HIT.pz = best.az + ez * bestT;
  HIT.py = best.ay + (best.by - best.ay) * bestT;
  HIT.dx = ex * inv;
  HIT.dz = ez * inv;
  HIT.grade = (best.by - best.ay) * inv;
  HIT.length = len;
  HIT.sign = vx * HIT.dx + vz * HIT.dz >= 0 ? 1 : -1;
  return HIT;
}
