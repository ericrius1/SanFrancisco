import * as THREE from "three/webgpu";
import { oceanBeachWaveHeight } from "./oceanBeachWaves";

type BridgeDef = {
  name: string;
  line: [number, number, number][];
  width: number;
  towers: [number, number][];
  towerHeight: number;
  color?: string;
  deckThickness?: number;
};

export type Meta = {
  grid: { cellSize: number; width: number; height: number; minX: number; minZ: number };
  tile: number;
  tilesX: number;
  tilesZ: number;
  seaLevel: number;
  terrain?: { formatVersion: number; heightEncoding: "int16"; heightBase: number; heightQuant: number };
  bridges: BridgeDef[];
  spawns: Record<string, { x: number; z: number; heading: number }>;
  landmarks: Record<string, { x: number; z: number }>;
};

export type GroundTopOverlay = (x: number, z: number, base: number) => number;

/** Decoded terrain tile payload (SFTT — see tools/bake-terrain-tiles.mjs and
 * feature-research/m14a-terrain-bake/audit.md). Heights are already meters. */
export type TerrainTileData = {
  cellsX: number;
  cellsZ: number;
  heights: Float32Array;
  surface: Uint8Array;
  deltaIndices: Uint32Array;
  deltaMm: Uint16Array;
};

/** Post-install ground fixup: runtime data-only carves (Corona Heights) that
 * write into groundTops must be re-applied after a streamed tile overwrites
 * their region. `apply` receives the already-intersected inclusive cell rect. */
type TileInstallFixup = {
  minGX: number;
  minGZ: number;
  maxGX: number;
  maxGZ: number;
  apply: (gx0: number, gz0: number, gx1: number, gz1: number) => void;
};

// Overview artifacts are baked at 1/8 resolution (tools/bake-terrain-tiles.mjs).
const OVERVIEW_SCALE = 8;
// terrainResidentRadiusAround cap — comfortably above the ring coordinator's
// SETTLE_CAP + overshoot so residency never artificially constrains a settle.
const TERRAIN_RESIDENT_CAP = 4400;
// Cache cadence for the residency scan (342 tiles — cheap, but callers may
// poll every frame). Mirrors tiles.residentRadiusAround's memo idiom.
const TERRAIN_RESIDENT_REFRESH_MS = 250;

/** Consume a boot-critical download the inline <head> prefetch already started
 * (window.__sfPrefetch). Falls back to a fresh fetch when the prefetch is
 * missing (script not present / HMR), rejected, or its body was already read. */
export function prefetched(url: string): Promise<Response> {
  const pre = (globalThis as { __sfPrefetch?: Record<string, Promise<Response>> }).__sfPrefetch?.[url];
  if (!pre) return fetch(url);
  return pre.then((r) => (r && !r.bodyUsed ? r : fetch(url))).catch(() => fetch(url));
}

export const PALACE_FINE_ARTS = { x: -388, z: -1426 } as const;

export const PALACE_LAGOON = {
  x: -300,
  z: -1426,
  radiusX: 88,
  radiusZ: 112,
  surfaceY: 2.45
} as const;

function smooth01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Authored Palace of Fine Arts lagoon, absent from the generated bay flood-fill. */
export function palaceLagoonMask(x: number, z: number): number {
  const dx = (x - PALACE_LAGOON.x) / PALACE_LAGOON.radiusX;
  const dz = (z - PALACE_LAGOON.z) / PALACE_LAGOON.radiusZ;
  const q = dx * dx + dz * dz;
  return 1 - smooth01(0.78, 1, q);
}

export class WorldMap {
  meta!: Meta;
  heights!: Float32Array;
  // Top of the RENDERED ground: base terrain raised onto draped park lawns
  // (baked by tools/bake-groundtop.mjs). Distinct from `heights`, which is the
  // raw heightfield the lawns sit ABOVE — a ray marching `heights` lands under
  // the visible grass and the splat is occluded. Falls back to `heights` when
  // the bake is missing (older deploys), so behaviour degrades to the old one.
  groundTops!: Float32Array;
  surface!: Uint8Array;
  groundRevision = 0;
  /** True on the default streamed boot path (loadCore): the lattices start as
   *  a bilinear upsample of the 1/8 overview and real 800 m tiles overwrite
   *  their region as they stream. False on the legacy ?fullmap=1 path, where
   *  every cell is real from the start. */
  terrainStreaming = false;
  #bridgeBounds?: { minX: number; maxX: number; minZ: number; maxZ: number }[];
  #groundTopOverlays: GroundTopOverlay[] = [];
  #tileReal: Uint8Array | null = null;
  #tileCells = 0; // cells per tile edge (meta.tile / cellSize = 100)
  #realTileCount = 0;
  #tileFixups: TileInstallFixup[] = [];
  #residentCache = { x: Number.NaN, z: Number.NaN, at: -1e9, value: 0 };
  #pendingRevisionBump = false;

