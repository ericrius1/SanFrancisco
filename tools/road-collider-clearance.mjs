import { readFile } from "node:fs/promises";

const CELL = 96;
const ROAD_MARGIN = 0.9;

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

export function colliderOverlapsRoad(collider, index) {
  const cos = Math.cos(collider.yaw);
  const sin = Math.sin(collider.yaw);
  const radius = Math.hypot(collider.hx, collider.hz) + index.maxHalf;
  const x0 = Math.floor((collider.x - radius) / CELL);
  const x1 = Math.floor((collider.x + radius) / CELL);
  const z0 = Math.floor((collider.z - radius) / CELL);
  const z1 = Math.floor((collider.z + radius) / CELL);
  const seen = new Set();
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
        const roadHalf = road.width * 0.5 + index.margin;
        if (segmentRectDistance(ax, az, bx, bz, collider.hx, collider.hz) <= roadHalf) return road;
      }
    }
  }
  return null;
}

export function filterRoadOverlappingColliders(colliders, index) {
  const kept = [];
  const dropped = [];
  for (const collider of colliders) {
    const road = colliderOverlapsRoad(collider, index);
    if (road) dropped.push({ collider, roadId: road.id });
    else kept.push(collider);
  }
  return { kept, dropped };
}
