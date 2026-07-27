#!/usr/bin/env node

// Seamless timber for the Sutro hall's inland gallery wall: one grain tile plus
// its derived normal, published as WebP under public/sutro/timber/.
//
//   node tools/build-sutro-hall-textures.mjs [--preview]
//
// WHY ONE NEUTRAL TILE
// The wall mixes two woods — a dark grounding timber low down and warm
// mid-century boards above — but it does NOT ship two texture sets. The tile is
// authored at a neutral mid tone with real grain contrast, and the runtime
// multiplies a per-board colour into it (timberGallery.ts writes one tint per
// board into the merged geometry's vertex colours). That gives every board its
// own tone from one 1024² pair, keeps the whole cladding in a single draw
// submission, and costs ~8 MB of VRAM instead of ~16.
//
// SEAMLESS BY CONSTRUCTION
// Every noise lattice below wraps on an integer cell count and the ring
// frequency is a whole number of rings per tile, so the tile matches itself on
// both axes without the mirror-and-crop trick the drum-bridge sources need
// (that one starts from a painted plate; this one is generated).
//
// Grain runs along +U. Vertical slats reuse the same tile with U and V swapped
// when their UVs are written, so one tile serves boards in both directions.
//
// KTX2: tools/optimize-textures.mjs needs `toktx`, which is not installed here,
// so this publishes WebP only and the runtime loads it with { webpOnly: true }.
// Re-run without --webp-only on a machine with the KTX-Software tools to add the
// GPU-compressed sibling; nothing in the runtime changes.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGING = path.join(ROOT, ".data/sutro-hall-textures");
const COLOR_STAGING = path.join(STAGING, "color");
const NORMAL_STAGING = path.join(STAGING, "normal");
const OUTPUT = path.join(ROOT, "public/sutro/timber");
const OPTIMIZER = path.join(ROOT, "tools/optimize-textures.mjs");

const SIZE = 1024;
/**
 * Metres of wall covered by one tile. Mirrored by TIMBER_TILE_M in
 * src/world/sutroBaths/timberGallery.ts — change both together.
 *
 * Sized by the grain, not by convenience. Growth lines in the walnut and teak
 * this wall is imitating sit 10-25 mm apart, so a tile that covered 2.4 m gave
 * each ring four pixels: at that density the tile came out as corduroy and
 * shimmered at any distance. At 1.5 m a ring is ~12 px, a 0.3 m board carries
 * ~17 rings, and the pattern repeats along a board's length every 1.5 m — which
 * the per-board UV jitter in timberGallery.ts then hides.
 */
const TILE_METRES = 1.5;
/** Whole rings per tile keeps the ring stripes seamless across the V wrap. */
const RINGS_PER_TILE = 84;

// ---------------------------------------------------------------------------
// periodic value noise
// ---------------------------------------------------------------------------

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise on a wrapping cellsX × cellsY lattice; u, v in [0, 1). */
function noise(u, v, cellsX, cellsY, seed) {
  const x = u * cellsX;
  const y = v * cellsY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = quintic(x - x0);
  const fy = quintic(y - y0);
  const xa = ((x0 % cellsX) + cellsX) % cellsX;
  const ya = ((y0 % cellsY) + cellsY) % cellsY;
  const xb = (xa + 1) % cellsX;
  const yb = (ya + 1) % cellsY;
  const n00 = hash2(xa, ya, seed);
  const n10 = hash2(xb, ya, seed);
  const n01 = hash2(xa, yb, seed);
  const n11 = hash2(xb, yb, seed);
  const top = n00 + (n10 - n00) * fx;
  const bottom = n01 + (n11 - n01) * fx;
  return top + (bottom - top) * fy;
}

/** Octave sum; each octave doubles the (integer) lattice so the wrap survives. */
function fbm(u, v, cellsX, cellsY, octaves, seed, gain = 0.5) {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave++) {
    const scale = 1 << octave;
    sum += amplitude * noise(u, v, cellsX * scale, cellsY * scale, seed + octave * 101);
    total += amplitude;
    amplitude *= gain;
  }
  return sum / total;
}

