import { readFile } from "node:fs/promises";

const CELL = 96;
const ROAD_MARGIN = 0.9;

// A box whose closest point merely grazed a road's clearance margin used to
// be dropped WHOLE (audit R4): a real, street-facing building wall could lose
// its entire collider over a ~1m corner overlap, leaving a visibly solid wall
// walk/drive-through right at the sidewalk line. ROAD_MARGIN exists so baked
// boxes don't block the drivable road corridor — it isn't meant to veto any box that so
// much as brushes it. So filterRoadOverlappingColliders below only drops a
// box once a real chunk of ITS OWN footprint sits inside the road corridor,
// measured as a sampled area fraction rather than "any point is within
// margin". Below the threshold the box is kept at full size: a shallow curb
// intrusion an AI car can steer around beats an invisible wall a player walks
// through.
//
// True clipping (shrinking the OBB to hug the corridor boundary) was the
// first thing tried, but the corridor is a rounded-cap capsule per road
// segment and a box can sit at any angle to the nearest segment — there's no
// single axis-aligned-in-the-box's-own-frame cut that reliably resolves an
// arbitrary-angle capsule intersection back into one box. The fractional
// keep/drop rule gets the same practical outcome (real walls survive, deep
// intrusions still get removed) without that geometry. Road widths here top
// out under 20m (see roads.json), so the sampled boxes and their candidate
// lists both stay small — this is cheap even at city scale.
//
// Area fraction alone isn't quite enough, though: measured against the real
// baked city, a handful of very large or elongated boxes (mostly landmark
// sub-boxes — a 220m-long box is not unusual there) can sit at a LOW area
// fraction while still poking several metres past the corridor edge at their
// nearest point, because the same fraction represents a much bigger absolute
// distance on a much bigger box. That poke is a genuine road blocker, not a
// shallow graze. So a box is dropped if EITHER the sampled fraction is high
// OR its closest point still penetrates more than ROAD_DROP_DEPTH_M past the
// corridor boundary — the fraction gate protects small/typical boxes from
// being nuked over a corner graze, the depth gate caps how bad that graze is
// allowed to get on a large box.
const ROAD_DROP_FRACTION = 0.4; // drop once > 40% of the box's own area sits inside the corridor
const ROAD_DROP_DEPTH_M = 2.5; // ...or drop once the box's closest point is this many metres past the corridor boundary
const OVERLAP_SAMPLE_AXIS = 15; // 15x15 sample grid to estimate the fraction (only spent on boxes that already fail the cheap distance test)

const cellKey = (cx, cz) => `${cx},${cz}`;

function pointRectDistance(x, z, hx, hz) {
  const dx = Math.max(Math.abs(x) - hx, 0);
  const dz = Math.max(Math.abs(z) - hz, 0);
  return Math.hypot(dx, dz);
}

function pointSegmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const ll = dx * dx + dz * dz;
  if (ll < 1e-9) return Math.hypot(px - ax, pz - az);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / ll));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function segmentIntersectsRect(ax, az, bx, bz, hx, hz) {
  let t0 = 0;
  let t1 = 1;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  const dx = bx - ax;
  const dz = bz - az;
  return (
    clip(-dx, ax + hx) &&
    clip(dx, hx - ax) &&
    clip(-dz, az + hz) &&
    clip(dz, hz - az)
  );
}

function segmentRectDistance(ax, az, bx, bz, hx, hz) {
  if (segmentIntersectsRect(ax, az, bx, bz, hx, hz)) return 0;
  let best = Math.min(pointRectDistance(ax, az, hx, hz), pointRectDistance(bx, bz, hx, hz));
  best = Math.min(best, pointSegmentDistance(-hx, -hz, ax, az, bx, bz));
  best = Math.min(best, pointSegmentDistance(-hx, hz, ax, az, bx, bz));
  best = Math.min(best, pointSegmentDistance(hx, -hz, ax, az, bx, bz));
  best = Math.min(best, pointSegmentDistance(hx, hz, ax, az, bx, bz));
  return best;
}

export function buildRoadClearanceIndex(roads, margin = ROAD_MARGIN) {
  const cells = new Map();
  let maxHalf = 0;
  let count = 0;
  const add = (seg) => {
    const half = seg.width * 0.5 + margin;
    maxHalf = Math.max(maxHalf, half);
    const x0 = Math.floor((Math.min(seg.ax, seg.bx) - half) / CELL);
    const x1 = Math.floor((Math.max(seg.ax, seg.bx) + half) / CELL);
    const z0 = Math.floor((Math.min(seg.az, seg.bz) - half) / CELL);
    const z1 = Math.floor((Math.max(seg.az, seg.bz) + half) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const key = cellKey(cx, cz);
        let list = cells.get(key);
        if (!list) {
          list = [];
          cells.set(key, list);
        }
        list.push(seg);
      }
    }
    count++;
  };

  for (const road of roads) {
    const pts = road.points;
    if (!pts || pts.length < 2 || !Number.isFinite(road.width)) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      if (Math.hypot(bx - ax, bz - az) < 0.25) continue;
      add({ ax, az, bx, bz, width: road.width, id: road.id });
    }
  }
  return { cells, count, maxHalf, margin };
}