  static async load(): Promise<WorldMap> {
    const map = new WorldMap();
    const [meta, hBuf, sBuf, gBuf] = await Promise.all([
      prefetched("/data/meta.json").then((r) => r.json()),
      prefetched("/data/heightmap.bin").then((r) => r.arrayBuffer()),
      prefetched("/data/surface.bin").then((r) => r.arrayBuffer()),
      // prefer sparse delta; fall back to legacy float32; fall back to null
      (async (): Promise<{ buf: ArrayBuffer; format: "delta" | "float32" } | null> => {
        const r1 = await prefetched("/data/groundtop-delta.bin").catch(() => null);
        if (r1?.ok) {
          const b = await r1.arrayBuffer().catch(() => null);
          if (b) return { buf: b, format: "delta" };
        }
        const r2 = await fetch("/data/groundtop.bin").catch(() => null);
        if (!r2?.ok) return null;
        const b2 = await r2.arrayBuffer().catch(() => null);
        return b2 ? { buf: b2, format: "float32" } : null;
      })()
    ]);
    map.meta = meta;

    // decode heightmap: int16 (post-repack) or legacy float32
    const terrain = meta.terrain;
    if (terrain?.heightEncoding === "int16") {
      const int16 = new Int16Array(hBuf);
      const { heightBase, heightQuant } = terrain;
      const heights = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) heights[i] = heightBase + int16[i] * heightQuant;
      map.heights = heights;
    } else {
      map.heights = new Float32Array(hBuf);
    }

    map.surface = new Uint8Array(sBuf);

    // decode groundTops from delta or legacy float32
    if (!gBuf) {
      map.groundTops = map.heights;
    } else if (gBuf.format === "delta") {
      map.groundTops = decodeGroundTopDelta(gBuf.buf, map.heights);
    } else {
      map.groundTops = new Float32Array(gBuf.buf);
    }