// ---------------------------------------------------------------------------
// the wood
// ---------------------------------------------------------------------------

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/**
 * Neutral mid-tone wood: earlywood body, darker latewood lines, long fibre
 * streaks along the grain, and sparse pores. Returned as {r, g, b} in 0..1
 * sRGB-ish authoring space plus the height the normal is derived from.
 *
 * Hue variation is deliberately small but not zero: latewood runs a touch
 * redder than earlywood in every real board, and losing that made the tinted
 * result read as painted MDF. The dominant tone comes from the runtime tint.
 */
function woodSample(u, v) {
  // Ring stripes run along U, built from three warps at different scales. The
  // shape of real plane-sawn figure comes almost entirely from this: a long
  // sweeping arc where the saw crossed a curved ring (the "cathedral"), a
  // medium wander so no two lines stay parallel, and a V-only term whose slope
  // varies the LOCAL ring spacing — rings bunch and open across a board, and
  // evenly spaced lines are the single biggest tell of procedural wood.
  const arc = (fbm(u, v, 2, 1, 2, 17) - 0.5) * 12.0;
  const wander = (fbm(u, v, 7, 3, 3, 41) - 0.5) * 3.4;
  const spacing = (fbm(0.5, v, 1, 5, 2, 63) - 0.5) * 9.0;
  const ring = v * RINGS_PER_TILE + arc + wander + spacing;
  const band = Math.floor(ring);
  const cycle = ring - band;

  // Latewood: a narrow dense band at the close of each ring, asymmetric like
  // the real thing. Strength AND width vary per ring: uniform lines are what
  // made the first pass read as machine-printed pine rather than walnut, and
  // the faint rings are as important as the hard ones.
  const lateStrength = 0.16 + hash2(band, 7, 991) * 0.9;
  const lateWidth = 0.16 + hash2(band, 23, 617) * 0.24;
  const late =
    smoothstep(0.88 - lateWidth, 0.88, cycle) *
    (1 - smoothstep(0.88, 0.99, cycle)) *
    lateStrength;
  // Broad light/dark zones group the rings, the way one board runs pale and the
  // next runs deep even out of the same log, plus a wider along-grain shimmer
  // for the chatoyance figured hardwood has under a raking lamp.
  const zone = fbm(u, v, 2, 3, 2, 73);
  const chatoyance = (fbm(u, v, 26, 2, 2, 401) - 0.5) * 0.13;

  // Fibre: strongly anisotropic — long streaks along the grain.
  const fibre = fbm(u, v, 190, 4, 3, 131) - 0.5;
  // Ray fleck: short dashes ACROSS the grain, sparse.
  const flecks = Math.max(0, fbm(u, v, 40, 240, 2, 211) - 0.66) * 2.6;
  // Pores: fine dark specks, earlywood only.
  const poreField = Math.max(0, fbm(u, v, 380, 96, 1, 307) - 0.79) * 4.6;
  const pores = poreField * (1 - clamp01(late));

  let value = 0.82;
  value -= clamp01(late) * 0.34;
  value -= (0.5 - zone) * 0.18;
  value += chatoyance;
  value += fibre * 0.085;
  value -= flecks * 0.055;
  value -= pores * 0.13;
  value = clamp01(value);

  // Dense late bands and pores run redder than the earlywood they sit in.
  const warmth = clamp01(late) * 0.6 + pores * 0.35;
  const r = clamp01(value * mix(1.0, 1.05, warmth));
  const g = clamp01(value * mix(0.955, 0.86, warmth));
  const b = clamp01(value * mix(0.87, 0.72, warmth));

  // Height for the normal: latewood stands slightly proud of the softer
  // earlywood on any board that has been walked past for thirty years, pores
  // sink, and the fibre gives the surface its grazing-light texture.
  const height = clamp01(
    0.5 + clamp01(late) * 0.4 + fibre * 0.34 - pores * 0.6 - flecks * 0.14
  );
  return { r, g, b, height };
}

