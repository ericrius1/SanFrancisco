/**
 * RoadGraph — runtime road-network queries for the AI-cars fleet.
 *
 * Loads the slim `public/data/roads.json` (produced by tools/export-roads.mjs),
 * decodes it into flat typed arrays, and builds a 64 m spatial hash of polyline
 * edges for cheap nearest-road lookups. Everything downstream (fleet sensors,
 * spawning) goes through `project`, `lookAhead`, `randomPointNear`.
 *
 * Coordinates are world metres (x, z planar; Y comes from WorldMap elsewhere).
 * The JSON stores coords as 0.1 m ints (metres ×10); we divide back on load.
 *
 * Node-testable: the parsing/index core lives in the constructor which takes an
 * already-parsed JSON object, so tests feed it `JSON.parse(fs.readFileSync(...))`
 * directly. `RoadGraph.load()` is just a browser fetch wrapper around that.
 */

export type RoadsJson = {
  v: number;
  segs: { p: number[]; w: number }[];
};

export type Projection = {
  segId: number;
  s: number; // arc length (m) from this segment's start point to the projected point
  lateral: number; // signed perpendicular distance (m): + is left of tangent, − is right
  tangentX: number; // unit tangent at the projected point
  tangentZ: number;
  halfWidth: number; // half the road width (m)
};

const CELL = 64; // spatial-hash cell size (m); project() search radius (40 m) < CELL
const MAX_PROJECT_DIST = 40; // nearest-road cap (m)
const HOP_DIST = 15; // max gap to jump across at a polyline end (m)

// integer cell key; world coords comfortably inside ±(4096·64) m
function cellKey(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096);
}

export class RoadGraph {
  readonly segCount: number;
  // flat point store (all segments concatenated)
  private px: Float32Array;
  private pz: Float32Array;
  private ptSeg: Int32Array; // global point index → segId
  private cum: Float32Array; // cumulative arc length from each segment's start
  private segStart: Int32Array; // segId → global index of first point
  private segNum: Int32Array; // segId → point count
  private segTotal: Float32Array; // segId → total polyline length
  private segW: Float32Array; // segId → road width

  // edge hash: cell → global start-indices g (edge is point g → g+1, same seg)
  private cells = new Map<number, number[]>();
  // endpoint hash for cross-segment hops: cell → endpoint-record indices
  private endCells = new Map<number, number[]>();
  private endX: Float32Array;
  private endZ: Float32Array;
  private endSeg: Int32Array;
  private endWhich: Int8Array; // 0 = segment start, 1 = segment end

  // per-edge visited stamp to dedupe multi-cell candidates during a query
  private stamp: Uint32Array;
  private stampGen = 0;

  constructor(json: RoadsJson) {
    const segs = json.segs;
    this.segCount = segs.length;

    let total = 0;
    for (const s of segs) total += s.p.length / 2;
    this.px = new Float32Array(total);
    this.pz = new Float32Array(total);
    this.ptSeg = new Int32Array(total);
    this.cum = new Float32Array(total);
    this.segStart = new Int32Array(this.segCount);
    this.segNum = new Int32Array(this.segCount);
    this.segTotal = new Float32Array(this.segCount);
    this.segW = new Float32Array(this.segCount);
    this.endX = new Float32Array(this.segCount * 2);
    this.endZ = new Float32Array(this.segCount * 2);
    this.endSeg = new Int32Array(this.segCount * 2);
    this.endWhich = new Int8Array(this.segCount * 2);

    let g = 0;
    for (let seg = 0; seg < this.segCount; seg++) {
      const p = segs[seg].p;
      const n = p.length / 2;
      this.segStart[seg] = g;
      this.segNum[seg] = n;
      this.segW[seg] = segs[seg].w;
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const x = p[i * 2] / 10;
        const z = p[i * 2 + 1] / 10;
        this.px[g] = x;
        this.pz[g] = z;
        this.ptSeg[g] = seg;
        if (i > 0) {
          acc += Math.hypot(x - this.px[g - 1], z - this.pz[g - 1]);
        }
        this.cum[g] = acc;
        g++;
      }
      this.segTotal[seg] = acc;
      // register both endpoints for hop lookups
      const g0 = this.segStart[seg];
      const g1 = g0 + n - 1;
      this.endX[seg * 2] = this.px[g0];
      this.endZ[seg * 2] = this.pz[g0];
      this.endSeg[seg * 2] = seg;
      this.endWhich[seg * 2] = 0;
      this.endX[seg * 2 + 1] = this.px[g1];
      this.endZ[seg * 2 + 1] = this.pz[g1];
      this.endSeg[seg * 2 + 1] = seg;
      this.endWhich[seg * 2 + 1] = 1;
    }

