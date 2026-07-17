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
  #bridgeBounds?: { minX: number; maxX: number; minZ: number; maxZ: number }[];
  #groundTopOverlays: GroundTopOverlay[] = [];

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
