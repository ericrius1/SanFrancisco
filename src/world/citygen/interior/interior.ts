// Walkable, multi-room building interiors — a PURE FUNCTION of (spec, zone).
// Built lazily only when the player actually steps inside (the ring gates it on
// the footprint) and thrown away when they leave, so nothing pays for an
// interior nobody is in.
//
// What it builds, in world space (same frame as the exterior, so no transform):
//   • a floor slab per storey (you stand on each floor) + a ceiling under each,
//   • the storey partitioned into 2–4 rooms joined by 1 m doorways (a connected,
//     walkable plan) — or ONE open room for lofts/warehouses,
//   • a real U-switchback staircase with step colliders threading every floor,
//     with a matching hole cut in the slab above so you emerge onto the next,
//   • zone-appropriate furniture, warm emissive lamps, and framed placeholder
//     art hung at eye height (frame box + swappable art quad).
//
// Determinism: all variation from spec.seed via mulberry32 (rng). Emissive-only
// lighting (no THREE lights — the app has a fixed LightPool), so every room reads.
import type { BuildingSpec, ColliderBox, Panel, Vec2 } from "../core/types";
import { PanelBuilder } from "../core/facade";
import { ensureCCW, triangulate, centroid, streetEdgeIndex, pointInPoly, distToPolyEdge } from "../core/footprint";
import { doorMetrics } from "../core/collider";
import { rng } from "../core/rng";
import { specFor } from "../theme/archetypes";
import { MAX_FLOORS, INSET, bboxOf, inset, rectArea, rectMinDim, type Rect } from "./common";
import { partition, buildWalls, deck, planCirculation, polyGroundSlab, type EntryAccess, type Portal, type Wall } from "./rooms";
import { planStair, buildStair, stairFits, type StairPlan } from "./stairs";
import { furnish, type Role } from "./props";
import { dressInteriorShell, type FrontOpening } from "./shell";
import { interiorStyle, type InteriorUse } from "./style";

export interface BuiltInterior {
  panels: Panel[];
  colliders: ColliderBox[];
  floors: number;
}

/** matches the parallax-window zone so what you see through the glass ≈ what you
 *  find inside: homes (parlour/apartments), shops (retail + offices), lofts (open). */
export type InteriorZone = InteriorUse;

/**
 * Largest axis-aligned rectangle that fits INSIDE a (local-frame) footprint polygon.
 * Rasterises the bbox into an N×N inside/outside grid (cell centres tested against
 * the poly) and runs the classic "maximal rectangle in a binary matrix" scan. The
 * footprint is already rotated so its street edge is axis-aligned, so this rect is
 * well-oriented for the room plan. Returns null for a degenerate lot (caller falls
 * back to the bbox). O(N²) + N² point-in-poly — trivial for a lazily-built interior.
 */
function inscribedRect(poly: readonly Vec2[], bb: Rect, N = 48): Rect | null {
  const W = bb.x1 - bb.x0, H = bb.z1 - bb.z0;
  if (W <= 0.5 || H <= 0.5) return null;
  const cw = W / N, ch = H / N;
  const inside: Uint8Array[] = [];
  for (let r = 0; r < N; r++) {
    const row = new Uint8Array(N);
    const z = bb.z0 + (r + 0.5) * ch;
    for (let c = 0; c < N; c++) row[c] = pointInPoly(poly, bb.x0 + (c + 0.5) * cw, z) ? 1 : 0;
    inside.push(row);
  }
  const h = new Int32Array(N);
  let best: { c0: number; c1: number; r0: number; r1: number } | null = null, bestA = 0;
  const st: number[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) h[c] = inside[r][c] ? h[c] + 1 : 0;
    st.length = 0;
    for (let c = 0; c <= N; c++) {
      const cur = c < N ? h[c] : 0;
      while (st.length && h[st[st.length - 1]] >= cur) {
        const height = h[st.pop()!];
        const left = st.length ? st[st.length - 1] + 1 : 0;
        const a = height * (c - left);
        if (a > bestA) { bestA = a; best = { c0: left, c1: c - 1, r0: r - height + 1, r1: r }; }
      }
      st.push(c);
    }
  }
  if (!best) return null;
  return {
    x0: bb.x0 + best.c0 * cw, x1: bb.x0 + (best.c1 + 1) * cw,
    z0: bb.z0 + best.r0 * ch, z1: bb.z0 + (best.r1 + 1) * ch,
  };
}

