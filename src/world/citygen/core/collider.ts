// Building → collider boxes. One oriented wall box per footprint edge (yawed to
// the edge) plus a ground pad — precise to the REAL polygon, so a car hitting a
// re-entrant façade stops on the actual wall instead of a bbox. With `door`, the
// street-facing edge (longest) gets a walk-through gap: its wall becomes two side
// segments + a lintel above the opening + a solid skirt below it, so the player
// can walk in at the raised sill. Pure, no THREE.
import type { BuildingSpec, ColliderBox } from "./types";
import { ensureCCW, streetEdgeIndex, edgeOutwardNormal } from "./footprint";

const WALL_T = 0.25; // wall half-thickness (metres)

/** THE single source of truth for where the front door goes on an edge of length
 *  `len` between world heights `base` (lowest ground under the footprint) and
 *  `top`, given the `grade` (highest ground under the footprint = the interior
 *  floor line). Both the collider gap and the visible door (the theme's
 *  frontDoor/stoop/storefront) read this so they line up EXACTLY:
 *    · sill    = the doorway floor = where you actually walk in. Anchored at the
 *                grade (interior-floor) line, NOT the buried low base — on a
 *                hillside the door is a RAISED entry reached by the stoop.
 *    · openTop = the head of the walk-through opening (sill + a 2.2 m clearance,
 *                capped just under the roof so a squat building still leaves a lip).
 *  grade is clamped into (base, top−1.5) here so every caller gets the same
 *  numbers regardless of whether it pre-clamped. */
export function doorMetrics(len: number, base: number, top: number, grade: number): { tc: number; halfW: number; sill: number; openTop: number } {
  const g = Math.min(Math.max(grade, base), top - 1.5);
  const sill = Math.max(base, g);                 // doorway floor = interior-floor line
  // 2.45 m of walk-through clearance: a capsule cresting the stoop ramp can ride
  // ~0.5 m above the sill for a moment — a 2.2 m head bonked it into the lintel.
  const openTop = Math.min(sill + 2.45, top - 0.2);
  return {
    tc: len > 6 ? 0.24 : 0.5,               // door centre fraction along the edge
    // half the door width (metres). Floor of 0.55 so the narrowest opening is
    // 1.1 m — the old len-proportional min could shrink to ~0.70 m, exactly the
    // player capsule's diameter, an unenterable doorway. Consumed by BOTH the
    // visual grammar and the collider gap, so leaf and gap stay in sync.
    halfW: Math.min(0.9, Math.max(0.55, len * 0.16)),
    sill,
    openTop,
  };
}

/** Minimal shape the door predicate needs — a theme's FacadeEdge satisfies it,
 *  and the collider builds a matching literal per polygon edge. */
export interface DoorEdge {
  isStreet: boolean;
  /** Host-resolved party-wall veto; omitted means allowed. */
  doorAllowed?: boolean;
  length: number;
  base: number;
  top: number;
  /** highest ground under the footprint (defaults to base) */
  grade?: number;
}

/** THE single predicate for "this edge gets a front door" — called by BOTH the
 *  collider (walk-through gap) and every theme façade (visible door + wall hole),
 *  so a collider gap exists IFF a visible doorway is drawn. Requires the street
 *  edge, enough length for a leaf, and enough of the sill→openTop opening to be a
 *  usable ≥1.8 m walk-through. (Since grade is clamped to top−1.5, this passes on
 *  essentially every real multi-storey building; only one buried within ~2 m of
 *  its own roofline stays a solid skirt.) */
export function doorEligible(e: DoorEdge): boolean {
  if (!e.isStreet || e.doorAllowed === false || e.length <= 2.2) return false;
  const { sill, openTop } = doorMetrics(e.length, e.base, e.top, e.grade ?? e.base);
  return openTop - sill >= 1.8;
}

export interface DoorOpening {
  /** which edge got the door (longest / street), for the caller to place the visual */
  edge: number;
  /** door centre fraction along that edge, and half-width in metres */
  tCenter: number; halfW: number;
  /** doorway floor line + head of the walk-through opening (world Y) */
  sill: number; openTop: number;
}

/** Hamilton product a⊗b (world-outer a, local-inner b) — pure, no THREE. Used to
 *  compose the stoop ramp's yaw (to the edge) with its pitch (the incline). */
