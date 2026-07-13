import { inJapaneseTeaGarden } from "../japaneseTeaGarden/layout";

// San Francisco Botanical Garden — deterministic layout math. Renderer-free so
// the same tree/shrub/flora placement, collider boxes, and BVH proxy geometry can be
// reconstructed by a headless trainer or ported into another world untouched.
//
// Everything that affects colliders / BVH proxies (tree positions, species,
// scale, trunk dims) is hash-derived here so any consumer rebuilds bit-identical
// obstacles. Purely visual layers (shrubs, ground flora) are placed from the
// lists below but carry NO colliders.
//
// Real-world reference: https://gggp.org/san-francisco-botanical-garden — the
// layout mirrors the real collections: Redwood Grove northwest, Temperate Asia /
// moon-viewing maples north-centre, magnolia + camellia walk by the 9th Ave
// entrance, the Ancient Plant (tree fern) dell just inside the gate, Australia
// southeast, Mediterranean/Chilean palm terraces along the south, California
// natives southwest, a cloud-forest pocket west, and the open Great Meadow at the
// heart with an entrance promenade + loop path.
//
// PORTABILITY: the only thing this needs from the host world is a terrain
// sampler (`GardenTerrain`). Drop the folder into any project that can implement
// those three methods and the garden reconstructs itself at BOTANICAL_GARDEN_BOUNDS.

// --- terrain contract -----------------------------------------------------------

/** Minimal terrain sampler the garden needs. Any host WorldMap satisfies this. */
export type GardenTerrain = {
  groundHeight(x: number, z: number): number;
  surfaceType(x: number, z: number): number;
  isWater(x: number, z: number): boolean;
};

/** Plain geometry buffers, runtime-agnostic (no THREE types). */
export type GeometryBuffers = {
  positions: number[];
  indices: number[];
};

/** Static box collider — a pure data shape the host maps onto its own physics. */
export type GardenCollider = {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  friction: number;
  label: string;
};

// --- footprint + surface --------------------------------------------------------

// Garden footprint, matching the real SFBG: south side of Golden Gate Park
// between Lincoln Way and MLK Jr Drive, ~9th–14th Ave. World coords derived via
// x=(lon+122.444)*87972, z=(37.79-lat)*110574.
export const BOTANICAL_GARDEN_BOUNDS = {
  minX: -2600,
  maxX: -1980,
  minZ: 2210,
  maxZ: 2730
} as const;

export function inBotanicalGarden(x: number, z: number, pad = 0): boolean {
  return (
    x >= BOTANICAL_GARDEN_BOUNDS.minX - pad &&
    x <= BOTANICAL_GARDEN_BOUNDS.maxX + pad &&
    z >= BOTANICAL_GARDEN_BOUNDS.minZ - pad &&
    z <= BOTANICAL_GARDEN_BOUNDS.maxZ + pad
  );
}

/** Small lift off the host terrain (avoids z-fighting) plus a gentle ripple so
 *  the lawn does not read as a flat plane. Decoupled from any park surface mesh:
 *  the garden simply sits on `map.groundHeight`. */
export const GARDEN_SURFACE_LIFT = 0.22;

function gardenDetailHeight(x: number, z: number): number {
  return Math.sin(x * 0.013 + z * 0.019) * 0.045 + Math.sin(x * 0.041 - z * 0.027) * 0.028;
}

/** Ground surface the garden plants onto. Always finite (never null). */
export function gardenSurfaceHeight(map: GardenTerrain, x: number, z: number): number {
  return map.groundHeight(x, z) + GARDEN_SURFACE_LIFT + gardenDetailHeight(x, z);
}

// --- shared deterministic noise -------------------------------------------------

/** Strong-avalanche integer hash (murmur-style finalizer): value changes well
 *  along both axes, so planting never reads as rows. */
function gardenHash(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise on a lattice (0..1), hash-derived → identical everywhere. */
function valueNoise(x: number, z: number, cell: number, salt: number): number {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const ax = fx - ix;
  const az = fz - iz;
  const sx = ax * ax * (3 - 2 * ax);
  const sz = az * az * (3 - 2 * az);
  const n00 = gardenHash(ix, iz, salt);
  const n10 = gardenHash(ix + 1, iz, salt);
  const n01 = gardenHash(ix, iz + 1, salt);
  const n11 = gardenHash(ix + 1, iz + 1, salt);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sz) + (n01 * (1 - sx) + n11 * sx) * sz;
}