    // visited-stamp array indexed by edge start (global point index)
    this.stamp = new Uint32Array(g);

    this.#buildEdgeHash();
    this.#buildEndHash();
  }

  static async load(url = "data/roads.json"): Promise<RoadGraph> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`RoadGraph: failed to load ${url} (${res.status})`);
    const json = (await res.json()) as RoadsJson;
    return new RoadGraph(json);
  }

  /**
   * A uniformly random road point across the whole network, optionally rejected
   * to a bbox. Sampling by stored point concentrates naturally where roads are
   * dense (i.e. the city core), which is exactly what "scatter cars city-wide"
   * wants. Never returns null — falls back to any point if the bbox is starved.
   */
  randomPoint(
    rng: () => number,
    minX = -Infinity,
    maxX = Infinity,
    minZ = -Infinity,
    maxZ = Infinity
  ): { x: number; z: number; tangentX: number; tangentZ: number } {
    const N = this.px.length;
    let g = Math.floor(rng() * N) % N;
    for (let tries = 0; tries < 24; tries++) {
      g = Math.floor(rng() * N) % N;
      const x = this.px[g];
      const z = this.pz[g];
      if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) break;
    }
    const seg = this.ptSeg[g];
    const g0 = this.segStart[seg];
    const gEnd = g0 + this.segNum[seg] - 1;
    let tx = 0;
    let tz = 1;
    if (gEnd > g0) {
      const gA = g < gEnd ? g : g - 1;
      tx = this.px[gA + 1] - this.px[gA];
      tz = this.pz[gA + 1] - this.pz[gA];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
    }
    return { x: this.px[g], z: this.pz[g], tangentX: tx, tangentZ: tz };
  }

  #buildEdgeHash() {
    for (let seg = 0; seg < this.segCount; seg++) {
      const g0 = this.segStart[seg];
      const n = this.segNum[seg];
      for (let i = 0; i < n - 1; i++) {
        const g = g0 + i; // edge g → g+1
        const ax = this.px[g];
        const az = this.pz[g];
        const bx = this.px[g + 1];
        const bz = this.pz[g + 1];
        const cxMin = Math.floor(Math.min(ax, bx) / CELL);
        const cxMax = Math.floor(Math.max(ax, bx) / CELL);
        const czMin = Math.floor(Math.min(az, bz) / CELL);
        const czMax = Math.floor(Math.max(az, bz) / CELL);
        for (let cx = cxMin; cx <= cxMax; cx++) {
          for (let cz = czMin; cz <= czMax; cz++) {
            const key = cellKey(cx, cz);
            let list = this.cells.get(key);
            if (!list) {
              list = [];
              this.cells.set(key, list);
            }
            list.push(g);
          }
        }
      }
    }
  }

  #buildEndHash() {
    for (let e = 0; e < this.endSeg.length; e++) {
      const cx = Math.floor(this.endX[e] / CELL);
      const cz = Math.floor(this.endZ[e] / CELL);
      const key = cellKey(cx, cz);
      let list = this.endCells.get(key);
      if (!list) {
        list = [];
        this.endCells.set(key, list);
      }
      list.push(e);
    }
  }

  /** Nearest road point within 40 m of (x, z), or null. */
  project(x: number, z: number): Projection | null {
    const gen = ++this.stampGen;
    const ccx = Math.floor(x / CELL);
    const ccz = Math.floor(z / CELL);
    let bestD2 = MAX_PROJECT_DIST * MAX_PROJECT_DIST;
    let bestG = -1;
    let bestT = 0;
    for (let cx = ccx - 1; cx <= ccx + 1; cx++) {
      for (let cz = ccz - 1; cz <= ccz + 1; cz++) {
        const list = this.cells.get(cellKey(cx, cz));
        if (!list) continue;
        for (let li = 0; li < list.length; li++) {
          const g = list[li];
          if (this.stamp[g] === gen) continue;
          this.stamp[g] = gen;
          const ax = this.px[g];
          const az = this.pz[g];
          const bx = this.px[g + 1];
          const bz = this.pz[g + 1];
          const ex = bx - ax;
          const ez = bz - az;
          const len2 = ex * ex + ez * ez;
          let t = len2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const projX = ax + t * ex;
          const projZ = az + t * ez;
          const dx = x - projX;
          const dz = z - projZ;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestG = g;
            bestT = t;
          }
        }
      }
    }
    if (bestG < 0) return null;

    const g = bestG;
    const seg = this.ptSeg[g];
    const ax = this.px[g];
    const az = this.pz[g];
    const bx = this.px[g + 1];
    const bz = this.pz[g + 1];
    let ex = bx - ax;
    let ez = bz - az;
    const elen = Math.hypot(ex, ez) || 1;
    ex /= elen;
    ez /= elen;
    const projX = ax + bestT * (bx - ax);
    const projZ = az + bestT * (bz - az);
    const dx = x - projX;
    const dz = z - projZ;
    // 2D cross (tangent × offset): + when the point sits to the left of travel
    const lateral = ex * dz - ez * dx;
    const s = this.cum[g] + bestT * elen;
    return {
      segId: seg,
      s,
      lateral,
      tangentX: ex,
      tangentZ: ez,
      halfWidth: this.segW[seg] * 0.5
    };
  }

  /** World position at arc length `a` along a segment (clamped to its ends). */
  #pointAtArc(seg: number, a: number, out: { x: number; z: number }): void {
    const g0 = this.segStart[seg];
    const n = this.segNum[seg];
    const total = this.segTotal[seg];
    if (a <= 0) {
      out.x = this.px[g0];
      out.z = this.pz[g0];
      return;
    }
    if (a >= total) {
      out.x = this.px[g0 + n - 1];
      out.z = this.pz[g0 + n - 1];
      return;
    }
    for (let i = 0; i < n - 1; i++) {
      const c0 = this.cum[g0 + i];
      const c1 = this.cum[g0 + i + 1];
      if (a <= c1) {
        const seglen = c1 - c0;
        const t = seglen > 1e-9 ? (a - c0) / seglen : 0;
        out.x = this.px[g0 + i] + t * (this.px[g0 + i + 1] - this.px[g0 + i]);
        out.z = this.pz[g0 + i] + t * (this.pz[g0 + i + 1] - this.pz[g0 + i]);
        return;
      }
    }
    out.x = this.px[g0 + n - 1];
    out.z = this.pz[g0 + n - 1];
  }

  #hopOut = { x: 0, z: 0 };

  /**
   * Point `dist` metres further along the polyline from (segId, s) in direction
   * `dir` (+1 walks toward increasing point order, −1 toward decreasing). Clamps
   * at polyline ends; at an end it jumps to a nearby connected segment if one is
   * within 15 m, otherwise clamps.
   *
   * NOTE: returns a single reused object (zero-alloc). Read `.x`/`.z` before the
   * next lookAhead call — do not hold two results at once.
   */
  lookAhead(segId: number, s: number, dir: 1 | -1, dist: number): { x: number; z: number } {
    return this.#walk(segId, s, dir, dist, 0, this.#hopOut);
  }

  #walk(
    seg: number,
    s: number,
    dir: 1 | -1,
    dist: number,
    depth: number,
    out: { x: number; z: number }
  ): { x: number; z: number } {
    const total = this.segTotal[seg];
    const target = s + dir * dist;
    if (target >= 0 && target <= total) {
      this.#pointAtArc(seg, target, out);
      return out;
    }

    // overran an end — how much is left, and which boundary did we hit
    const atEnd = dir === 1; // hit the segment's last point
    const boundaryArc = atEnd ? total : 0;
    const leftover = dir === 1 ? target - total : -target;
    // boundary world point
    this.#pointAtArc(seg, boundaryArc, out);
    const bx = out.x;
    const bz = out.z;

    if (depth >= 4) return out; // avoid pathological hop loops

    // find nearest endpoint of a *different* segment within HOP_DIST
    const ccx = Math.floor(bx / CELL);
    const ccz = Math.floor(bz / CELL);
    let bestD2 = HOP_DIST * HOP_DIST;
    let bestE = -1;
    for (let cx = ccx - 1; cx <= ccx + 1; cx++) {
      for (let cz = ccz - 1; cz <= ccz + 1; cz++) {
        const list = this.endCells.get(cellKey(cx, cz));
        if (!list) continue;
        for (let li = 0; li < list.length; li++) {
          const e = list[li];
          if (this.endSeg[e] === seg) continue;
          const dx = this.endX[e] - bx;
          const dz = this.endZ[e] - bz;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestE = e;
          }
        }
      }
    }
    if (bestE < 0) return out; // no connection — clamp at the boundary

    const seg2 = this.endSeg[bestE];
    // continue into seg2, walking away from the matched endpoint
    if (this.endWhich[bestE] === 0) return this.#walk(seg2, 0, 1, leftover, depth + 1, out);
    return this.#walk(seg2, this.segTotal[seg2], -1, leftover, depth + 1, out);
  }

  /**
   * A random road point in the annulus [rMin, rMax] around (x, z), aligned to
   * its road tangent. Returns null if no road point qualifies. Uses `rng` for
   * determinism in tests.
   */
  randomPointNear(
    x: number,
    z: number,
    rMin: number,
    rMax: number,
    rng: () => number
  ): { x: number; z: number; segId: number; s: number; tangentX: number; tangentZ: number } | null {
    // sample points on segments whose vertices fall in the ring; pick one
    const rMin2 = rMin * rMin;
    const rMax2 = rMax * rMax;
    const cellR = Math.ceil(rMax / CELL);
    const ccx = Math.floor(x / CELL);
    const ccz = Math.floor(z / CELL);
    const gen = ++this.stampGen;
    const candidates: number[] = [];
    for (let cx = ccx - cellR; cx <= ccx + cellR; cx++) {
      for (let cz = ccz - cellR; cz <= ccz + cellR; cz++) {
        const list = this.cells.get(cellKey(cx, cz));
        if (!list) continue;
        for (let li = 0; li < list.length; li++) {
          const g = list[li];
          if (this.stamp[g] === gen) continue;
          this.stamp[g] = gen;
          const dx = this.px[g] - x;
          const dz = this.pz[g] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 >= rMin2 && d2 <= rMax2) candidates.push(g);
        }
      }
    }
    if (candidates.length === 0) return null;
    const g = candidates[Math.floor(rng() * candidates.length) % candidates.length];
    const seg = this.ptSeg[g];
    // tangent toward the next point (or previous at the tail)
    const g0 = this.segStart[seg];
    const gEnd = g0 + this.segNum[seg] - 1;
    const gA = g < gEnd ? g : g - 1;
    let tx = this.px[gA + 1] - this.px[gA];
    let tz = this.pz[gA + 1] - this.pz[gA];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    return { x: this.px[g], z: this.pz[g], segId: seg, s: this.cum[g], tangentX: tx, tangentZ: tz };
  }
}
