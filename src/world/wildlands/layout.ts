// Wildlands — designed foliage layout for Golden Gate Park, the Presidio, and
// the Marin Headlands. Pure and deterministic (no three, no host imports): the
// same hash math reconstructs identical placement anywhere, mirroring the
// botanical garden's layout discipline (src/world/garden/layout.ts).
//
// This is DESIGNED planting, not a sprinkle. The vocabulary:
//  · GROVE      — a single-species stand with gaussian density falloff and
//                 clump noise, so it reads as one intentional wood
//  · WINDROW    — trees planted along a line with regular-ish spacing (the
//                 classic GG Park cypress windbreak rows)
//  · SAVANNA    — very sparse lone trees over a whole region (golden-hill oaks)
//  · FLOWER DRIFT — an ellipse of wildflowers with NOISE BANDING, so each
//                 drift streaks like a real superbloom instead of a disc
//
// Species use the SeedThree designs staged for the botanical garden (same
// public/seedthree textures): douglasFir (redwood/fir), pine (Monterey
// cypress read), whiteOak, americanBeech (eucalyptus read).
//
// Real-geography anchors (x=(lon+122.444)*87972, z=(37.79-lat)*110574):
//  GG Park   x[-5920,-760]  z[1780,2860]
//  Presidio  x[-3035,-200]  z[-2250,180]
//  Marin     x[-6300,-2700] z[-7800,-5000]

import type { SeedTreeDesignSpec } from "../seedForest/templates";
import { BOTANICAL_GARDEN_BOUNDS, type GardenTerrain } from "../garden/layout";

export type WildRegionId = "ggpark" | "presidio" | "marin" | "twinpeaks";

export type WildRegion = {
  id: WildRegionId;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** which surface classes are plantable here (GG Park/Presidio lawns = 1;
   *  Marin's golden hills are class 0 open ground) */
  plantClasses: readonly number[];
  /** minimum ground height (Marin shoreline gate, matches flora.ts) */
  minGround: number;
};

export const WILD_REGIONS: readonly WildRegion[] = [
  { id: "ggpark", minX: -5920, maxX: -760, minZ: 1780, maxZ: 2860, plantClasses: [1], minGround: -Infinity },
  // Presidio's historic cypress/eucalyptus plantations sit on ground this map
  // classes as 0 (developed post), so plant on 0+1 like Marin — the designed
  // groves keep it in the wooded areas, avoid zones keep it off the anchorage.
  { id: "presidio", minX: -3035, maxX: -200, minZ: -2250, maxZ: 180, plantClasses: [0, 1], minGround: -Infinity },
  { id: "marin", minX: -6300, maxX: -2700, minZ: -7800, maxZ: -5000, plantClasses: [0, 1], minGround: 2 },
  // Central hills — Mount Sutro (dense eucalyptus cloud-forest), Mount Davidson
  // (forested), Twin Peaks (open grassy summit). plantClasses=[1] keeps the
  // canopy on the actual parkland, not the surrounding neighborhoods (class 0).
  { id: "twinpeaks", minX: -1500, maxX: 350, minZ: 3150, maxZ: 4650, plantClasses: [1], minGround: -Infinity }
] as const;

export function wildRegionAt(x: number, z: number): WildRegion | null {
  for (const r of WILD_REGIONS) {
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return r;
  }
  return null;
}

// --- keep-out zones (existing world content owns these) --------------------------

const AVOID: readonly { x: number; z: number; r: number; label: string }[] = [
  { x: -3431, z: 2322, r: 150, label: "quidditch pitch" },
  { x: -5250, z: 2380, r: 100, label: "horse platform" },
  { x: -388, z: -1426, r: 80, label: "palace of fine arts" },
  { x: -3150, z: -5100, r: 70, label: "gg bridge marin landing" },
  { x: -2900, z: -2260, r: 90, label: "gg bridge presidio anchorage" }
] as const;

function inAvoid(x: number, z: number, pad = 0): boolean {
  if (
    x >= BOTANICAL_GARDEN_BOUNDS.minX - 14 - pad &&
    x <= BOTANICAL_GARDEN_BOUNDS.maxX + 14 + pad &&
    z >= BOTANICAL_GARDEN_BOUNDS.minZ - 14 - pad &&
    z <= BOTANICAL_GARDEN_BOUNDS.maxZ + 14 + pad
  ) {
    return true; // the botanical garden plants itself
  }
  for (const a of AVOID) {
    if (Math.hypot(x - a.x, z - a.z) < a.r + pad) return true;
  }
  return false;
}

// --- deterministic noise (same recipe as the garden) ------------------------------

function hash2(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number, cell: number, salt: number): number {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const ax = fx - ix;
  const az = fz - iz;
  const sx = ax * ax * (3 - 2 * ax);
  const sz = az * az * (3 - 2 * az);
  const n00 = hash2(ix, iz, salt);
  const n10 = hash2(ix + 1, iz, salt);
  const n01 = hash2(ix, iz + 1, salt);
  const n11 = hash2(ix + 1, iz + 1, salt);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sz) + (n01 * (1 - sx) + n11 * sx) * sz;
}