    return map;
  }

  /**
   * M14 default boot path: fetch only meta + the 1/8 overview artifacts
   * (~160 KB), allocate the FULL lattices and bilinear-upsample the overview
   * into them. Every downstream consumer works unmodified on plausible coarse
   * data; real 800 m tiles overwrite their region via installTile as they
   * stream. Falls back to the legacy monolithic load when the overview bake
   * is absent (older deploy / un-baked checkout).
   */
  static async loadCore(): Promise<WorldMap> {
    const [meta, ovRes, ovSurfRes] = await Promise.all([
      prefetched("/data/meta.json").then((r) => r.json()) as Promise<Meta>,
      prefetched("/data/terrain/overview.bin").catch(() => null),
      prefetched("/data/terrain/overview-surface.bin").catch(() => null)
    ]);
    const terrain = meta.terrain;
    if (!ovRes?.ok || !ovSurfRes?.ok || terrain?.heightEncoding !== "int16") {
      console.warn("[heightmap] terrain overview unavailable — falling back to full map load");
      return WorldMap.load();
    }
    const [ovBuf, ovSurfBuf] = await Promise.all([ovRes.arrayBuffer(), ovSurfRes.arrayBuffer()]);
    const map = new WorldMap();
    map.meta = meta;
    const { width: W, height: H } = meta.grid;
    const ow = Math.ceil(W / OVERVIEW_SCALE);
    const oh = Math.ceil(H / OVERVIEW_SCALE);
    const overview = new Int16Array(ovBuf);
    const overviewSurface = new Uint8Array(ovSurfBuf);
    if (overview.length !== ow * oh || overviewSurface.length !== ow * oh) {
      console.warn("[heightmap] terrain overview size mismatch — falling back to full map load");
      return WorldMap.load();
    }

    // Bilinear upsample: overview texel (ox, oz) is the box average of source
    // cells [8ox, 8ox+8) so its sampling center sits at gx = 8ox + 3.5.
    const { heightBase, heightQuant } = terrain;
    const heights = new Float32Array(W * H);
    const surface = new Uint8Array(W * H);
    // Precompute the X-axis taps once (shared by every row).
    const ox0s = new Int32Array(W);
    const ox1s = new Int32Array(W);
    const txs = new Float32Array(W);
    for (let gx = 0; gx < W; gx++) {
      const fx = (gx - (OVERVIEW_SCALE - 1) / 2) / OVERVIEW_SCALE;
      const clamped = Math.min(Math.max(fx, 0), ow - 1.0001);
      const o0 = Math.floor(clamped);
      ox0s[gx] = o0;
      ox1s[gx] = Math.min(ow - 1, o0 + 1);
      txs[gx] = clamped - o0;
    }
    for (let gz = 0; gz < H; gz++) {
      const fz = (gz - (OVERVIEW_SCALE - 1) / 2) / OVERVIEW_SCALE;
      const clampedZ = Math.min(Math.max(fz, 0), oh - 1.0001);
      const oz0 = Math.floor(clampedZ);
      const oz1 = Math.min(oh - 1, oz0 + 1);
      const tz = clampedZ - oz0;
      const row0 = oz0 * ow;
      const row1 = oz1 * ow;
      const surfRow = Math.min(oh - 1, gz >> 3) * ow;
      const out = gz * W;
      for (let gx = 0; gx < W; gx++) {
        const o0 = ox0s[gx];
        const o1 = ox1s[gx];
        const tx = txs[gx];
        const top = overview[row0 + o0] + (overview[row0 + o1] - overview[row0 + o0]) * tx;
        const bottom = overview[row1 + o0] + (overview[row1 + o1] - overview[row1 + o0]) * tx;
        heights[out + gx] = heightBase + (top + (bottom - top) * tz) * heightQuant;
        surface[out + gx] = overviewSurface[surfRow + Math.min(ow - 1, gx >> 3)];
      }
    }
    map.heights = heights;
    map.surface = surface;
    // The overview carries no groundtop deltas — start as a plain height copy
    // (a SEPARATE array: tiles and fixups write deltas into it).
    map.groundTops = new Float32Array(heights);
    map.terrainStreaming = true;
    map.#tileCells = Math.round(meta.tile / meta.grid.cellSize);
    map.#tileReal = new Uint8Array(meta.tilesX * meta.tilesZ);
    return map;
  }

  // ------------------------------------------------------- terrain tiling

  /** Terrain tile grid index containing world (x, z), clamped to the lattice. */
  tileIndexAt(x: number, z: number): { ix: number; iz: number } {
    const { cellSize, width, height, minX, minZ } = this.meta.grid;
    const cells = this.#tileCells || Math.round(this.meta.tile / cellSize);
    const gx = Math.min(Math.max((x - minX) / cellSize, 0), width - 1);
    const gz = Math.min(Math.max((z - minZ) / cellSize, 0), height - 1);
    return { ix: Math.floor(gx / cells), iz: Math.floor(gz / cells) };
  }

  tileKeyAt(x: number, z: number): string {
    const { ix, iz } = this.tileIndexAt(x, z);
    return `${ix}_${iz}`;
  }

  /** True when tile (ix, iz) holds REAL baked data (always true on ?fullmap). */
  isTileReal(ix: number, iz: number): boolean {
    if (!this.terrainStreaming || !this.#tileReal) return true;
    return this.#tileReal[iz * this.meta.tilesX + ix] === 1;
  }

  isTileRealAt(x: number, z: number): boolean {
    if (!this.terrainStreaming) return true;
    const { ix, iz } = this.tileIndexAt(x, z);
    return this.isTileReal(ix, iz);
  }

  /** Terminally failed tile (404 on a stale deploy): accept the overview data
   *  as final so ground gating and the front can never hang forever on data
   *  that does not exist. */
  markTileUnavailable(ix: number, iz: number): void {
    if (!this.#tileReal) return;
    const index = iz * this.meta.tilesX + ix;
    if (this.#tileReal[index] === 1) return;
    this.#tileReal[index] = 1;
    this.#realTileCount++;
    this.#residentCache.at = -1e9;
  }

  /** Reverse a markTileUnavailable so a transient fetch failure is not
   *  terminal for the session. Callers (the tile streamer) must only clear
   *  tiles THEY marked unavailable — never genuinely installed tiles. */
  clearTileUnavailable(ix: number, iz: number): void {
    if (!this.#tileReal) return;
    const index = iz * this.meta.tilesX + ix;
    if (this.#tileReal[index] !== 1) return;
    this.#tileReal[index] = 0;
    this.#realTileCount--;
    this.#residentCache.at = -1e9;
  }

  get realTileCount(): number {
    return this.#realTileCount;
  }

  /**
   * Write a decoded 800 m tile into the BASE lattices (heights, surface,
   * groundTops = height + delta). Runtime overlays (setGroundTopOverlay)
   * compose at query time and are untouched; registered data fixups (Corona)
   * re-apply over the intersecting rect. groundRevision is NOT bumped here —
   * the streamer coalesces installs and bumps once per frame when the tile is
   * physics-relevant (commitRevisionBump).
   */
  installTile(ix: number, iz: number, data: TerrainTileData): void {
    if (!this.#tileReal) return;
    const { width: W } = this.meta.grid;
    const cells = this.#tileCells;
    const gx0 = ix * cells;
    const gz0 = iz * cells;
    const { cellsX, cellsZ } = data;
    for (let lz = 0; lz < cellsZ; lz++) {
      const src = lz * cellsX;
      const dst = (gz0 + lz) * W + gx0;
      const heightRow = data.heights.subarray(src, src + cellsX);
      this.heights.set(heightRow, dst);
      this.groundTops.set(heightRow, dst);
      this.surface.set(data.surface.subarray(src, src + cellsX), dst);
    }
    for (let k = 0; k < data.deltaIndices.length; k++) {
      const local = data.deltaIndices[k];
      const lx = local % cellsX;
      const lz = (local - lx) / cellsX;
      const cell = (gz0 + lz) * W + gx0 + lx;
      this.groundTops[cell] = this.heights[cell] + data.deltaMm[k] / 1000;
    }
    const tileIndex = iz * this.meta.tilesX + ix;
    if (this.#tileReal[tileIndex] !== 1) {
      this.#tileReal[tileIndex] = 1;
      this.#realTileCount++;
    }
    // Re-apply intersecting data fixups AFTER the base rows land.
    const maxGX = gx0 + cellsX - 1;
    const maxGZ = gz0 + cellsZ - 1;
    for (const fixup of this.#tileFixups) {
      const x0 = Math.max(gx0, fixup.minGX);
      const x1 = Math.min(maxGX, fixup.maxGX);
      const z0 = Math.max(gz0, fixup.minGZ);
      const z1 = Math.min(maxGZ, fixup.maxGZ);
      if (x0 <= x1 && z0 <= z1) fixup.apply(x0, z0, x1, z1);
    }
    this.#residentCache.at = -1e9;
    this.#pendingRevisionBump = true;
  }

  /** Register a data-only groundTops carve to re-apply after tile installs.
   *  Bounds are an inclusive CELL rect; `apply` receives the intersection. */
  addTileInstallFixup(
    minGX: number,
    minGZ: number,
    maxGX: number,
    maxGZ: number,
    apply: TileInstallFixup["apply"]
  ): void {
    this.#tileFixups.push({ minGX, minGZ, maxGX, maxGZ, apply });
  }

  /** Flush the coalesced revision bump for installs deemed physics-relevant. */
  commitRevisionBump(): boolean {
    if (!this.#pendingRevisionBump) return false;
    this.#pendingRevisionBump = false;
    this.groundRevision++;
    return true;
  }

  /** Drop a pending bump for installs far from every physics consumer (the
   *  next carpet/patch recenter samples the fresh lattice anyway). */
  discardRevisionBump(): void {
    this.#pendingRevisionBump = false;
  }

  /**
   * Largest radius R around (x, z) such that every terrain tile intersecting
   * the disc holds real data (capped; Infinity-equivalent on ?fullmap). Joins
   * the ring coordinator's residency min so the materialize front never sweeps
   * onto overview-only ground. Cached like tiles.residentRadiusAround.
   */
  terrainResidentRadiusAround(x: number, z: number): number {
    if (!this.terrainStreaming || !this.#tileReal) return TERRAIN_RESIDENT_CAP;
    const cache = this.#residentCache;
    const now = performance.now();
    if (now - cache.at < TERRAIN_RESIDENT_REFRESH_MS && Math.abs(x - cache.x) < 1 && Math.abs(z - cache.z) < 1) {
      return cache.value;
    }
    cache.at = now;
    cache.x = x;
    cache.z = z;
    const { cellSize, width, height, minX, minZ } = this.meta.grid;
    const cells = this.#tileCells;
    const tileMeters = cells * cellSize;
    let r = TERRAIN_RESIDENT_CAP;
    for (let iz = 0; iz < this.meta.tilesZ; iz++) {
      const z0 = minZ + iz * tileMeters;
      const z1 = minZ + Math.min(height, (iz + 1) * cells) * cellSize;
      const dz = Math.max(z0 - z, z - z1, 0);
      if (dz >= r) continue;
      const rowIndex = iz * this.meta.tilesX;
      for (let ix = 0; ix < this.meta.tilesX; ix++) {
        if (this.#tileReal[rowIndex + ix] === 1) continue;
        const x0 = minX + ix * tileMeters;
        const x1 = minX + Math.min(width, (ix + 1) * cells) * cellSize;
        const dx = Math.max(x0 - x, x - x1, 0);
        const d = Math.hypot(dx, dz);
        if (d < r) r = d;
      }
    }
    cache.value = r;
    return r;
  }

  /**
   * Clamped Catmull-Rom bicubic sample of a W*H grid array at world (x, z) —
   * the exact CPU twin of the terrain clipmap's GPU reconstruction
   * (terrainClipmap.ts #heightAt), so the walk carpet, vehicle grounding,
   * paint and cursor sit on the surface the player sees. CR interpolates the
   * lattice values exactly and is C1 (hills curve instead of kinking every
   * 8 m); the clamp to the 4×4 tap neighbourhood's min/max is an anti-ringing
   * guard only — clamping to the central cell's corners would terrace every
   * in-cell crest into per-cell plateaus. Any change here must be mirrored on
   * the GPU.
   */
  #sampleGrid(arr: Float32Array, x: number, z: number): number {
    const { cellSize, width: W, height: H, minX, minZ } = this.meta.grid;
    const fx = Math.min(Math.max((x - minX) / cellSize, 0), W - 1.001);
    const fy = Math.min(Math.max((z - minZ) / cellSize, 0), H - 1.001);
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const clampX = (v: number) => (v < 0 ? 0 : v > W - 1 ? W - 1 : v);
    const clampY = (v: number) => (v < 0 ? 0 : v > H - 1 ? H - 1 : v);
    const cr1 = (p0: number, p1: number, p2: number, p3: number, t: number) => {
      const t2 = t * t;
      const t3 = t2 * t;
      return (
        p0 * (-0.5 * t3 + t2 - 0.5 * t) +
        p1 * (1.5 * t3 - 2.5 * t2 + 1) +
        p2 * (-1.5 * t3 + 2 * t2 + 0.5 * t) +
        p3 * (0.5 * t3 - 0.5 * t2)
      );
    };
    let low = Infinity;
    let high = -Infinity;
    const rowAt = (j: number) => {
      const row = clampY(iy + j) * W;
      const p0 = arr[row + clampX(ix - 1)];
      const p1 = arr[row + clampX(ix)];
      const p2 = arr[row + clampX(ix + 1)];
      const p3 = arr[row + clampX(ix + 2)];
      const rowLow = Math.min(p0, p1, p2, p3);
      const rowHigh = Math.max(p0, p1, p2, p3);
      if (rowLow < low) low = rowLow;
      if (rowHigh > high) high = rowHigh;
      return cr1(p0, p1, p2, p3, tx);
    };
    const value = cr1(rowAt(-1), rowAt(0), rowAt(1), rowAt(2), ty);
    return value < low ? low : value > high ? high : value;
  }

  /** Raw heightfield: the base terrain / bay floor. Use for water depth and
   *  altitude — NOT for "what does a ray hit" (that is `groundTop`). */
  groundHeight(x: number, z: number): number {
    return this.#sampleGrid(this.heights, x, z);
  }

  /** Baked top of the rendered ground before a runtime gameplay surface is
   *  applied. Terrain-fitting systems use this to avoid feeding an overlay
   *  back into itself. */
  baseGroundTop(x: number, z: number): number {
    return this.#sampleGrid(this.groundTops, x, z);
  }

  /** Install a runtime ground sheet. Overlays COMPOSE: each receives the
   *  previous overlay's result as `base` (installation order), so co-resident
   *  sites (Goldman terraces, golf course, archery) don't evict each other.
   *  The composed result is shared by rendering helpers, player/vehicle
   *  grounding, the physics carpet and world raycasts, so authored surfaces
   *  cannot visually diverge from collision. */
  setGroundTopOverlay(overlay?: GroundTopOverlay) {
    if (overlay && !this.#groundTopOverlays.includes(overlay)) this.#groundTopOverlays.push(overlay);
    this.groundRevision++;
  }

  /** Remove one previously installed overlay (identity match). */
  clearGroundTopOverlay(overlay: GroundTopOverlay) {
    const i = this.#groundTopOverlays.indexOf(overlay);
    if (i < 0) return;
    this.#groundTopOverlays.splice(i, 1);
    this.groundRevision++;
  }

  /** Top of the rendered/playable ground — the surface paint, cursor and walk
   *  carpet all rest here. Excludes bridge decks, which effectiveGround adds. */
  groundTop(x: number, z: number): number {
    let top = this.baseGroundTop(x, z);
    for (const overlay of this.#groundTopOverlays) top = overlay(x, z, top);
    return top;
  }

  surfaceType(x: number, z: number): number {
    const { cellSize, width: W, height: H, minX, minZ } = this.meta.grid;
    const ix = Math.min(Math.max(Math.round((x - minX) / cellSize), 0), W - 1);
    const iy = Math.min(Math.max(Math.round((z - minZ) / cellSize), 0), H - 1);
    return this.surface[iy * W + ix];
  }

  isWater(x: number, z: number) {
    return this.surfaceType(x, z) === 3 || this.lagoonWater(x, z);
  }

  /**
   * Submerged palace-lagoon basin: mask is high AND the ground actually sits
   * below the pond waterline. The lagoon ellipse overshoots east onto higher
   * urban ground, so a plain mask test floods roads/houses and buries flora in
   * water — gating on ground height keeps water (and the flora exclusion) in the
   * true basin, letting the shore band above the surface stay dry and planted.
   */
  lagoonWater(x: number, z: number): boolean {
    return palaceLagoonMask(x, z) > 0.3 && this.groundHeight(x, z) < PALACE_LAGOON.surfaceY + 0.3;
  }

  /** Deck height if (x,z) is on a bridge corridor, else -Infinity. */
  bridgeDeck(x: number, z: number): number {
    const bounds = (this.#bridgeBounds ??= this.#computeBridgeBounds());
    let best = -Infinity;
    for (let b = 0; b < this.meta.bridges.length; b++) {
      const bb = bounds[b];
      // whole-bridge AABB reject: most queries are open water/land, nowhere near
      if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) continue;
      const br = this.meta.bridges[b];
      const line = br.line;
      for (let i = 0; i < line.length - 1; i++) {
        const [x1, z1, h1] = line[i];
        const [x2, z2, h2] = line[i + 1];
        const dx = x2 - x1;
        const dz = z2 - z1;
        const ll = dx * dx + dz * dz;
        if (ll < 1e-6) continue;
        let t = ((x - x1) * dx + (z - z1) * dz) / ll;
        t = Math.min(1, Math.max(0, t));
        const px = x1 + t * dx;
        const pz = z1 + t * dz;
        const d = Math.hypot(x - px, z - pz);
        if (d < br.width * 0.62) {
          best = Math.max(best, h1 + t * (h2 - h1));
        }
      }
    }
    return best;
  }

  #computeBridgeBounds() {
    return this.meta.bridges.map((br) => {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [px, pz] of br.line) {
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minZ = Math.min(minZ, pz);
        maxZ = Math.max(maxZ, pz);
      }
      const pad = br.width * 0.62; // matches the per-segment corridor half-width
      return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
    });
  }

  /** Ground the player actually stands/drives on: rendered top ground (draped
   *  lawns included, so the walk carpet seats on the grass you see) or bridge
   *  deck. */
  effectiveGround(x: number, z: number): number {
    const terrain = this.groundTop(x, z);
    const deck = this.bridgeDeck(x, z);
    return deck > -Infinity ? Math.max(terrain, deck) : terrain;
  }

  /**
   * effectiveGround for hovering riders: the bridge deck only counts once `y`
   * is already near or above it — passing under a bridge must target the
   * water/terrain below, not catapult the hover spring up to the deck.
   *
   * Terrain source is groundTop (the RENDERED surface: draped roads + lawns —
   * what the physics carpet seats on), not the raw heightfield. On graded
   * streets the road ribbon stands up to ~0.9 m proud of the raw field, and a
   * spring targeting the raw height pressed cars/boards INTO the road surface —
   * the nose ploughed into the climbing carpet slabs and the contact solver ate
   * all forward velocity (the "car stuck mid-street on every Castro hill" bug).
   */
  rideGround(x: number, z: number, y: number): number {
    const terrain = this.groundTop(x, z);
    const deck = this.bridgeDeck(x, z);
    return deck > -Infinity && y > deck - 2.5 ? Math.max(terrain, deck) : terrain;
  }

  normal(x: number, z: number, out: THREE.Vector3, eps = 4): THREE.Vector3 {
    const hL = this.effectiveGround(x - eps, z);
    const hR = this.effectiveGround(x + eps, z);
    const hD = this.effectiveGround(x, z - eps);
    const hU = this.effectiveGround(x, z + eps);
    out.set(hL - hR, 2 * eps, hD - hU);
    return out.normalize();
  }

  /** Bay floor height texture for the water shader (downsampled x2). */
  buildFloorTexture(): { tex: THREE.DataTexture; scale: THREE.Vector4 } {
    const { width: W, height: H, cellSize, minX, minZ } = this.meta.grid;
    const w = W >> 1;
    const h = H >> 1;
    // half float: float32 textures are not filterable in WebGPU without an optional
    // feature, and 16 bits is plenty of precision for bay-floor metres
    const data = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        data[y * w + x] = THREE.DataUtils.toHalfFloat(this.heights[y * 2 * W + x * 2]);
      }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.HalfFloatType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    // uv = (world - min) / extent
    const scale = new THREE.Vector4(minX, minZ, W * cellSize, H * cellSize);
    return { tex, scale };
  }
}

/** Decode a sparse SFGD groundtop-delta buffer into a full groundTops array. */
function decodeGroundTopDelta(buffer: ArrayBuffer, heights: Float32Array): Float32Array {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "SFGD") {
    console.warn("[heightmap] unexpected groundtop-delta magic:", magic, "— using heights");
    return heights;
  }
  const count = view.getUint32(6, true);
  const top = new Float32Array(heights);
  for (let k = 0; k < count; k++) {
    const off = 10 + k * 6;
    const cellIndex = view.getUint32(off, true);
    const deltaMm = view.getUint16(off + 4, true);
    top[cellIndex] = heights[cellIndex] + deltaMm / 1000;
  }
  return top;
}

/**
 * Chop zones: pockets of the bay running livelier waves (0 calm … 1 full chop).
 * Low-frequency sine blobs, so riders keep stumbling onto rough patches without
 * any authored placement. Must stay in lockstep with the GPU copy in water.ts.
 */
export function chopZone(x: number, z: number): number {
  const m = Math.sin(x * 0.0016 + 2.1) * Math.sin(z * 0.0013 - 0.6);
  const s = Math.min(1, Math.max(0, (m - 0.28) / 0.44));
  return s * s * (3 - 2 * s);
}

/** CPU-side water surface height (matches the shader's swell + zone chop). */
export function waterHeight(x: number, z: number, t: number): number {
  let h =
    Math.sin(x * 0.055 + t * 0.9) * 0.09 +
    Math.sin(z * 0.042 - t * 0.7) * 0.07 +
    Math.sin((x + z) * 0.021 + t * 0.45) * 0.1;
  const zone = chopZone(x, z);
  if (zone > 0.001) {
    // travelling swells big enough to kick a board off a crest, still gentle
    h +=
      zone *
      (Math.sin(x * 0.1 + t * 1.35) * 0.36 +
        Math.sin(z * 0.083 - t * 1.1) * 0.29 +
        Math.sin((x + z) * 0.052 + t * 0.8) * 0.24);
  }
  // Pacific surf zone: a directional shoaling train. Kept separate from the
  // generic bay chop so it is easy to sample for board rails and foam/lip FX.
  h += oceanBeachWaveHeight(x, z, t);
  const lagoon = palaceLagoonMask(x, z);
  if (lagoon > 0.001) return PALACE_LAGOON.surfaceY + h * (0.35 + lagoon * 0.3);
  return h;
}
