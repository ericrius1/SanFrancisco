import type * as THREE from "three/webgpu";
import type { WorldMap } from "../../world/heightmap";

/**
 * Presidio Golf Course data + terrain queries. The polygons come straight from
 * OSM (tools/bake-golf.mjs → public/data/golf.json, world meters). This module
 * owns the golf-aware ground model the renderer AND the ball physics share:
 * greens are flattened onto least-squares planes (real greens are graded — the
 * raw 8 m heightfield under them is not puttable), tee boxes level out to pads,
 * and both blend back into the terrain toward their edges so nothing floats.
 */

export type GolfSurface = "green" | "tee" | "bunker" | "path" | "fairway" | "rough" | "out";

export type GolfPoly = { o: [number, number][]; i: [number, number][][] };

export type GolfHole = {
  ref: number;
  par: number;
  hcp: number;
  line: [number, number][];
  tee: number;
  green: number;
  len: number;
  teeXZ: [number, number];
  pinXZ: [number, number];
};

export type GolfData = {
  name: string;
  holes: GolfHole[];
  greens: GolfPoly[];
  tees: GolfPoly[];
  bunkers: GolfPoly[];
  fairways: GolfPoly[];
  rough: GolfPoly[];
  paths: [number, number][][];
  boundary: [number, number][];
};

/** Everything golf draws/rolls on sits this far above the draped park lawn. */
export const GOLF_LIFT = 0.12;

type AABB = { minX: number; minZ: number; maxX: number; maxZ: number };

type Flatten = {
  // plane y = ax*x + az*z + c (tee pads are the a=0 special case)
  ax: number;
  az: number;
  c: number;
  blend: number; // edge band (m) where the plane eases back into terrain
};

const ringAABB = (r: [number, number][], pad = 0): AABB => {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of r) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
};

