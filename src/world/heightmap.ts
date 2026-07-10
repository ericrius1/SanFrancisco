import * as THREE from "three/webgpu";

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
  #bridgeBounds?: { minX: number; maxX: number; minZ: number; maxZ: number }[];

  static async load(): Promise<WorldMap> {
    const map = new WorldMap();
    const [meta, hBuf, sBuf, gBuf] = await Promise.all([
      fetch("/data/meta.json").then((r) => r.json()),
      fetch("/data/heightmap.bin").then((r) => r.arrayBuffer()),
      fetch("/data/surface.bin").then((r) => r.arrayBuffer()),
      // prefer sparse delta; fall back to legacy float32; fall back to null
      (async (): Promise<{ buf: ArrayBuffer; format: "delta" | "float32" } | null> => {
        const r1 = await fetch("/data/groundtop-delta.bin").catch(() => null);
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

  /** Bilinear sample of a W*H grid array at world (x, z). */
  #sampleGrid(arr: Float32Array, x: number, z: number): number {
    const { cellSize, width: W, height: H, minX, minZ } = this.meta.grid;
    const fx = Math.min(Math.max((x - minX) / cellSize, 0), W - 1.001);
    const fy = Math.min(Math.max((z - minZ) / cellSize, 0), H - 1.001);
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const ax = fx - ix;
    const ay = fy - iy;
    const i = iy * W + ix;
    const h00 = arr[i];
    const h10 = arr[i + 1];
    const h01 = arr[i + W];
    const h11 = arr[i + W + 1];
    return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
  }

  /** Raw heightfield: the base terrain / bay floor. Use for water depth and
   *  altitude — NOT for "what does a ray hit" (that is `groundTop`). */
  groundHeight(x: number, z: number): number {
    return this.#sampleGrid(this.heights, x, z);
  }

  /** Top of the rendered ground — the surface paint, the cursor and the walk
   *  carpet should rest on. Equals `groundHeight` off-park; on park lawns it is
   *  raised to the draped grass you actually see. Excludes the bridge deck (a
   *  real solid, cast separately in physics.raycastWorld). */
  groundTop(x: number, z: number): number {
    return this.#sampleGrid(this.groundTops, x, z);
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
  const lagoon = palaceLagoonMask(x, z);
  if (lagoon > 0.001) return PALACE_LAGOON.surfaceY + h * (0.35 + lagoon * 0.3);
  return h;
}