function smoothstep(a: number, b: number, t: number): number {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

// --- meadow ---------------------------------------------------------------------

/** Open Great Meadow kept clear of planting — grazing lawn at the heart. */
export const GARDEN_MEADOW = { x: -2260, z: 2450, rx: 130, rz: 95 } as const;

/** 0 at meadow centre, 1 on the ellipse edge, >1 outside. */
export function meadowEllipse(x: number, z: number): number {
  const dx = (x - GARDEN_MEADOW.x) / GARDEN_MEADOW.rx;
  const dz = (z - GARDEN_MEADOW.z) / GARDEN_MEADOW.rz;
  return Math.sqrt(dx * dx + dz * dz);
}

// --- paths ------------------------------------------------------------------------
// Three deterministic primitives: sine corridors (winding collection paths),
// straight segments (entrance promenade from the 9th Ave gate), and the meadow
// loop (ellipse ring just outside the lawn edge).

const GARDEN_SINE_PATHS = [
  { axis: "x", base: 2330, amp: 55, freq: 0.0048, phase: 0.9, halfWidth: 2.4 },
  { axis: "x", base: 2620, amp: 55, freq: 0.0052, phase: 2.3, halfWidth: 2.4 },
  { axis: "z", base: -2480, amp: 50, freq: 0.0052, phase: 0.4, halfWidth: 2.2 },
  { axis: "z", base: -2150, amp: 55, freq: 0.0057, phase: 3.6, halfWidth: 2.2 }
] as const;

// Entrance promenade + fern-dell spur. (ax,az)→(bx,bz) straight walks.
const GARDEN_SEGMENT_PATHS = [
  { ax: -1995, az: 2255, bx: -2130, bz: 2420, halfWidth: 2.6 }, // 9th Ave gate → meadow NE
  { ax: -2050, az: 2465, bx: -2130, bz: 2445, halfWidth: 2.2 } // fern dell → meadow E
] as const;

const MEADOW_LOOP = { at: 1.06, halfWidth: 2.6 } as const;

function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

/** Distance from (x,z) to the nearest path centreline minus its half width (<0 = on path). */
export function gardenPathSignedDistance(x: number, z: number): number {
  let best = Infinity;
  for (const p of GARDEN_SINE_PATHS) {
    const d =
      p.axis === "x"
        ? Math.abs(z - (p.base + p.amp * Math.sin(x * p.freq + p.phase)))
        : Math.abs(x - (p.base + p.amp * Math.sin(z * p.freq + p.phase)));
    best = Math.min(best, d - p.halfWidth);
  }
  for (const s of GARDEN_SEGMENT_PATHS) {
    best = Math.min(best, segmentDistance(x, z, s.ax, s.az, s.bx, s.bz) - s.halfWidth);
  }
  // meadow loop: ellipse-ring distance approximated in metres via the minor radius
  const ring = Math.abs(meadowEllipse(x, z) - MEADOW_LOOP.at) * Math.min(GARDEN_MEADOW.rx, GARDEN_MEADOW.rz);
  best = Math.min(best, ring - MEADOW_LOOP.halfWidth);
  return best;
}

/** 1 on a path, feathering to 0 over ~1.8 m past the edge. Used for ground tint. */
export function gardenPathFactor(x: number, z: number): number {
  if (!inBotanicalGarden(x, z, 8)) return 0;
  const sd = gardenPathSignedDistance(x, z);
  return Math.max(0, Math.min(1, 1 - sd / 1.8));
}

// --- species ------------------------------------------------------------------

export type GardenSpecies = {
  id: number;
  name: string;
  /** trunk collider half-extent (xz) and full height at scale 1 */
  trunkR: number;
  trunkH: number;
  /** canopy proxy cone at scale 1 (BVH raycast proxy only, no collider) */
  canopyR: number;
  canopyH: number;
  /** per-instance scale range */
  sMin: number;
  sMax: number;
};

export const GARDEN_SPECIES: readonly GardenSpecies[] = [
  { id: 0, name: "coast_redwood", trunkR: 0.45, trunkH: 3.6, canopyR: 3.0, canopyH: 15.0, sMin: 0.9, sMax: 1.5 },
  { id: 1, name: "magnolia", trunkR: 0.27, trunkH: 2.1, canopyR: 3.4, canopyH: 5.0, sMin: 0.8, sMax: 1.2 },
  { id: 2, name: "monterey_cypress", trunkR: 0.32, trunkH: 2.3, canopyR: 3.6, canopyH: 6.4, sMin: 0.85, sMax: 1.3 },
  { id: 3, name: "tree_fern", trunkR: 0.18, trunkH: 1.8, canopyR: 2.4, canopyH: 2.0, sMin: 0.8, sMax: 1.15 },
  { id: 4, name: "coast_live_oak", trunkR: 0.38, trunkH: 2.4, canopyR: 4.2, canopyH: 5.5, sMin: 0.85, sMax: 1.25 },
  { id: 5, name: "japanese_maple", trunkR: 0.2, trunkH: 1.7, canopyR: 2.6, canopyH: 3.2, sMin: 0.75, sMax: 1.1 },
  { id: 6, name: "eucalyptus", trunkR: 0.3, trunkH: 3.0, canopyR: 3.0, canopyH: 8.5, sMin: 0.9, sMax: 1.4 },
  { id: 7, name: "chilean_palm", trunkR: 0.33, trunkH: 4.2, canopyR: 2.8, canopyH: 3.0, sMin: 0.85, sMax: 1.2 }
] as const;

// --- collection zones -----------------------------------------------------------
// Nearest-centre wins, with a noise warp so borders wander organically instead of
// reading as circles. Weights pick species inside a zone; palettes drive the
// browser-side shrub/flora colours (indices documented in gardenVegetation.ts).

export type GardenZone = {
  name: string;
  cx: number;
  cz: number;
  r: number;
  treeDensity: number;
  /** cumulative-weight species table: [speciesId, weight] */
  species: readonly (readonly [number, number])[];
  shrubPalette: number;
  shrubDensity: number;
  floraPalette: number;
};

export const GARDEN_ZONES: readonly GardenZone[] = [
  {
    name: "redwood_grove",
    cx: -2500, cz: 2310, r: 140,
    treeDensity: 0.4,
    species: [[0, 0.8], [2, 0.2]],
    shrubPalette: 1, shrubDensity: 0.5, floraPalette: 1
  },
  {
    name: "temperate_asia",
    cx: -2300, cz: 2280, r: 105,
    treeDensity: 0.26,
    species: [[5, 0.55], [1, 0.25], [2, 0.2]],
    shrubPalette: 2, shrubDensity: 0.45, floraPalette: 3
  },
  {
    name: "magnolia_walk",
    cx: -2050, cz: 2300, r: 120,
    treeDensity: 0.24,
    species: [[1, 0.6], [5, 0.2], [2, 0.2]],
    shrubPalette: 2, shrubDensity: 0.5, floraPalette: 3
  },
  {
    name: "fern_dell",
    cx: -2050, cz: 2480, r: 85,
    treeDensity: 0.34,
    species: [[3, 0.75], [1, 0.25]],
    shrubPalette: 1, shrubDensity: 0.5, floraPalette: 1
  },
  {
    name: "australia",
    cx: -2090, cz: 2630, r: 110,
    treeDensity: 0.26,
    species: [[6, 0.75], [2, 0.25]],
    shrubPalette: 3, shrubDensity: 0.4, floraPalette: 0
  },
  {
    name: "mediterranean",
    cx: -2300, cz: 2650, r: 105,
    treeDensity: 0.22,
    species: [[7, 0.5], [2, 0.3], [6, 0.2]],
    shrubPalette: 4, shrubDensity: 0.4, floraPalette: 0
  },
  {
    name: "california_native",
    cx: -2500, cz: 2620, r: 120,
    treeDensity: 0.26,
    species: [[4, 0.6], [2, 0.4]],
    shrubPalette: 5, shrubDensity: 0.45, floraPalette: 2
  },
  {
    name: "cloud_forest",
    cx: -2540, cz: 2460, r: 95,
    treeDensity: 0.3,
    species: [[3, 0.4], [4, 0.3], [1, 0.3]],
    shrubPalette: 1, shrubDensity: 0.5, floraPalette: 1
  }
] as const;

const FALLBACK_ZONE: GardenZone = {
  name: "mixed_collections",
  cx: 0, cz: 0, r: 1,
  treeDensity: 0.18,
  species: [[1, 0.3], [4, 0.25], [2, 0.25], [5, 0.2]],
  shrubPalette: 0, shrubDensity: 0.35, floraPalette: 0
};

/** Zone lookup with noise-warped borders. Deterministic. */
export function gardenZoneAt(x: number, z: number): GardenZone {
  const warp = (valueNoise(x, z, 60, 401) - 0.5) * 0.5;
  let best = FALLBACK_ZONE;
  let bestScore = 1.12 + warp; // beyond ~zone radius → mixed collections
  for (const zone of GARDEN_ZONES) {
    const score = Math.hypot(x - zone.cx, z - zone.cz) / zone.r + warp;
    if (score < bestScore) {
      best = zone;
      bestScore = score;
    }
  }
  return best;
}

function pickWeighted(table: readonly (readonly [number, number])[], r: number): number {
  let total = 0;
  for (const [, w] of table) total += w;
  let acc = 0;
  for (const [id, w] of table) {
    acc += w / total;
    if (r <= acc) return id;
  }
  return table[table.length - 1][0];
}

/** Clumping mask: low-frequency clearings and thickets instead of even spread. */
function clumpMask(x: number, z: number): number {
  const n = valueNoise(x, z, 52, 907);
  return 0.3 + 1.1 * smoothstep(0.32, 0.78, n);
}

// --- placement -----------------------------------------------------------------

export type GardenTree = {
  x: number;
  y: number;
  z: number;
  scale: number;
  yaw: number;
  species: number;
  nearClone?: boolean;
};

export type GardenShrub = {
  x: number;
  y: number;
  z: number;
  scale: number;
  yaw: number;
  /** shrub colour palette id (see gardenVegetation.ts) */
  palette: number;
  /** 0..1 hash driving in-palette colour choice */
  tint: number;
};

export type GardenFlora = {
  x: number;
  y: number;
  z: number;
  scale: number;
  yaw: number;
  /** flora palette id (see gardenVegetation.ts) */
  palette: number;
  tint: number;
};

const TREE_CELL = 7.5;
const SHRUB_CELL = 10;
const FLORA_CELL = 4;
const MEADOW_SHADE_TREE_COUNT = 56;
const MEADOW_SHADE_SPECIES = [
  [4, 0.42], // coast live oak
  [2, 0.3], // monterey cypress
  [5, 0.12], // japanese maple
  [6, 0.09], // eucalyptus
  [0, 0.07] // coast redwood
] as const;
const MEADOW_SHADE_AVOID = [
  { x: GARDEN_MEADOW.x, z: GARDEN_MEADOW.z, r: 44 },
  { x: GARDEN_MEADOW.x + 24, z: GARDEN_MEADOW.z + 24, r: 30 },
  { x: GARDEN_MEADOW.x + 60, z: GARDEN_MEADOW.z + 60, r: 34 }
] as const;

function placeable(map: GardenTerrain, x: number, z: number): boolean {
  return inBotanicalGarden(x, z) && !inJapaneseTeaGarden(x, z, 5) && map.surfaceType(x, z) === 1 && !map.isWater(x, z);
}

function appendMeadowShadeTrees(map: GardenTerrain, trees: GardenTree[]) {
  let added = 0;
  for (let i = 0; added < MEADOW_SHADE_TREE_COUNT && i < MEADOW_SHADE_TREE_COUNT * 7; i++) {
    const angle = i * 2.399963229728653 + (gardenHash(i, 0, 557) - 0.5) * 0.55;
    const ring = 0.38 + gardenHash(i, 0, 563) * 0.36;
    const px = GARDEN_MEADOW.x + Math.cos(angle) * GARDEN_MEADOW.rx * ring;
    const pz = GARDEN_MEADOW.z + Math.sin(angle) * GARDEN_MEADOW.rz * ring;
    if (!placeable(map, px, pz)) continue;
    if (gardenPathSignedDistance(px, pz) < 2.4) continue;
    if (MEADOW_SHADE_AVOID.some((a) => Math.hypot(px - a.x, pz - a.z) < a.r)) continue;
    if (trees.some((t) => Math.hypot(px - t.x, pz - t.z) < 8.5)) continue;

    const species = pickWeighted(MEADOW_SHADE_SPECIES, gardenHash(i, 0, 571));
    const sp = GARDEN_SPECIES[species];
    const scale = sp.sMin + gardenHash(i, 0, 577) * (sp.sMax - sp.sMin);
    trees.push({
      x: px,
      y: gardenSurfaceHeight(map, px, pz),
      z: pz,
      scale: scale * (1.12 + gardenHash(i, 0, 587) * 0.24),
      yaw: gardenHash(i, 0, 593) * Math.PI * 2,
      species,
      nearClone: false
    });
    added++;
  }
}

export function collectGardenTrees(map: GardenTerrain): GardenTree[] {
  const trees: GardenTree[] = [];
  const b = BOTANICAL_GARDEN_BOUNDS;
  let gx = 0;
  for (let x = b.minX; x <= b.maxX; x += TREE_CELL, gx++) {
    let gz = 0;
    for (let z = b.minZ; z <= b.maxZ; z += TREE_CELL, gz++) {
      // full-cell jitter so no row/column structure survives
      const px = x + gardenHash(gx, gz, 211) * TREE_CELL;
      const pz = z + gardenHash(gx, gz, 223) * TREE_CELL;
      if (!placeable(map, px, pz)) continue;
      if (gardenPathSignedDistance(px, pz) < 2.2) continue; // keep paths walkable
      const zone = gardenZoneAt(px, pz);
      const e = meadowEllipse(px, pz);
      if (e < 1.02) continue; // open meadow stays open
      let keep = zone.treeDensity * clumpMask(px, pz);
      if (e < 1.3) keep *= 0.12; // sparse specimen ring around the lawn
      if (gardenHash(gx, gz, 227) > keep) continue;
      const species = pickWeighted(zone.species, gardenHash(gx, gz, 241));
      const sp = GARDEN_SPECIES[species];
      trees.push({
        x: px,
        y: gardenSurfaceHeight(map, px, pz),
        z: pz,
        scale: sp.sMin + gardenHash(gx, gz, 233) * (sp.sMax - sp.sMin),
        yaw: gardenHash(gx, gz, 239) * Math.PI * 2,
        species
      });
    }
  }
  appendMeadowShadeTrees(map, trees);
  return trees;
}

/**
 * Shrub understory (rhododendron/camellia/protea beds by zone). Visual only —
 * NO colliders, so agents pass through; never affects host physics.
 */
export function collectGardenShrubs(map: GardenTerrain): GardenShrub[] {
  const shrubs: GardenShrub[] = [];
  const b = BOTANICAL_GARDEN_BOUNDS;
  let gx = 0;
  for (let x = b.minX; x <= b.maxX; x += SHRUB_CELL, gx++) {
    let gz = 0;
    for (let z = b.minZ; z <= b.maxZ; z += SHRUB_CELL, gz++) {
      const px = x + gardenHash(gx, gz, 307) * SHRUB_CELL;
      const pz = z + gardenHash(gx, gz, 311) * SHRUB_CELL;
      if (!placeable(map, px, pz)) continue;
      const sd = gardenPathSignedDistance(px, pz);
      if (sd < 1.1) continue;
      if (meadowEllipse(px, pz) < 1.04) continue;
      const zone = gardenZoneAt(px, pz);
      const r = gardenHash(gx, gz, 313);
      // border planting hugs the paths; clumped fill elsewhere
      const keep = sd < 7 ? zone.shrubDensity : zone.shrubDensity * 0.3 * clumpMask(px, pz);
      if (r > keep) continue;
      shrubs.push({
        x: px,
        y: gardenSurfaceHeight(map, px, pz),
        z: pz,
        scale: 0.7 + gardenHash(gx, gz, 317) * 0.8,
        yaw: gardenHash(gx, gz, 331) * Math.PI * 2,
        palette: zone.shrubPalette,
        tint: gardenHash(gx, gz, 337)
      });
    }
  }
  return shrubs;
}

/**
 * Ground flora (grass tufts, fern floor, poppies, flower beds by zone).
 * Visual dressing only — NO colliders, no BVH.
 */
export function collectGardenFlora(map: GardenTerrain): GardenFlora[] {
  const flora: GardenFlora[] = [];
  const b = BOTANICAL_GARDEN_BOUNDS;
  let gx = 0;
  for (let x = b.minX; x <= b.maxX; x += FLORA_CELL, gx++) {
    let gz = 0;
    for (let z = b.minZ; z <= b.maxZ; z += FLORA_CELL, gz++) {
      const px = x + gardenHash(gx, gz, 421) * FLORA_CELL;
      const pz = z + gardenHash(gx, gz, 431) * FLORA_CELL;
      if (!placeable(map, px, pz)) continue;
      const sd = gardenPathSignedDistance(px, pz);
      if (sd < 0.5) continue;
      const zone = gardenZoneAt(px, pz);
      const inMeadow = meadowEllipse(px, pz) < 1.02;
      // flower beds line the walks, meadow gets light tufts, zones get their floor
      let keep: number;
      if (sd < 5) keep = 0.5;
      else if (inMeadow) keep = 0.18;
      else keep = 0.24 * clumpMask(px, pz);
      if (gardenHash(gx, gz, 433) > keep) continue;
      flora.push({
        x: px,
        y: gardenSurfaceHeight(map, px, pz),
        z: pz,
        scale: 0.35 + gardenHash(gx, gz, 439) * 0.45,
        yaw: gardenHash(gx, gz, 443) * Math.PI * 2,
        palette: inMeadow ? 0 : sd < 5 ? 3 : zone.floraPalette,
        tint: gardenHash(gx, gz, 449)
      });
    }
  }
  return flora;
}

// --- colliders + BVH proxy -------------------------------------------------------

export function buildGardenTreeColliders(trees: GardenTree[]): GardenCollider[] {
  return trees.map((t) => {
    const sp = GARDEN_SPECIES[t.species];
    const hy = sp.trunkH * 0.5 * t.scale;
    return {
      x: t.x,
      y: t.y + hy,
      z: t.z,
      hx: sp.trunkR * t.scale,
      hy,
      hz: sp.trunkR * t.scale,
      yaw: t.yaw,
      friction: 0.7,
      label: `sfbg_${sp.name}_trunk`
    };
  });
}

/** Raycast proxy: trunk box + canopy cone per tree, mirrors the collider dims. */
export function buildGardenProxyBuffers(trees: GardenTree[]): GeometryBuffers {
  const buf: GeometryBuffers = { positions: [], indices: [] };
  for (const t of trees) {
    const sp = GARDEN_SPECIES[t.species];
    const trunkH = sp.trunkH * t.scale;
    appendBox(buf, t.x, t.y + trunkH * 0.5, t.z, sp.trunkR * t.scale, trunkH * 0.5, sp.trunkR * t.scale, t.yaw);
    appendCone(buf, t.x, t.y + trunkH + sp.canopyH * 0.5 * t.scale, t.z, sp.canopyR * t.scale, sp.canopyH * t.scale, t.yaw, 6);
  }
  return buf;
}

// --- geometry buffer helpers (runtime-agnostic, no THREE) ------------------------

function transformPoint(x: number, y: number, z: number, cx: number, cy: number, cz: number, yaw: number, out: number[]) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out[0] = cx + x * c - z * s;
  out[1] = cy + y;
  out[2] = cz + x * s + z * c;
}