function pointInRing(x: number, z: number, r: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPoly(x: number, z: number, p: GolfPoly): boolean {
  if (!pointInRing(x, z, p.o)) return false;
  for (const hole of p.i) if (pointInRing(x, z, hole)) return false;
  return true;
}

/** Unsigned distance to the polygon outline (outer ring only — golf features
 *  are small and convex-ish; inner rings are rare and tiny). */
export function distToRing(x: number, z: number, r: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [x1, z1] = r[j];
    const [x2, z2] = r[i];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const ll = dx * dx + dz * dz;
    let t = ll > 1e-9 ? ((x - x1) * dx + (z - z1) * dz) / ll : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x1 + t * dx;
    const pz = z1 + t * dz;
    const d = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Feature priority when polygons overlap (fairways envelop greens/bunkers). */
const KIND_PRIORITY: GolfSurface[] = ["tee", "green", "bunker", "path", "fairway", "rough"];

type Indexed = { kind: GolfSurface; idx: number; aabb: AABB };

export class GolfCourse {
  data: GolfData;
  holes: GolfHole[];
  boundaryAABB: AABB;

  #map: WorldMap;
  #features: Indexed[] = [];
  #greenFlat: Flatten[] = [];
  #teeFlat: Flatten[] = [];
  // coarse lookup grid over the course AABB: cell → feature indices, priority-sorted
  #grid: Int32Array = new Int32Array(0);
  #gridLists: Indexed[][] = [];
  #gw = 0;
  #gh = 0;
  #cell = 16;

  private constructor(data: GolfData, map: WorldMap) {
    this.data = data;
    this.holes = data.holes;
    this.#map = map;
    this.boundaryAABB = ringAABB(data.boundary, 30);

    const push = (kind: GolfSurface, polys: GolfPoly[], pad: number) => {
      polys.forEach((p, idx) => this.#features.push({ kind, idx, aabb: ringAABB(p.o, pad) }));
    };
    push("green", data.greens, 4);
    push("tee", data.tees, 2);
    push("bunker", data.bunkers, 1);
    push("fairway", data.fairways, 1);
    push("rough", data.rough, 1);

    this.#buildGrid();
    this.#fitGreens();
    this.#fitTees();
  }

  static async load(map: WorldMap): Promise<GolfCourse> {
    const res = await fetch("/data/golf.json");
    if (!res.ok) throw new Error(`golf.json ${res.status}`);
    return new GolfCourse((await res.json()) as GolfData, map);
  }

  #buildGrid() {
    const b = this.boundaryAABB;
    this.#gw = Math.ceil((b.maxX - b.minX) / this.#cell);
    this.#gh = Math.ceil((b.maxZ - b.minZ) / this.#cell);
    this.#grid = new Int32Array(this.#gw * this.#gh).fill(-1);
    const order = (f: Indexed) => KIND_PRIORITY.indexOf(f.kind);
    for (let gy = 0; gy < this.#gh; gy++) {
      for (let gx = 0; gx < this.#gw; gx++) {
        const cminX = b.minX + gx * this.#cell;
        const cminZ = b.minZ + gy * this.#cell;
        const hits = this.#features.filter(
          (f) => f.aabb.minX < cminX + this.#cell && f.aabb.maxX > cminX && f.aabb.minZ < cminZ + this.#cell && f.aabb.maxZ > cminZ
        );
        if (!hits.length) continue;
        hits.sort((a, c) => order(a) - order(c));
        this.#grid[gy * this.#gw + gx] = this.#gridLists.length;
        this.#gridLists.push(hits);
      }
    }
  }

  /** Least-squares plane per green over interior terrain samples, slope clamped
   *  to stay puttable, raised a touch so it reads as a built-up surface. */
  #fitGreens() {
    this.#greenFlat = this.data.greens.map((p) => {
      const bb = ringAABB(p.o);
      const pts: [number, number, number][] = [];
      for (let z = bb.minZ; z <= bb.maxZ; z += 3) {
        for (let x = bb.minX; x <= bb.maxX; x += 3) {
          if (pointInPoly(x, z, p)) pts.push([x, z, this.#map.effectiveGround(x, z)]);
        }
      }
      if (pts.length < 4) {
        const [cx, cz] = p.o[0];
        return { ax: 0, az: 0, c: this.#map.effectiveGround(cx, cz), blend: 2.5 };
      }
      // normal equations for y = ax*x + az*z + c, centered for conditioning
      let mx = 0;
      let mz = 0;
      let my = 0;
      for (const [x, z, y] of pts) {
        mx += x;
        mz += z;
        my += y;
      }
      mx /= pts.length;
      mz /= pts.length;
      my /= pts.length;
      let sxx = 0;
      let szz = 0;
      let sxz = 0;
      let sxy = 0;
      let szy = 0;
      for (const [x, z, y] of pts) {
        const dx = x - mx;
        const dz = z - mz;
        const dy = y - my;
        sxx += dx * dx;
        szz += dz * dz;
        sxz += dx * dz;
        sxy += dx * dy;
        szy += dz * dy;
      }
      const det = sxx * szz - sxz * sxz;
      let ax = 0;
      let az = 0;
      if (Math.abs(det) > 1e-6) {
        ax = (sxy * szz - szy * sxz) / det;
        az = (szy * sxx - sxy * sxz) / det;
      }
      // clamp gradient to ~3.5% — a stiff-but-fair putting slope
      const g = Math.hypot(ax, az);
      if (g > 0.035) {
        ax *= 0.035 / g;
        az *= 0.035 / g;
      }
      const c = my + 0.1 - ax * mx - az * mz;
      return { ax, az, c, blend: 3 };
    });
  }

  /** Tee boxes: dead-level pads at the high corner of their footprint. */
  #fitTees() {
    this.#teeFlat = this.data.tees.map((p) => {
      let top = -Infinity;
      let n = 0;
      let sum = 0;
      for (const [x, z] of p.o) {
        const h = this.#map.effectiveGround(x, z);
        top = Math.max(top, h);
        sum += h;
        n++;
      }
      const y = (sum / n) * 0.35 + top * 0.65 + 0.06;
      return { ax: 0, az: 0, c: y, blend: 1.4 };
    });
  }

  #featuresAt(x: number, z: number): Indexed[] | null {
    const b = this.boundaryAABB;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return null;
    const gx = Math.floor((x - b.minX) / this.#cell);
    const gy = Math.floor((z - b.minZ) / this.#cell);
    const li = this.#grid[gy * this.#gw + gx];
    return li >= 0 ? this.#gridLists[li] : null;
  }

  polyOf(kind: GolfSurface, idx: number): GolfPoly {
    const src =
      kind === "green"
        ? this.data.greens
        : kind === "tee"
          ? this.data.tees
          : kind === "bunker"
            ? this.data.bunkers
            : kind === "fairway"
              ? this.data.fairways
              : this.data.rough;
    return src[idx];
  }

  /** Highest-priority golf feature under (x,z). `rough` = inside the course
   *  fence with nothing better; `out` = beyond the fence. */
  surfaceAt(x: number, z: number): { kind: GolfSurface; idx: number } {
    const list = this.#featuresAt(x, z);
    if (list) {
      for (const f of list) {
        if (x < f.aabb.minX || x > f.aabb.maxX || z < f.aabb.minZ || z > f.aabb.maxZ) continue;
        if (pointInPoly(x, z, this.polyOf(f.kind, f.idx))) return { kind: f.kind, idx: f.idx };
      }
    }
    if (pointInRing(x, z, this.data.boundary)) return { kind: "rough", idx: -1 };
    return { kind: "out", idx: -1 };
  }

  /** Golf-aware ground: draped lawn + GOLF_LIFT, with greens/tees eased onto
   *  their fitted planes. This is what the course meshes AND the ball share. */
  ground(x: number, z: number): number {
    const terrain = this.#map.effectiveGround(x, z) + GOLF_LIFT;
    const list = this.#featuresAt(x, z);
    if (!list) return terrain;
    for (const f of list) {
      if (f.kind !== "green" && f.kind !== "tee") continue;
      if (x < f.aabb.minX || x > f.aabb.maxX || z < f.aabb.minZ || z > f.aabb.maxZ) continue;
      const poly = this.polyOf(f.kind, f.idx);
      if (!pointInPoly(x, z, poly)) continue;
      const flat = f.kind === "green" ? this.#greenFlat[f.idx] : this.#teeFlat[f.idx];
      const plane = flat.ax * x + flat.az * z + flat.c + GOLF_LIFT;
      const d = distToRing(x, z, poly.o);
      const t = Math.min(1, d / flat.blend);
      const ease = t * t * (3 - 2 * t);
      return terrain + (plane - terrain) * ease;
    }
    return terrain;
  }

  /** Finite-difference normal of the golf ground (greens: the fitted plane). */
  groundNormal(x: number, z: number, out: THREE.Vector3, eps = 0.6): THREE.Vector3 {
    const hL = this.ground(x - eps, z);
    const hR = this.ground(x + eps, z);
    const hD = this.ground(x, z - eps);
    const hU = this.ground(x, z + eps);
    out.set(hL - hR, 2 * eps, hD - hU);
    return out.normalize();
  }

  /** Pin (cup) world position for a hole. */
  pin(holeIdx: number, out: THREE.Vector3): THREE.Vector3 {
    const h = this.holes[holeIdx];
    const [x, z] = h.pinXZ;
    out.set(x, this.ground(x, z), z);
    return out;
  }

  /** Primary tee spot for a hole — the OSM hole-line start, seated on the pad. */
  teeSpot(holeIdx: number, out: THREE.Vector3): THREE.Vector3 {
    const h = this.holes[holeIdx];
    const [x, z] = h.line[0];
    out.set(x, this.ground(x, z), z);
    return out;
  }

  /** Initial aim (radians, atan2(x,z) heading convention) — down the hole line. */
  teeAim(holeIdx: number): number {
    const l = this.holes[holeIdx].line;
    const dx = l[1][0] - l[0][0];
    const dz = l[1][1] - l[0][1];
    return Math.atan2(dx, dz);
  }

  /** Nearest hole tee within `maxDist` of (x,z), or -1. */
  nearestTee(x: number, z: number, maxDist: number): number {
    let best = -1;
    let bd = maxDist * maxDist;
    for (let i = 0; i < this.holes.length; i++) {
      const [tx, tz] = this.holes[i].line[0];
      const d = (tx - x) * (tx - x) + (tz - z) * (tz - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
}