function qmul(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

const STOOP_MAX_RISE = 3.0;  // cap the stoop climb (metres)
const STOOP_THETA = 0.56;    // ~32° incline — the same walkable slope as interior stair ramps
const RAMP_HY = 0.13;        // ramp collider half-thickness

/** Append a walkable stoop up from the street terrain (`frontGround`) to the raised
 *  `sill`, in front of a doorway centred at world (cx,cz) with inward unit (inx,inz)
 *  and edge unit (ux,uz). A single TILTED ramp box (a box3d capsule jams on discrete
 *  step faces — no step-assist — so it walks the incline) plus a flat top landing so
 *  the ramp meets the sill/interior floor with no lip. The ramp always spans the
 *  FULL street→sill rise (a partial one would strand the player at a cliff), so a
 *  rise past the cap emits nothing — that rare cliff-front door is entered from
 *  its uphill side instead. No-op on a flat/uphill door. */
function appendStoop(
  boxes: ColliderBox[], cx: number, cz: number,
  inx: number, inz: number,
  halfW: number, sill: number, frontGround: number,
): void {
  const rise = sill - frontGround;
  if (rise <= 0.25 || rise > STOOP_MAX_RISE) return;
  const theta = STOOP_THETA;
  const ox = -inx, oz = -inz;                 // outward (toward the street)
  const hz = halfW + 0.2;                      // ramp/landing span across the doorway
  // Threshold LANDING: a THIN flat slab whose top is flush with the sill,
  // straddling the wall plane (0.42 m to either side). It covers the foundation
  // skirt's top corner so the doorway floor is one continuous surface — a capsule's
  // lower hemisphere otherwise catches on the skirt's top-outer corner exactly at
  // the plane and stalls the walk-in. Thin (5 cm) so its own bottom edge stays
  // buried beneath the ramp surface at the handoff (a thick landing presents a
  // step face the no-step-assist capsule can't climb).
  const psi = Math.atan2(inz, inx);            // yaw so the box +X points inward (up-slope)
  // reaches 0.42 m out (under the ramp crest) and 0.80 m IN — deep enough to
  // bridge onto the interior floor slab, which is inset from the walls, so the
  // walk-out doesn't drop into the slab-to-wall crevice at the threshold.
  boxes.push({ x: cx + inx * 0.19, y: sill - 0.05, z: cz + inz * 0.19, hx: 0.61, hy: 0.05, hz, yaw: psi });
  // Ramp surface: its line passes EXACTLY through the landing's top-outer corner
  // (0.42 out, sill) and the tip continues 0.12 m further in, poking ~7 cm ABOVE
  // the landing — the interior stairs' overlap trick. A capsule climbing a plane
  // contacts a flat's face radius·tanθ (~22 cm) below the flat's top, so a ramp
  // that merely MEETS the landing edge presents a concave step face the
  // no-step-assist capsule jams on; overlapping past the corner turns the joint
  // into a convex crest it rolls straight over (and a ≤7 cm face on the way out,
  // which it handles — same as the interior stair landings).
  const topOut = 0.30;
  const topY = sill + 0.12 * Math.tan(theta);
  const rrise = topY - frontGround;
  const run = rrise / Math.tan(theta);
  const slopeLen = Math.hypot(run, rrise);
  const smx = cx + ox * (topOut + run / 2), smz = cz + oz * (topOut + run / 2), smy = (topY + frontGround) / 2;
  const nHx = ox * Math.sin(theta), nY = Math.cos(theta), nHz = oz * Math.sin(theta);
  // box3d applies quats in the textbook right-handed sense (a +Y rotation by ψ
  // sends +X to (cos ψ, −sin ψ)), while this app's planar yaw convention wants
  // +X along (cos ψ, +sin ψ) — so the yaw half-angle is NEGATED for the pitched
  // +X axis to land on inward. Verified across all 8 quadrants + across-ramp
  // flatness against headless box3d ray profiles (scratch ramp-b3-quad/-roll).
  const qYaw: [number, number, number, number] = [0, Math.sin(-psi / 2), 0, Math.cos(-psi / 2)];
  const qPitch: [number, number, number, number] = [0, 0, Math.sin(theta / 2), Math.cos(theta / 2)]; // +X tilts up about +Z
  boxes.push({
    x: smx - nHx * RAMP_HY, y: smy - nY * RAMP_HY, z: smz - nHz * RAMP_HY,
    hx: slopeLen / 2, hy: RAMP_HY, hz, yaw: 0, quat: qmul(qYaw, qPitch),
  });
}

/** Stoop-only boxes (threshold landing + tilted ramp) for a building's street
 *  door, or [] when there is no eligible door / no rise / no frontGround. The
 *  SOLID (closed-door) wall set includes these too: the stoop STEPS are always
 *  drawn by the theme regardless of door state, so they must always be tangible
 *  — the door toggle swaps only the wall gap, never the floor underfoot (a ramp
 *  that appeared on open could spawn under a standing player, and one removed on
 *  close could drop them ~3 m down a hillside frontage). */
export function stoopColliders(spec: BuildingSpec, frontGround: number | undefined): ColliderBox[] {
  if (frontGround === undefined) return [];
  const poly = ensureCCW(spec.poly);
  const streetI = streetEdgeIndex(poly, spec.streetEdge);
  const p0 = poly[streetI];
  const p1 = poly[(streetI + 1) % poly.length];
  const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
  const len = Math.hypot(dx, dz);
  if (!doorEligible({ isStreet: true, doorAllowed: spec.doorAllowed, length: len, base: spec.base, top: spec.top, grade: spec.grade })) return [];
  const { tc, halfW, sill } = doorMetrics(len, spec.base, spec.top, spec.grade ?? spec.base);
  const ux = dx / len, uz = dz / len;
  const d = tc * len;
  const nrm = edgeOutwardNormal(p0, p1);
  const boxes: ColliderBox[] = [];
  appendStoop(boxes, p0[0] + ux * d, p0[1] + uz * d, -nrm[0], -nrm[1], halfW, sill, frontGround);
  return boxes;
}

/** Oriented wall boxes + ground pad. If `withDoor`, cut a doorway in the street
 *  edge and return where it is (so the theme can align the visual door). When a
 *  `frontGround` (live terrain height just outside the door) is supplied with a
 *  door, a walkable stoop ramp up to the sill is added too. */
export function buildingColliders(spec: BuildingSpec, withDoor = false, frontGround?: number): { boxes: ColliderBox[]; door: DoorOpening | null } {
  const poly = ensureCCW(spec.poly);
  const base = spec.base;
  const top = spec.top;
  const midY = (base + top) / 2;
  const halfH = Math.max(0.1, (top - base) / 2);
  const boxes: ColliderBox[] = [];
  const streetI = withDoor ? streetEdgeIndex(poly, spec.streetEdge) : -1;
  let door: DoorOpening | null = null;

  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % poly.length];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.3) continue;
    const yaw = Math.atan2(dz, dx);
    const ux = dx / len, uz = dz / len; // unit along edge

    if (doorEligible({ isStreet: i === streetI, doorAllowed: spec.doorAllowed, length: len, base, top, grade: spec.grade })) {
      // doorway split: door centred (offset for wide lots), clear sill→openTop, with
      // a lintel above and a solid foundation skirt below.
      const { tc, halfW, sill, openTop } = doorMetrics(len, base, top, spec.grade ?? base);
      const dCenter = tc * len;                  // metres from p0
      const gapL = dCenter - halfW, gapR = dCenter + halfW;
      // left / right jamb walls (full height — only the door column is cut)
      if (gapL > 0.15) {
        const s = gapL / 2;
        boxes.push({ x: p0[0] + ux * s, y: midY, z: p0[1] + uz * s, hx: s, hy: halfH, hz: WALL_T, yaw });
      }
      if (len - gapR > 0.15) {
        const s = (len - gapR) / 2;
        boxes.push({ x: p0[0] + ux * (gapR + s), y: midY, z: p0[1] + uz * (gapR + s), hx: s, hy: halfH, hz: WALL_T, yaw });
      }
      // lintel above the opening (openTop → top)
      const lintelH = Math.max(0.05, (top - openTop) / 2);
      boxes.push({ x: p0[0] + ux * dCenter, y: openTop + lintelH, z: p0[1] + uz * dCenter, hx: halfW, hy: lintelH, hz: WALL_T, yaw });
      // foundation skirt below the opening (base → 12 cm under the sill): the
      // below-grade skirt mesh finally gets matching collision (was an open
      // crawl-gap under an invisible lintel). Its top stops short of the sill so
      // the stoop landing/ramp — not the skirt's sharp corner — is what the
      // capsule walks over at the threshold (the ramp surface passes ~11 cm under
      // the sill where a capsule can first touch the skirt face, so the skirt must
      // sit below THAT line or it presents a jamming step). No-op on a flat lot.
      const skirtH = (sill - 0.12 - base) / 2;
      if (skirtH > 0.03) boxes.push({ x: p0[0] + ux * dCenter, y: base + skirtH, z: p0[1] + uz * dCenter, hx: halfW, hy: skirtH, hz: WALL_T, yaw });
      // walkable stoop up from the street to the raised sill (downhill approach)
      if (withDoor && frontGround !== undefined) {
        const nrm = edgeOutwardNormal(p0, p1); // unit outward (x,z)
        appendStoop(boxes, p0[0] + ux * dCenter, p0[1] + uz * dCenter, -nrm[0], -nrm[1], halfW, sill, frontGround);
      }
      door = { edge: i, tCenter: tc, halfW, sill, openTop };
    } else {
      boxes.push({ x: (p0[0] + p1[0]) / 2, y: midY, z: (p0[1] + p1[1]) / 2, hx: len / 2, hy: halfH, hz: WALL_T, yaw });
    }
  }

  // ground pad — keeps a car that mounts the footprint from sinking. Sunk 0.4 m
  // below the base: it's an AABB of the (rotated) footprint, so it overshoots
  // into the street, and with its top at `base` the overshoot rimmed out of
  // downhill sidewalks as an invisible curb that blocked walking to front doors.
  // Terrain carries everything above it; the pad is only a below-floor safety net.
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const [x, z] of poly) {
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  boxes.push({ x: (minx + maxx) / 2, y: base - 0.55, z: (minz + maxz) / 2, hx: (maxx - minx) / 2, hy: 0.15, hz: (maxz - minz) / 2, yaw: 0 });

  return { boxes, door };
}