function buildColorAndHeight() {
  const color = Buffer.alloc(SIZE * SIZE * 3);
  const height = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const v = y / SIZE;
    for (let x = 0; x < SIZE; x++) {
      const sample = woodSample(x / SIZE, v);
      const index = (y * SIZE + x) * 3;
      color[index] = Math.round(sample.r * 255);
      color[index + 1] = Math.round(sample.g * 255);
      color[index + 2] = Math.round(sample.b * 255);
      height[y * SIZE + x] = sample.height;
    }
  }
  return { color, height };
}

/** Tangent-space normal from the height field, wrap-aware on both axes. */
function buildNormal(height, strength) {
  const normal = Buffer.alloc(SIZE * SIZE * 3);
  const at = (x, y) => height[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx;
      let ny = dy;
      let nz = 1;
      const inverse = 1 / Math.hypot(nx, ny, nz);
      nx *= inverse;
      ny *= inverse;
      nz *= inverse;
      const index = (y * SIZE + x) * 3;
      normal[index] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[index + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[index + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }
  return normal;
}

// ---------------------------------------------------------------------------

const preview = process.argv.includes("--preview");

rmSync(STAGING, { recursive: true, force: true });
mkdirSync(COLOR_STAGING, { recursive: true });
mkdirSync(NORMAL_STAGING, { recursive: true });
mkdirSync(OUTPUT, { recursive: true });

const { color, height } = buildColorAndHeight();
const normal = buildNormal(height, 5.5);
const raw = (buffer) => sharp(buffer, { raw: { width: SIZE, height: SIZE, channels: 3 } });

await raw(color)
  .png({ compressionLevel: 9 })
  .toFile(path.join(COLOR_STAGING, "hall-timber-basecolor.png"));
await raw(normal)
  .png({ compressionLevel: 9 })
  .toFile(path.join(NORMAL_STAGING, "hall-timber-normal.png"));

if (preview) {
  // A 2×2 lay-up proves the tile is seamless at a glance, and the tinted strips
  // show what the runtime's per-board tints actually do to the neutral tile.
  const previewDir = path.join(ROOT, ".data/sutro-hall-textures");
  const tile = await raw(color).png().toBuffer();
  await sharp({ create: { width: SIZE * 2, height: SIZE * 2, channels: 3, background: "#000" } })
    .composite([
      { input: tile, left: 0, top: 0 },
      { input: tile, left: SIZE, top: 0 },
      { input: tile, left: 0, top: SIZE },
      { input: tile, left: SIZE, top: SIZE }
    ])
    .png()
    .toFile(path.join(previewDir, "tile-2x2.png"));
  const tints = [
    ["warm", 1.0, 0.66, 0.4],
    ["honey", 1.0, 0.78, 0.52],
    ["dark", 0.4, 0.26, 0.19],
    ["espresso", 0.26, 0.17, 0.13]
  ];
  for (const [name, r, g, b] of tints) {
    await raw(color)
      .linear([r, g, b], [0, 0, 0])
      .png()
      .toFile(path.join(previewDir, `tint-${name}.png`));
  }
}

execFileSync(
  process.execPath,
  [OPTIMIZER, COLOR_STAGING, OUTPUT, `--max=${SIZE}`, "--webp-only"],
  { cwd: ROOT, stdio: "inherit" }
);
execFileSync(
  process.execPath,
  [OPTIMIZER, NORMAL_STAGING, OUTPUT, `--max=${SIZE}`, "--linear", "--webp-only"],
  { cwd: ROOT, stdio: "inherit" }
);

console.log(
  `sutro hall timber ready in ${path.relative(ROOT, OUTPUT)} ` +
    `(${SIZE}² tile = ${TILE_METRES} m, ${RINGS_PER_TILE} rings/tile)`
);