export function appendBox(buf: GeometryBuffers, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw = 0) {
  const base = buf.positions.length / 3;
  const p = [0, 0, 0];
  for (const [x, y, z] of [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [hx, hy, -hz],
    [-hx, hy, -hz],
    [-hx, -hy, hz],
    [hx, -hy, hz],
    [hx, hy, hz],
    [-hx, hy, hz]
  ] as const) {
    transformPoint(x, y, z, cx, cy, cz, yaw, p);
    buf.positions.push(p[0], p[1], p[2]);
  }
  for (const i of [
    0, 1, 2, 0, 2, 3,
    1, 5, 6, 1, 6, 2,
    5, 4, 7, 5, 7, 6,
    4, 0, 3, 4, 3, 7,
    3, 2, 6, 3, 6, 7,
    4, 5, 1, 4, 1, 0
  ]) {
    buf.indices.push(base + i);
  }
}

export function appendCone(buf: GeometryBuffers, cx: number, cy: number, cz: number, radius: number, height: number, yaw = 0, segments = 8) {
  const base = buf.positions.length / 3;
  const p = [0, 0, 0];
  transformPoint(0, height * 0.5, 0, cx, cy, cz, yaw, p);
  buf.positions.push(p[0], p[1], p[2]);
  transformPoint(0, -height * 0.5, 0, cx, cy, cz, yaw, p);
  buf.positions.push(p[0], p[1], p[2]);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    transformPoint(Math.cos(a) * radius, -height * 0.5, Math.sin(a) * radius, cx, cy, cz, yaw, p);
    buf.positions.push(p[0], p[1], p[2]);
  }
  for (let i = 0; i < segments; i++) {
    const a = base + 2 + i;
    const b = base + 2 + ((i + 1) % segments);
    buf.indices.push(base, a, b);
    buf.indices.push(base + 1, b, a);
  }
}
