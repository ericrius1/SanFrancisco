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
  yardages: { black: number; white: number; blue: number; red: number };
  teeXZ: [number, number];
  pinXZ: [number, number];
};

export type GolfData = {
  name: string;
  sources?: { geometry: string; scorecard: string };
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
type PathSegment = { x1: number; z1: number; x2: number; z2: number; aabb: AABB };

const PATH_HALF_WIDTH = 1.1; // must match course.ts's 2.2 m cart-path ribbon
const COURSE_SMOOTH_RADIUS = 5; // soften the coarse DEM without erasing real grades
const COURSE_EDGE_BLEND = 12; // meet the surrounding collision terrain without a step
const MAX_GOLF_FILL = 0.75; // never build a multi-metre mound over coarse DEM cells

export class GolfCourse {
  data: GolfData;
  holes: GolfHole[];
  boundaryAABB: AABB;

  #map: WorldMap;
  #features: Indexed[] = [];
  #greenFlat: Flatten[] = [];
  #teeFlat: Flatten[] = [];
  #pathSegments: PathSegment[] = [];
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

    // Fit short-game planes first: their residual-derived blend widths also
    // determine how far outside each polygon the lookup grid must retain it.
    this.#fitGreens();
    this.#fitTees();

    const push = (kind: GolfSurface, polys: GolfPoly[], pad: number | ((idx: number) => number)) => {
      polys.forEach((p, idx) => this.#features.push({ kind, idx, aabb: ringAABB(p.o, typeof pad === "function" ? pad(idx) : pad) }));
    };
    push("green", data.greens, (idx) => this.#greenFlat[idx].blend);
    push("tee", data.tees, (idx) => this.#teeFlat[idx].blend);
    push("bunker", data.bunkers, 1);
    push("fairway", data.fairways, 1);
    push("rough", data.rough, 1);

    for (const line of data.paths) {
      for (let i = 0; i < line.length - 1; i++) {
        const [x1, z1] = line[i];
        const [x2, z2] = line[i + 1];
        this.#pathSegments.push({
          x1,
          z1,
          x2,
          z2,
          aabb: {
            minX: Math.min(x1, x2) - PATH_HALF_WIDTH,
            minZ: Math.min(z1, z2) - PATH_HALF_WIDTH,
            maxX: Math.max(x1, x2) + PATH_HALF_WIDTH,
            maxZ: Math.max(z1, z2) + PATH_HALF_WIDTH
          }
        });
      }
    }

    this.#buildGrid();
  }

  static async load(map: WorldMap): Promise<GolfCourse> {
    const res = await fetch("/data/golf.json");
    if (!res.ok) throw new Error(`golf.json ${res.status}`);
    const course = new GolfCourse((await res.json()) as GolfData, map);
    // The golf sheet is not just a ball/render concern: WorldMap is the shared
    // terrain source for the walk carpet, rides and raycasts. Registering it
    // here keeps feet, clubs and vehicle wheels on the same smooth surface.
    map.setGroundTopOverlay((x, z, base) => (course.contains(x, z) ? course.ground(x, z, base) : base));
    return course;
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
          if (pointInPoly(x, z, p)) pts.push([x, z, this.#smoothedTerrain(x, z)]);
        }
      }
      if (pts.length < 4) {
        const [cx, cz] = p.o[0];
        return { ax: 0, az: 0, c: this.#smoothedTerrain(cx, cz), blend: 2.5 };
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
      let c = my + 0.1 - ax * mx - az * mz;
      // Keep the whole fitted plane above the baked terrain. This preserves a
      // truly planar putting surface instead of relying on a per-point clamp.
      let needed = 0;
      for (const [x, z] of pts) {
        needed = Math.max(needed, this.#map.baseGroundTop(x, z) + 0.025 - GOLF_LIFT - (ax * x + az * z + c));
      }
      c += needed;
      let residual = 0;
      for (const [x, z, y] of pts) residual = Math.max(residual, Math.abs(ax * x + az * z + c - y));
      // Transition outside the green, wide enough to keep the approach grade
      // near 5.5% even where the coarse DEM differs sharply from the fit.
      return { ax, az, c, blend: Math.min(18, Math.max(5, residual / 0.055)) };
    });
  }

  /** Tee boxes: dead-level pads at the high corner of their footprint. */
  #fitTees() {
    this.#teeFlat = this.data.tees.map((p) => {
      const bb = ringAABB(p.o);
      const pts: [number, number, number][] = [];
      for (let z = bb.minZ; z <= bb.maxZ; z += 1.5) {
        for (let x = bb.minX; x <= bb.maxX; x += 1.5) {
          if (pointInPoly(x, z, p)) pts.push([x, z, this.#smoothedTerrain(x, z)]);
        }
      }
      for (const [x, z] of p.o) pts.push([x, z, this.#smoothedTerrain(x, z)]);
      let top = -Infinity;
      let n = 0;
      let sum = 0;
      for (const [x, z] of p.o) {
        const h = this.#smoothedTerrain(x, z);
        top = Math.max(top, h);
        sum += h;
        n++;
      }
      let y = (sum / n) * 0.35 + top * 0.65 + 0.06;
      for (const [x, z] of pts) y = Math.max(y, this.#map.baseGroundTop(x, z) + 0.025 - GOLF_LIFT);
      let residual = 0;
      for (const [, , terrain] of pts) residual = Math.max(residual, Math.abs(y - terrain));
      // Tee pads stay dead level; the height difference is paid back in the
      // surrounding rough, not as a steep ramp across the teeing surface.
      return { ax: 0, az: 0, c: y, blend: Math.min(28, Math.max(5, residual / 0.06)) };
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

  #onPath(x: number, z: number): boolean {
    const rr = PATH_HALF_WIDTH * PATH_HALF_WIDTH;
    for (const s of this.#pathSegments) {
      const b = s.aabb;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      const dx = s.x2 - s.x1;
      const dz = s.z2 - s.z1;
      const ll = dx * dx + dz * dz;
      let t = ll > 1e-9 ? ((x - s.x1) * dx + (z - s.z1) * dz) / ll : 0;
      t = Math.min(1, Math.max(0, t));
      const px = s.x1 + dx * t;
      const pz = s.z1 + dz * t;
      const ox = x - px;
      const oz = z - pz;
      if (ox * ox + oz * oz <= rr) return true;
    }
    return false;
  }

  /** Course footprint query shared with world vegetation. `margin` also clears
   *  clusters whose centre is just outside but whose blades would spill in. */
  contains(x: number, z: number, margin = 0): boolean {
    const b = this.boundaryAABB;
    if (x < b.minX - margin || x > b.maxX + margin || z < b.minZ - margin || z > b.maxZ + margin) return false;
    return pointInRing(x, z, this.data.boundary) || (margin > 0 && distToRing(x, z, this.data.boundary) <= margin);
  }

  /** Five-tap low-pass over the bilinear rendered ground. The 5 m kernel removes
   *  visible DEM facets under long fairways while retaining the course's hills. */
  #smoothedTerrain(x: number, z: number): number {
    const r = COURSE_SMOOTH_RADIUS;
    return (
      this.#map.baseGroundTop(x, z) * 0.5 +
      (this.#map.baseGroundTop(x - r, z) +
        this.#map.baseGroundTop(x + r, z) +
        this.#map.baseGroundTop(x, z - r) +
        this.#map.baseGroundTop(x, z + r)) *
        0.125
    );
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
    // OSM cart paths and a few maintenance polygons extend beyond the course
    // relation. The fence is authoritative for stroke-and-distance penalties.
    if (!this.contains(x, z)) return { kind: "out", idx: -1 };
    const list = this.#featuresAt(x, z);
    if (list) {
      // Short-game surfaces win over a crossing cart path.
      for (const f of list) {
        if (f.kind === "fairway" || f.kind === "rough") continue;
        if (x < f.aabb.minX || x > f.aabb.maxX || z < f.aabb.minZ || z > f.aabb.maxZ) continue;
        if (pointInPoly(x, z, this.polyOf(f.kind, f.idx))) return { kind: f.kind, idx: f.idx };
      }
    }
    // Paths have their own segment index rather than polygon-grid entries, so
    // this check must also run in course cells with no other authored feature.
    if (this.#onPath(x, z)) return { kind: "path", idx: -1 };
    if (list) {
      for (const f of list) {
        if (f.kind !== "fairway" && f.kind !== "rough") continue;
        if (x < f.aabb.minX || x > f.aabb.maxX || z < f.aabb.minZ || z > f.aabb.maxZ) continue;
        if (pointInPoly(x, z, this.polyOf(f.kind, f.idx))) return { kind: f.kind, idx: f.idx };
      }
    }
    return { kind: "rough", idx: -1 };
  }

  /** Tree exclusion for authored play surfaces plus the graded apron around
   *  fitted greens/tees. Rough woodland remains everywhere else. */
  clearsProceduralTrees(x: number, z: number): boolean {
    if (!this.contains(x, z)) return false;
    const kind = this.surfaceAt(x, z).kind;
    if (kind !== "rough") return true;
    const list = this.#featuresAt(x, z);
    if (!list) return false;
    for (const f of list) {
      if (f.kind !== "green" && f.kind !== "tee") continue;
      if (x < f.aabb.minX || x > f.aabb.maxX || z < f.aabb.minZ || z > f.aabb.maxZ) continue;
      const poly = this.polyOf(f.kind, f.idx);
      const flat = f.kind === "green" ? this.#greenFlat[f.idx] : this.#teeFlat[f.idx];
      if (pointInPoly(x, z, poly) || distToRing(x, z, poly.o) < flat.blend) return true;
    }
    return false;
  }

  /** Golf-aware ground: draped lawn + GOLF_LIFT, with greens/tees eased onto
   *  their fitted planes. This is what the course meshes AND the ball share. */
  ground(x: number, z: number, knownBase?: number): number {
    // Only the authored course rides the lifted, smoothed turf sheet. A sliced
    // ball outside the fence returns to the normal world ground instead of
    // floating GOLF_LIFT metres above it.
    const onCourse = this.contains(x, z);
    if (!onCourse) return this.#map.effectiveGround(x, z);
    const base = knownBase ?? this.#map.baseGroundTop(x, z);
    const terrain = this.#smoothedTerrain(x, z) + GOLF_LIFT;
    const list = this.#featuresAt(x, z);
    let target = terrain;
    let weightedPlanes = 0;
    let weightSum = 0;
    let maxStrength = 0;
    if (list) {
      for (const f of list) {
        if (f.kind !== "green" && f.kind !== "tee") continue;
        if (x < f.aabb.minX || x > f.aabb.maxX || z < f.aabb.minZ || z > f.aabb.maxZ) continue;
        const poly = this.polyOf(f.kind, f.idx);
        const flat = f.kind === "green" ? this.#greenFlat[f.idx] : this.#teeFlat[f.idx];
        const inside = pointInPoly(x, z, poly);
        const d = distToRing(x, z, poly.o);
        if (!inside && d >= flat.blend) continue;
        const plane = flat.ax * x + flat.az * z + flat.c + GOLF_LIFT;
        const u = inside ? 1 : 1 - d / flat.blend;
        const strength = u * u * (3 - 2 * u);
        weightedPlanes += plane * strength;
        weightSum += strength;
        maxStrength = Math.max(maxStrength, strength);
      }
    }
    if (weightSum > 0) {
      // Nearby colored tee pads often have overlapping transition bands. Their
      // normalized plane blend stays continuous; the strongest individual
      // influence controls the fade so overlaps cannot add into a raised hump.
      const plane = weightedPlanes / weightSum;
      target = terrain + (plane - terrain) * maxStrength;
    }
    // Fade the low-pass turf sheet into the baked terrain at the course fence.
    // Without this band, smoothing a steep boundary could create a collision
    // lip even though the interior itself is perfectly rollable.
    const edgeT = Math.min(1, distToRing(x, z, this.data.boundary) / COURSE_EDGE_BLEND);
    const edgeEase = edgeT * edgeT * (3 - 2 * edgeT);
    // Stay visibly above the baked terrain, but cap fill where a tiny OSM tee
    // crosses multiple coarse DEM cells. That keeps one anomalous high corner
    // from grading a multi-metre artificial mound through the surrounding rough.
    target = Math.min(base + MAX_GOLF_FILL, Math.max(target, base + 0.025));
    return base + (target - base) * edgeEase;
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

  /** Primary tee spot for a hole — centroid of its associated OSM tee pad. */
  teeSpot(holeIdx: number, out: THREE.Vector3): THREE.Vector3 {
    const h = this.holes[holeIdx];
    const [x, z] = h.teeXZ;
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
      const [tx, tz] = this.holes[i].teeXZ;
      const d = (tx - x) * (tx - x) + (tz - z) * (tz - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }
}