export async function loadRoadClearanceIndexFromRoadsJson(url, margin = ROAD_MARGIN) {
  const json = JSON.parse(await readFile(url, "utf8"));
  const roads = [];
  for (let id = 0; id < json.segs.length; id++) {
    const seg = json.segs[id];
    const pts = [];
    for (let i = 0; i < seg.p.length; i += 2) pts.push([seg.p[i] / 10, seg.p[i + 1] / 10]);
    roads.push({ id, width: seg.w, points: pts });
  }
  return buildRoadClearanceIndex(roads, margin);
}

// Roads near a collider, transformed into the box's own LOCAL frame (origin
// at the box center, box axis-aligned — matches the runtime collider frame,
// see collider-lib.mjs toLocal/toWorld) with each road's clearance
// half-width attached. Shared by the cheap "touches at all" test and the
// fractional-area sampler below so both agree on exactly which roads are in
// play, and so the (identical) cell scan only runs once per box.
function localRoadCandidates(collider, index) {
  const cos = Math.cos(collider.yaw);
  const sin = Math.sin(collider.yaw);
  const radius = Math.hypot(collider.hx, collider.hz) + index.maxHalf;
  const x0 = Math.floor((collider.x - radius) / CELL);
  const x1 = Math.floor((collider.x + radius) / CELL);
  const z0 = Math.floor((collider.z - radius) / CELL);
  const z1 = Math.floor((collider.z + radius) / CELL);
  const seen = new Set();
  const out = [];
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const list = index.cells.get(cellKey(cx, cz));
      if (!list) continue;
      for (const road of list) {
        if (seen.has(road)) continue;
        seen.add(road);
        const ax = (road.ax - collider.x) * cos - (road.az - collider.z) * sin;
        const az = (road.ax - collider.x) * sin + (road.az - collider.z) * cos;
        const bx = (road.bx - collider.x) * cos - (road.bz - collider.z) * sin;
        const bz = (road.bx - collider.x) * sin + (road.bz - collider.z) * cos;
        out.push({ road, ax, az, bx, bz, roadHalf: road.width * 0.5 + index.margin });
      }
    }
  }
  return out;
}

/** Nearest road whose clearance margin the box's closest point falls inside, or null. A cheap coarse "touches at all" test — necessary but not sufficient for real road overlap, see filterRoadOverlappingColliders. */
export function colliderOverlapsRoad(collider, index) {
  for (const c of localRoadCandidates(collider, index)) {
    if (segmentRectDistance(c.ax, c.az, c.bx, c.bz, collider.hx, collider.hz) <= c.roadHalf) return c.road;
  }
  return null;
}

// Fraction (0..1) of the box's own footprint that lies within clearance of
// any candidate road, estimated with a uniform sample grid in the box's local
// frame (cell-center samples, so the grid is an unbiased area estimator).
// Exact analytic area of an OBB against a union of rounded-cap capsules has
// no simple closed form once several segments and an arbitrary box rotation
// are in play; sampling gets within a fraction of a percent and stays trivial
// to reason about (see the module comment above for why this replaced true
// clipping).
function overlapFraction(collider, candidates) {
  const { hx, hz } = collider;
  const n = OVERLAP_SAMPLE_AXIS;
  const du = (2 * hx) / n;
  const dv = (2 * hz) / n;
  let inside = 0;
  for (let i = 0; i < n; i++) {
    const u = -hx + (i + 0.5) * du;
    for (let j = 0; j < n; j++) {
      const v = -hz + (j + 0.5) * dv;
      for (const c of candidates) {
        if (pointSegmentDistance(u, v, c.ax, c.az, c.bx, c.bz) <= c.roadHalf) {
          inside++;
          break;
        }
      }
    }
  }
  return inside / (n * n);
}

export function filterRoadOverlappingColliders(colliders, index) {
  const kept = [];
  const dropped = [];
  for (const collider of colliders) {
    const candidates = localRoadCandidates(collider, index);
    // worst-case penetration across every touching candidate, not just the
    // first found — a box can graze one road shallowly but another deeply
    let touching = null;
    let depth = 0;
    for (const c of candidates) {
      const d = c.roadHalf - segmentRectDistance(c.ax, c.az, c.bx, c.bz, collider.hx, collider.hz);
      if (d < 0) continue; // this candidate alone doesn't reach the box
      if (!touching) touching = c;
      if (d > depth) depth = d;
    }
    if (!touching) {
      kept.push(collider);
      continue;
    }
    const fraction = overlapFraction(collider, candidates);
    if (fraction > ROAD_DROP_FRACTION || depth > ROAD_DROP_DEPTH_M) {
      dropped.push({ collider, roadId: touching.road.id, fraction, depth });
    } else {
      kept.push(collider);
    }
  }
  return { kept, dropped };
}