/** index of the roomiest cell (best chance of fitting the stair). */
function roomiest(rooms: Rect[]): number {
  let best = 0, bestV = -1;
  for (let i = 0; i < rooms.length; i++) {
    const v = rectMinDim(rooms[i]);
    if (v > bestV) { bestV = v; best = i; }
  }
  return best;
}

export function buildInterior(spec: BuildingSpec, zone: InteriorZone = "residential"): BuiltInterior {
  // Lay the whole interior out in the FOOTPRINT'S LOCAL FRAME. SF lots are rotated
  // ~30–45° off the world axes, so an axis-aligned-bbox layout (what this used to
  // do) puts slabs/rooms/stairs/furniture metres OUTSIDE the real walls. We rotate
  // the footprint so its street (longest) edge is axis-aligned, run the unchanged
  // rect-based planner in that frame, then rotate every emitted vertex + collider
  // back to world. The rotation matches box3d's yaw convention (a box yawed by θ
  // has its +X extent along world (cosθ, sinθ)), so the collider boxes stay glued
  // to the mesh — see the yaw handling in the post-transform below.
  const world = ensureCCW(spec.poly);
  const [ctrX, ctrZ] = centroid(world);
  const si = streetEdgeIndex(world);
  const s0 = world[si], s1 = world[(si + 1) % world.length];
  const theta = Math.atan2(s1[1] - s0[1], s1[0] - s0[0]); // world angle of the street edge
  const cosT = Math.cos(theta), sinT = Math.sin(theta);
  // world → local: rotate by −θ about the centroid (inverse of the local→world below)
  const poly: Vec2[] = world.map(([x, z]) => {
    const dx = x - ctrX, dz = z - ctrZ;
    return [ctrX + dx * cosT + dz * sinT, ctrZ - dx * sinT + dz * cosT] as Vec2;
  });
  const tris = triangulate(poly);
  const bb = bboxOf(poly);
  const bbArea = inset(bb, INSET);
  // Rooms/slabs/furniture lay out on the largest rectangle INSIDE the (aligned) lot,
  // not its bounding box: SF lots are mostly parallelograms/trapezoids, and a bbox
  // rect can't fit inside those — its corners poke through the walls (the ~85%-poke
  // residual a plain local-frame bbox still leaves). The inscribed rect fits by
  // construction, dropping protrusion to well under 1 %. Ground slab stays faithful
  // to the full footprint (below); this only bounds the walk-in room plan.
  const area = inset(inscribedRect(poly, bb) ?? bb, INSET);
  const base = spec.base;
  const nFloors = Math.max(1, Math.min(MAX_FLOORS, Math.round((spec.top - base) / FLOOR_H)));

  const out = new PanelBuilder();
  const cols: ColliderBox[] = [];

  // ---- entrance keep-clear zone -----------------------------------------------
  // The front DOOR sits on the street edge at core doorMetrics' tc — in the local
  // frame that edge is axis-aligned, so the door is a point on it. Keep a small
  // rect just inside the doorway clear of the stair + furniture, or a sofa/flight
  // parked against the entrance blocks the walk-in the doorway contract promises.
  let doorClear: Rect | null = null;
  {
    const s0L = poly[si], s1L = poly[(si + 1) % poly.length];
    const eLen = Math.hypot(s1L[0] - s0L[0], s1L[1] - s0L[1]);
    if (eLen > 2.2) {
      const { tc, halfW } = doorMetrics(eLen, spec.base, spec.top, spec.grade ?? spec.base);
      const dX = s0L[0] + (s1L[0] - s0L[0]) * tc, dZ = s0L[1] + (s1L[1] - s0L[1]) * tc;
      const inZ = ctrZ > dZ ? 1 : -1;            // toward the lot interior (edge is x-aligned)
      const hw = halfW + 0.55, depth = 2.0;      // doorway span + a clear path inward
      doorClear = { x0: dX - hw, x1: dX + hw, z0: Math.min(dZ, dZ + inZ * depth), z1: Math.max(dZ, dZ + inZ * depth) };
    }
  }

  // ---- one shared partition, reused on every floor so walls + the stairwell
  //      stack (realistic, and keeps the stair footprint clear on each storey) --
  // fewer, bigger rooms (each ~35 m²) so the plan feels roomy at player scale
  const target = zone === "loft" ? 1 : Math.max(1, Math.min(3, Math.round(rectArea(area) / 35)));
  let { rooms, walls } = partition(area, target, rng(spec.seed, 101));
  let stairIdx = roomiest(rooms);

  // ---- reserve a staircase (multi-storey only); fall back to one open room if
  //      the roomiest cell can't hold it, so tiny lots still get a usable stair --
  let stair: StairPlan | null = null;
  if (nFloors > 1) {
    if (!stairFits(rooms[stairIdx])) {
      ({ rooms, walls } = partition(area, 1, rng(spec.seed, 102)));
      stairIdx = 0;
    }
    if (stairFits(rooms[stairIdx])) stair = planStair(rooms[stairIdx], doorClear);
  }
  const hole: Rect | null = stair ? stair.hole : null;

  // bath goes in the last non-stair cell on residential upper floors (stacked)
  let bathIdx = -1;
  for (let i = rooms.length - 1; i >= 0; i--) if (!(stair && i === stairIdx)) { bathIdx = i; break; }

  for (let k = 0; k < nFloors; k++) {
    const fY = base + k * FLOOR_H;                       // this storey's floor surface
    const rf = rng(spec.seed, 300 + k);                  // per-floor furniture stream
    const openFloor = zone === "loft" || (zone === "commercial" && k === 0);

    // floor slab: faithful footprint on the ground, inset-bbox ring (with the
    // stairwell hole) on floors above
    if (k === 0) polyGroundSlab(out, cols, poly, tris, fY, bbArea);
    else deck(out, cols, "int.floor", area, hole, fY, true);

    // ceiling: under each upper floor with the stairwell open; a plain cap on top
    if (k < nFloors - 1) deck(out, null, "int.ceil", area, hole, base + (k + 1) * FLOOR_H - 0.06, false);
    else deck(out, null, "int.ceil", area, null, Math.min(spec.top - 0.12, fY + FLOOR_H - 0.06), false);

    // window daylight along the perimeter so rooms read as lit
    daylight(out, poly, (bb.x0 + bb.x1) / 2, (bb.z0 + bb.z1) / 2, fY);

    // partition walls (skip on open plans), then the stair up to the next floor
    if (!openFloor) buildWalls(out, cols, walls, fY);
    if (stair && k < nFloors - 1) buildStair(out, cols, stair.region, stair.runAxis, fY);

    // ---- furniture + art (ground floor keeps the entrance zone clear) ---------
    const avoid = k === 0 ? doorClear : null;
    if (openFloor) {
      furnish(out, cols, stair ? stair.region : null, zone === "commercial" ? "retail" : "loft", area, fY, rf, avoid);
    } else {
      let parlorDone = false, kitchenDone = false;
      for (let i = 0; i < rooms.length; i++) {
        let role: Role;
        if (stair && i === stairIdx) role = "stair";
        else if (zone === "commercial") role = "office";
        else if (k === 0) {
          if (!parlorDone) { role = "parlor"; parlorDone = true; }
          else if (!kitchenDone) { role = "kitchen"; kitchenDone = true; }
          else role = "hall";
        } else {
          role = i === bathIdx ? "bath" : "bedroom";
        }
        furnish(out, cols, stair ? stair.region : null, role, rooms[i], fY, rf, avoid);
      }
    }
  }

  const panels = out.panels();

  // ---- rotate the local-frame layout back into world space -------------------
  if (Math.abs(theta) > 1e-6) {
    // vertices + normals: local → world = rotate by +θ about the centroid
    for (const p of panels) {
      const pos = p.positions, nrm = p.normals;
      for (let k = 0; k < pos.length; k += 3) {
        const dx = pos[k] - ctrX, dz = pos[k + 2] - ctrZ;
        pos[k] = ctrX + dx * cosT - dz * sinT;
        pos[k + 2] = ctrZ + dx * sinT + dz * cosT;
        const nx = nrm[k], nz = nrm[k + 2];
        nrm[k] = nx * cosT - nz * sinT;
        nrm[k + 2] = nx * sinT + nz * cosT;
      }
    }
    // colliders: rotate each centre, and orient the box. Plain boxes (yaw 0) become
    // yaw θ; tilted stair ramps (a `quat`) get the θ yaw composed onto their tilt.
    //
    // YAW SIGN (same handedness class as ring.addBody): the mesh above rotates
    // local→world by the app's PLANAR +θ (dx·cosT − dz·sinT, dx·sinT + dz·cosT),
    // which sends local +X to (cosθ, +sinθ). box3d/THREE apply a +Y quaternion in
    // the textbook right-handed sense (a +Y rotation by ψ sends +X to (cosψ, −sinψ)),
    // so the box3d rotation that reproduces the mesh's +θ planar turn is −θ about Y.
    // Plain boxes reach that correctly because they store yaw += θ and ring.addBody
    // NEGATES the yaw; tilted ramps carry a full `quat` that addBody uses verbatim,
    // so the world-outer factor must itself be the −θ quaternion or every ramp on a
    // rotated lot (SF lots sit ~30–45° off-axis) lands MIRRORED about its centre —
    // the incline tilts the wrong way and the stair collider peels off its treads.
    const qy: Quat = [0, Math.sin(-theta / 2), 0, Math.cos(-theta / 2)];
    for (const c of cols) {
      const dx = c.x - ctrX, dz = c.z - ctrZ;
      c.x = ctrX + dx * cosT - dz * sinT;
      c.z = ctrZ + dx * sinT + dz * cosT;
      if (c.quat) c.quat = qmul(qy, c.quat);
      else c.yaw += theta;
    }
  }

  clipCheck(spec, world, cols);
  return { panels, colliders: cols, floors: nFloors };
}