function smoothstep(a: number, b: number, t: number): number {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

// --- tree species (indices into WILD_TREE_DESIGNS) --------------------------------

// Fuller + shorter than a first pass: the far tier renders LOD2, which keeps the
// trunk but thins the foliage cards, so tall trees read as bare poles at range.
// High leavesPerBranch/branchDensity + lower heights + a low baseSize (crown
// clothes more of the trunk) fatten the far-tier silhouette into real canopy.
export const WILD_TREE_DESIGNS: readonly SeedTreeDesignSpec[] = [
  // 0 redwood/fir — valley forests and grove hearts. Fullness balanced against
  // far-tier triangle cost: enough leaf density to kill the bare-pole read, not
  // so much that a compact dense stand blows the GPU budget.
  {
    species: "douglasFir",
    seed: 911,
    // firs are the poliest + costliest at the far tier — keep them shorter and
    // the fullest of the four so a distant grove still reads as canopy not masts
    controls: { height: 18, branchDensity: 46, leavesPerBranch: 36, leafColorize: 0x44603a, leafTintAmount: 0.44 },
    sink: 0.3
  },
  // 1 Monterey cypress read — windrows and crest stands, fat rounded crown
  {
    species: "pine",
    seed: 922,
    controls: { height: 11, branchDensity: 40, leavesPerBranch: 26, leafColorize: 0x3e5c33, leafTintAmount: 0.46 },
    sink: 0.28
  },
  // 2 coast live oak — savanna loners and east-park woodland, broad round head
  {
    species: "whiteOak",
    seed: 933,
    controls: { height: 9.5, branchDensity: 32, leavesPerBranch: 26, leafColorize: 0x4d6a34, leafTintAmount: 0.5 },
    sink: 0.26
  },
  // 3 eucalyptus read — tall pale stands, but not a flagpole
  {
    species: "americanBeech",
    seed: 944,
    controls: { height: 15, branchDensity: 34, leavesPerBranch: 26, leafColorize: 0x5c6e40, leafTintAmount: 0.5 },
    sink: 0.28
  }
] as const;

export const WILD_SPECIES = { redwood: 0, cypress: 1, oak: 2, eucalyptus: 3 } as const;

// per-species instance scale range (multiplies the SeedThree hero)
const SPECIES_SCALE: readonly [number, number][] = [
  [0.95, 1.5],
  [0.85, 1.25],
  [0.85, 1.25],
  [0.9, 1.35]
];

// --- designed content --------------------------------------------------------------

type Grove = { name: string; species: number; cx: number; cz: number; r: number; density: number };
type Windrow = { name: string; species: number; ax: number; az: number; bx: number; bz: number; spacing: number; jitter: number };
type Savanna = { name: string; species: number; region: WildRegionId; density: number };

const GROVES: readonly Grove[] = [
  // Golden Gate Park — west→east procession
  { name: "ggp_cypress_ocean_n", species: 1, cx: -5720, cz: 2080, r: 150, density: 0.2 },
  { name: "ggp_cypress_ocean_s", species: 1, cx: -5740, cz: 2600, r: 140, density: 0.2 },
  { name: "ggp_eucalyptus_west", species: 3, cx: -5060, cz: 2620, r: 150, density: 0.18 },
  { name: "ggp_redwood_dell", species: 0, cx: -4600, cz: 2080, r: 210, density: 0.22 },
  { name: "ggp_eucalyptus_mid", species: 3, cx: -2950, cz: 1970, r: 130, density: 0.18 },
  { name: "ggp_oak_knoll", species: 2, cx: -1350, cz: 2620, r: 120, density: 0.14 },

  // Presidio — plantation forest on the ridge, open toward the bay
  { name: "psd_cypress_ridge_w", species: 1, cx: -2520, cz: -1240, r: 170, density: 0.2 },
  { name: "psd_cypress_ridge_e", species: 1, cx: -1820, cz: -1520, r: 150, density: 0.19 },
  { name: "psd_fir_stand", species: 0, cx: -1320, cz: -1230, r: 120, density: 0.2 },
  { name: "psd_eucalyptus_w", species: 3, cx: -2360, cz: -700, r: 170, density: 0.19 },
  { name: "psd_eucalyptus_e", species: 3, cx: -950, cz: -520, r: 130, density: 0.18 },

  // Marin — valley forests and crest stands over golden hills
  { name: "mrn_redwood_valley_w", species: 0, cx: -5300, cz: -6200, r: 260, density: 0.22 },
  { name: "mrn_redwood_valley_s", species: 0, cx: -4300, cz: -7000, r: 240, density: 0.22 },
  { name: "mrn_redwood_valley_e", species: 0, cx: -3500, cz: -5600, r: 200, density: 0.2 },
  { name: "mrn_redwood_valley_sw", species: 0, cx: -5900, cz: -7300, r: 200, density: 0.22 },
  { name: "mrn_pine_crest_n", species: 1, cx: -4800, cz: -5400, r: 150, density: 0.15 },
  { name: "mrn_pine_crest_e", species: 1, cx: -3100, cz: -6600, r: 140, density: 0.15 },

  // Central hills — Mount Sutro cloud-forest (dense eucalyptus) + Mount Davidson
  { name: "sutro_cloud_forest", species: 3, cx: -782, cz: 3846, r: 205, density: 0.2 },
  { name: "sutro_fir_pocket", species: 0, cx: -1080, cz: 4160, r: 110, density: 0.16 },
  { name: "mount_davidson", species: 3, cx: -320, cz: 4330, r: 170, density: 0.18 }
] as const;

const WINDROWS: readonly Windrow[] = [
  // the classic GG Park south-edge cypress windbreak, one long jittered row
  { name: "ggp_windrow_south", species: 1, ax: -5150, az: 2810, bx: -1250, bz: 2825, spacing: 27, jitter: 7 },
  // short Presidio row above Crissy meadow
  { name: "psd_windrow_crissy", species: 1, ax: -2450, az: -1700, bx: -900, bz: -1660, spacing: 30, jitter: 8 }
] as const;

const SAVANNAS: readonly Savanna[] = [
  { name: "ggp_oak_savanna_east", species: 2, region: "ggpark", density: 0.035 }, // east half gate below
  { name: "psd_oak_south_rim", species: 2, region: "presidio", density: 0.02 },
  { name: "mrn_lone_oaks", species: 2, region: "marin", density: 0.011 } // the classic golden-hill loners
] as const;

// savanna sub-gates: which part of the region each savanna covers
function savannaGate(s: Savanna, x: number, z: number): boolean {
  switch (s.name) {
    case "ggp_oak_savanna_east":
      return x > -1900; // east park only
    case "psd_oak_south_rim":
      return z > -450; // southern rim toward the city
    default:
      return true;
  }
}

// --- flowers -----------------------------------------------------------------------

/** Flower species ids (geometry + palette live in flowerField.ts). */
export const FLOWER_SPECIES = { poppy: 0, lupine: 1, yarrow: 2, goldfield: 3 } as const;

export type FlowerDrift = {
  name: string;
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  /** [flowerSpecies, weight] mix inside the drift */
  mix: readonly (readonly [number, number])[];
  /** peak keep probability at drift centre (per 2.4 m cell) */
  density: number;
  /** noise-band cell size (m) — smaller = tighter streaks */
  bandCell: number;
};

export const FLOWER_DRIFTS: readonly FlowerDrift[] = [
  // Golden Gate Park — meadows between the groves
  { name: "ggp_poppy_meadow", cx: -4000, cz: 2440, rx: 175, rz: 120, mix: [[0, 0.7], [3, 0.3]], density: 0.6, bandCell: 22 },
  { name: "ggp_lupine_walk", cx: -2725, cz: 2540, rx: 110, rz: 80, mix: [[1, 0.62], [2, 0.38]], density: 0.55, bandCell: 18 },
  { name: "ggp_dunes_poppies", cx: -5540, cz: 2330, rx: 110, rz: 90, mix: [[0, 0.55], [3, 0.45]], density: 0.5, bandCell: 16 },
  { name: "ggp_east_goldfields", cx: -1250, cz: 2320, rx: 140, rz: 100, mix: [[3, 0.6], [2, 0.4]], density: 0.5, bandCell: 20 },

  // Presidio — Crissy Field coastal meadow band + an inland clearing
  { name: "psd_crissy_meadow", cx: -1500, cz: -1960, rx: 850, rz: 190, mix: [[1, 0.45], [0, 0.3], [2, 0.25]], density: 0.42, bandCell: 26 },
  { name: "psd_clearing", cx: -1720, cz: -930, rx: 130, rz: 100, mix: [[3, 0.5], [0, 0.5]], density: 0.5, bandCell: 18 },

  // Marin — the superbloom: giant poppy washes on the OPEN west-central
  // headland hills (the SE of the region is built up; keep the blooms on the
  // real open grassland between the redwood valleys).
  { name: "mrn_poppy_hills", cx: -4450, cz: -6250, rx: 285, rz: 215, mix: [[0, 0.74], [3, 0.26]], density: 0.85, bandCell: 34 },
  { name: "mrn_poppy_north", cx: -5180, cz: -5730, rx: 220, rz: 165, mix: [[0, 0.7], [3, 0.3]], density: 0.78, bandCell: 30 },
  { name: "mrn_poppy_south", cx: -4980, cz: -6820, rx: 225, rz: 170, mix: [[0, 0.74], [3, 0.26]], density: 0.78, bandCell: 32 },
  { name: "mrn_lupine_hills", cx: -4060, cz: -5900, rx: 200, rz: 150, mix: [[1, 0.6], [2, 0.2], [0, 0.2]], density: 0.62, bandCell: 26 },
  { name: "mrn_goldfield_west", cx: -5650, cz: -6450, rx: 190, rz: 150, mix: [[3, 0.6], [0, 0.4]], density: 0.6, bandCell: 24 },

  // Central hills — wildflowers on the open Mount Sutro / Twin Peaks slopes
  { name: "tp_wildflowers", cx: -560, cz: 4060, rx: 165, rz: 135, mix: [[1, 0.5], [2, 0.3], [0, 0.2]], density: 0.5, bandCell: 24 }
] as const;

function driftEllipse(d: FlowerDrift, x: number, z: number): number {
  const dx = (x - d.cx) / d.rx;
  const dz = (z - d.cz) / d.rz;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Trees keep out of flower meadows — the drifts ARE the clearings. */
function inFlowerMeadow(x: number, z: number, pad = 0.15): boolean {
  for (const d of FLOWER_DRIFTS) {
    if (driftEllipse(d, x, z) < 1 + pad) return true;
  }
  return false;
}

// --- open meadows (kept clear of trees; the big GG Park / post lawns) --------------

type Meadow = { name: string; cx: number; cz: number; rx: number; rz: number };
const MEADOWS: readonly Meadow[] = [
  { name: "polo_fields", cx: -5000, cz: 2500, rx: 215, rz: 95 },
  { name: "speedway_hellman", cx: -3760, cz: 2250, rx: 185, rz: 105 },
  { name: "lindley_marx", cx: -4330, cz: 2410, rx: 150, rz: 95 },
  { name: "big_rec_east", cx: -1520, cz: 2470, rx: 150, rz: 100 },
  { name: "presidio_parade", cx: -1680, cz: -1050, rx: 165, rz: 115 }
] as const;

function inMeadow(x: number, z: number): boolean {
  for (const m of MEADOWS) {
    const dx = (x - m.cx) / m.rx;
    const dz = (z - m.cz) / m.rz;
    if (dx * dx + dz * dz < 1) return true;
  }
  return false;
}

// --- forest matrix (region-wide canopy with clearings) ----------------------------
// GG Park and the Presidio are continuous urban forest, not a few groves. The
// matrix plants wherever a low-frequency "stand" noise says wood (dense stands,
// feathered edges, open clearings between), with species from a second low-freq
// zone noise so neighbours share a species — real stands, not salt-and-pepper.
// Marin has NO matrix: it stays open golden hills (groves + lone oaks only).

type MatrixSpec = { density: number; standThresh: number; species: (zone: number, x: number) => number };
const MATRIX: Partial<Record<WildRegionId, MatrixSpec>> = {
  ggpark: {
    density: 0.46,
    standThresh: 0.57,
    // east park (x>-1750) leans oak/eucalyptus; the long body is eucalyptus →
    // cypress → redwood pockets. Fir kept a minority (poliest far-tier species).
    species: (zone, x) => (x > -1750 ? (zone < 0.5 ? 2 : 3) : zone < 0.42 ? 3 : zone < 0.8 ? 1 : 0)
  },
  presidio: {
    density: 0.4,
    standThresh: 0.6, // wooded hills, but the post + Crissy stay open (compact region — keep GPU sane)
    species: (zone) => (zone < 0.48 ? 1 : zone < 0.82 ? 3 : 0) // cypress / eucalyptus / fir
  },
  twinpeaks: {
    // compact region + eucalyptus (costliest far-tier species) → keep it lean;
    // the groves carry the dense-cloud-forest read, the matrix just fills between
    density: 0.4,
    standThresh: 0.6,
    species: (zone) => (zone < 0.46 ? 3 : zone < 0.86 ? 1 : 0) // euc / cypress-leaning / fir
  }
};
const MATRIX_CELL = 11;

// --- terrain gates -----------------------------------------------------------------

function slopeOk(map: GardenTerrain, x: number, z: number, maxDelta: number): boolean {
  const d1 = Math.abs(map.groundHeight(x + 6, z) - map.groundHeight(x - 6, z));
  if (d1 > maxDelta) return false;
  const d2 = Math.abs(map.groundHeight(x, z + 6) - map.groundHeight(x, z - 6));
  return d2 <= maxDelta;
}

function plantable(map: GardenTerrain, region: WildRegion, x: number, z: number): boolean {
  if (x < region.minX || x > region.maxX || z < region.minZ || z > region.maxZ) return false;
  if (map.isWater(x, z)) return false;
  if (!region.plantClasses.includes(map.surfaceType(x, z))) return false;
  if (map.groundHeight(x, z) < region.minGround) return false;
  return !inAvoid(x, z);
}

// --- suppression exports (old simple trees die inside the wildlands) ----------------

/**
 * True where the old stylized tree systems (flora.ts park scatter + Marin
 * pools, forest.ts redwoods) must NOT plant trees — the wildlands owns all
 * trees in its three regions. Bushes/grass/ground cover stay.
 */
export function wildlandsSuppressesTree(x: number, z: number): boolean {
  return wildRegionAt(x, z) !== null;
}

// --- collectors ----------------------------------------------------------------------

export type WildTree = { x: number; y: number; z: number; yaw: number; scale: number; design: number };
export type WildFlower = { x: number; y: number; z: number; yaw: number; scale: number; species: number; tint: number };

const TREE_CELL = 8;
const TREE_MIN_SPACING = 5.5;
const FLOWER_CELL = 2.4;

export function collectWildTrees(map: GardenTerrain): WildTree[] {
  const trees: WildTree[] = [];
  // spatial hash for min spacing across overlapping features
  const taken = new Set<string>();
  const takenKey = (x: number, z: number) => `${Math.round(x / TREE_MIN_SPACING)}:${Math.round(z / TREE_MIN_SPACING)}`;

  const push = (x: number, z: number, species: number, sBoost: number, salt: number, gx: number, gz: number) => {
    const region = wildRegionAt(x, z);
    if (!region || !plantable(map, region, x, z)) return false;
    if (inFlowerMeadow(x, z) || inMeadow(x, z)) return false;
    if (!slopeOk(map, x, z, 8.5)) return false;
    const k = takenKey(x, z);
    if (taken.has(k)) return false;
    taken.add(k);
    const [sMin, sMax] = SPECIES_SCALE[species];
    trees.push({
      x,
      y: map.groundHeight(x, z),
      z,
      yaw: hash2(gx, gz, salt + 7) * Math.PI * 2,
      scale: (sMin + hash2(gx, gz, salt + 13) * (sMax - sMin)) * sBoost,
      design: species
    });
    return true;
  };

  // GROVES — gaussian falloff × clump noise, denser hearts, feathered edges
  GROVES.forEach((g, gi) => {
    const salt = 1000 + gi * 37;
    const cells = Math.ceil((g.r * 2) / TREE_CELL);
    for (let iz = 0; iz <= cells; iz++) {
      for (let ix = 0; ix <= cells; ix++) {
        const px = g.cx - g.r + ix * TREE_CELL + (hash2(ix, iz, salt) - 0.5) * TREE_CELL * 0.9;
        const pz = g.cz - g.r + iz * TREE_CELL + (hash2(ix, iz, salt + 1) - 0.5) * TREE_CELL * 0.9;
        const dn = Math.hypot(px - g.cx, pz - g.cz) / g.r;
        if (dn > 1) continue;
        const falloff = Math.exp(-dn * dn * 2.1); // gaussian heart
        const clump = 0.35 + 1.05 * smoothstep(0.3, 0.75, valueNoise(px, pz, 46, salt + 2));
        if (hash2(ix, iz, salt + 3) > g.density * falloff * clump) continue;
        // grove hearts grow the elders — subtle but reads as age structure
        push(px, pz, g.species, 1 + (1 - dn) * 0.22, salt, ix, iz);
      }
    }
  });

  // WINDROWS — evenly spaced with jitter; skips gaps where terrain refuses
  WINDROWS.forEach((w, wi) => {
    const salt = 4000 + wi * 41;
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    const n = Math.floor(len / w.spacing);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = w.ax + (w.bx - w.ax) * t + (hash2(i, 0, salt) - 0.5) * w.jitter;
      const pz = w.az + (w.bz - w.az) * t + (hash2(i, 1, salt) - 0.5) * w.jitter;
      if (hash2(i, 2, salt) < 0.12) continue; // the odd missing tree keeps it alive
      push(px, pz, w.species, 0.95 + hash2(i, 3, salt) * 0.25, salt, i, 0);
    }
  });

  // FOREST MATRIX — region-wide canopy (GG Park + Presidio). Dense stands where
  // the low-freq stand-noise says wood, feathered edges, open clearings between.
  WILD_REGIONS.forEach((region) => {
    const spec = MATRIX[region.id];
    if (!spec) return; // Marin: no matrix, stays open
    const salt = 6000 + region.id.length * 17;
    let gx = 0;
    for (let x = region.minX; x <= region.maxX; x += MATRIX_CELL, gx++) {
      let gz = 0;
      for (let z = region.minZ; z <= region.maxZ; z += MATRIX_CELL, gz++) {
        const px = x + (hash2(gx, gz, salt) - 0.5) * MATRIX_CELL * 1.4;
        const pz = z + (hash2(gx, gz, salt + 1) - 0.5) * MATRIX_CELL * 1.4;
        // stand mask: smooth so stands have dense hearts + feathered edges
        const stand = smoothstep(spec.standThresh - 0.05, spec.standThresh + 0.12, valueNoise(px, pz, 300, salt + 2));
        if (stand <= 0) continue;
        if (hash2(gx, gz, salt + 3) > spec.density * stand) continue;
        const zone = valueNoise(px, pz, 240, salt + 4);
        push(px, pz, spec.species(zone, px), 1 + hash2(gx, gz, salt + 5) * 0.12, salt, gx, gz);
      }
    }
  });

  // SAVANNAS — rare loners over the whole region, clump-noise gated so pairs
  // and small families happen
  SAVANNAS.forEach((s, si) => {
    const salt = 7000 + si * 53;
    const region = WILD_REGIONS.find((r) => r.id === s.region)!;
    const cell = 26;
    let gx = 0;
    for (let x = region.minX; x <= region.maxX; x += cell, gx++) {
      let gz = 0;
      for (let z = region.minZ; z <= region.maxZ; z += cell, gz++) {
        const px = x + hash2(gx, gz, salt) * cell;
        const pz = z + hash2(gx, gz, salt + 1) * cell;
        if (!savannaGate(s, px, pz)) continue;
        const clump = 0.25 + 1.3 * smoothstep(0.45, 0.85, valueNoise(px, pz, 90, salt + 2));
        if (hash2(gx, gz, salt + 3) > s.density * clump) continue;
        push(px, pz, s.species, 1.05 + hash2(gx, gz, salt + 4) * 0.3, salt, gx, gz);
      }
    }
  });

  return trees;
}

export function collectWildFlowers(map: GardenTerrain): WildFlower[] {
  const flowers: WildFlower[] = [];
  FLOWER_DRIFTS.forEach((d, di) => {
    const salt = 9000 + di * 61;
    // walk only the drift's bbox, not the whole region
    const x0 = d.cx - d.rx;
    const z0 = d.cz - d.rz;
    const nx = Math.ceil((d.rx * 2) / FLOWER_CELL);
    const nz = Math.ceil((d.rz * 2) / FLOWER_CELL);
    // cumulative mix table
    let total = 0;
    for (const [, w] of d.mix) total += w;
    for (let iz = 0; iz <= nz; iz++) {
      for (let ix = 0; ix <= nx; ix++) {
        const px = x0 + ix * FLOWER_CELL + (hash2(ix, iz, salt) - 0.5) * FLOWER_CELL;
        const pz = z0 + iz * FLOWER_CELL + (hash2(ix, iz, salt + 1) - 0.5) * FLOWER_CELL;
        const e = driftEllipse(d, px, pz);
        if (e > 1) continue;
        const region = wildRegionAt(px, pz);
        if (!region || !plantable(map, region, px, pz)) continue;
        if (!slopeOk(map, px, pz, 7)) continue;
        // NOISE BANDING — the drift streaks: two scales of value noise carve
        // ribbons through the ellipse; edge feather keeps the rim soft
        const band =
          smoothstep(0.34, 0.62, valueNoise(px, pz, d.bandCell, salt + 2)) *
          (0.55 + 0.45 * smoothstep(0.3, 0.7, valueNoise(px, pz, d.bandCell * 3.7, salt + 3)));
        const feather = 1 - smoothstep(0.72, 1, e);
        const keep = d.density * band * feather;
        if (hash2(ix, iz, salt + 4) > keep) continue;
        // pick species from the mix
        const r = hash2(ix, iz, salt + 5) * total;
        let acc = 0;
        let species = d.mix[d.mix.length - 1][0];
        for (const [id, w] of d.mix) {
          acc += w;
          if (r <= acc) {
            species = id;
            break;
          }
        }
        flowers.push({
          x: px,
          y: map.groundHeight(px, pz),
          z: pz,
          yaw: hash2(ix, iz, salt + 6) * Math.PI * 2,
          scale: 0.85 + hash2(ix, iz, salt + 7) * 0.6, // a touch bigger so drifts read from range
          species,
          tint: hash2(ix, iz, salt + 8)
        });
      }
    }
  });
  return flowers;
}
