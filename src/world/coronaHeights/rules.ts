// Light placement-rule helpers shared by the Corona Heights park build and the
// site-foliage streamer's registration closures. Deliberately free of heavy
// imports so registering Corona's vegetation at boot costs nothing — the park
// index and the vegetation module both stay behind their dynamic imports.

import { CORONA_TRAILS, type CoronaXZ } from "./layout";

function fract(v: number) {
  return v - Math.floor(v);
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

export function hash2(x: number, z: number, salt = 0) {
  return fract(Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453123);
}

export function pointInPolygon(x: number, z: number, polygon: readonly CoronaXZ[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointSegmentDistance(x: number, z: number, a: CoronaXZ, b: CoronaXZ) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const ll = dx * dx + dz * dz;
  const t = ll > 1e-6 ? clamp01(((x - a[0]) * dx + (z - a[1]) * dz) / ll) : 0;
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

export function distanceToTrails(x: number, z: number) {
  let best = Infinity;
  for (const trail of CORONA_TRAILS) {
    for (let i = 0; i < trail.points.length - 1; i++) {
      best = Math.min(best, pointSegmentDistance(x, z, trail.points[i], trail.points[i + 1]));
    }
  }
  return best;
}