type Quat = readonly [number, number, number, number];
/** Hamilton product a⊗b (world-outer a, local-inner b) — pure, no THREE in core. */
function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

// Dev clip check: after the world rotation, sample a few interior collider centres
// against the real footprint. A tight rect-in-local layout should stay inside; a
// degenerate concave lot (a thin L/T notch) can still poke, which is acceptable if
// rare. Warn at most once per building id so a repeatedly re-entered interior stays
// quiet, and surface the running out-of-footprint rate on a dev global.
const clipWarned = new Set<number>();
const clipStat = { checked: 0, poked: 0 };
function clipCheck(spec: BuildingSpec, worldPoly: Vec2[], cols: ColliderBox[]): void {
  let outside = 0, n = 0;
  for (let i = 0; i < cols.length; i += Math.max(1, Math.ceil(cols.length / 24))) {
    const c = cols[i];
    n++;
    if (!pointInPoly(worldPoly, c.x, c.z) && distToPolyEdge(worldPoly, c.x, c.z) > 0.75) outside++;
  }
  clipStat.checked++;
  if (outside > 0) {
    clipStat.poked++;
    if (!clipWarned.has(spec.id)) {
      clipWarned.add(spec.id);
      // eslint-disable-next-line no-console
      console.warn(`[citygen interior] building ${spec.id} (${spec.archetype}): ${outside}/${n} sampled colliders outside footprint`);
    }
  }
  (globalThis as { __sfInteriorClip?: typeof clipStat }).__sfInteriorClip = clipStat;
}
