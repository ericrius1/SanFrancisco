#!/usr/bin/env node

// Find CityGen buildings that stand where there is no land to stand on.
//
//   node tools/citygen-over-water-audit.mjs [--near-x -6157 --near-z 1247 --radius 1500]
//
// Buildings looking out from Sutro Baths and from the Ocean Beach kite field are
// visibly hanging in the air over the Pacific. The heightfield is the arbiter:
// this reads public/data/heightmap.bin directly (no browser, no renderer) and
// samples the terrain under each building's footprint, reporting the ones whose
// ground is at or below sea level.
//
// Offline on purpose. The rendered clipmap is GPU-displaced, so a raycast in the
// live scene always strikes the flat undisplaced grid at y=0 and can never
// answer this question; the source heightfield can.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const meta = JSON.parse(readFileSync(path.join(ROOT, "public/data/meta.json"), "utf8"));
const { cellSize, width, height, minX, minZ } = meta.grid;
const { heightBase, heightQuant } = meta.terrain;
const SEA = meta.seaLevel ?? 0;

const raw = readFileSync(path.join(ROOT, "public/data/heightmap.bin"));
const heights = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
if (heights.length < width * height) {
  throw new Error(`heightmap too small: ${heights.length} < ${width * height}`);
}

/** Bilinear sample of the source heightfield, matching heightmap.ts decoding. */
function groundHeight(x, z) {
  const gx = (x - minX) / cellSize;
  const gz = (z - minZ) / cellSize;
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(gx)));
  const z0 = Math.max(0, Math.min(height - 1, Math.floor(gz)));
  const x1 = Math.min(width - 1, x0 + 1);
  const z1 = Math.min(height - 1, z0 + 1);
  const fx = Math.max(0, Math.min(1, gx - x0));
  const fz = Math.max(0, Math.min(1, gz - z0));
  const at = (ix, iz) => heightBase + heights[iz * width + ix] * heightQuant;
  const a = at(x0, z0);
  const b = at(x1, z0);
  const c = at(x0, z1);
  const d = at(x1, z1);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

const grid = JSON.parse(readFileSync(path.join(ROOT, "public/citygen/buildings.json"), "utf8"));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(argv[i + 1]);
};
const nearX = arg("near-x", null);
const nearZ = arg("near-z", null);
const radius = arg("radius", 1500);

/** Footprint centroid + a ring of samples, so a building half on a cliff counts. */
function footprintStats(b) {
  const poly = b.footprint ?? b.poly ?? b.outline ?? null;
  const pts = [];
  if (Array.isArray(poly)) {
    for (const p of poly) {
      if (Array.isArray(p) && p.length >= 2) pts.push([p[0], p[1]]);
      else if (p && typeof p.x === "number") pts.push([p.x, p.z ?? p.y]);
    }
  }
  if (!pts.length && typeof b.x === "number") pts.push([b.x, b.z]);
  if (!pts.length) return null;
  let cx = 0;
  let cz = 0;
  for (const [px, pz] of pts) {
    cx += px;
    cz += pz;
  }
  cx /= pts.length;
  cz /= pts.length;
  let min = Infinity;
  let max = -Infinity;
  for (const [px, pz] of pts) {
    const g = groundHeight(px, pz);
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const gc = groundHeight(cx, cz);
  if (gc < min) min = gc;
  if (gc > max) max = gc;
  return { cx, cz, minGround: min, maxGround: max, centreGround: gc, points: pts.length };
}

const offenders = [];
let scanned = 0;
let noFootprint = 0;

for (const [key, cell] of Object.entries(grid.cells)) {
  for (const [indexText, building] of Object.entries(cell)) {
    const index = Number(indexText);
    const stats = footprintStats(building);
    if (!stats) {
      noFootprint++;
      continue;
    }
    scanned++;
    if (nearX !== null && Math.hypot(stats.cx - nearX, stats.cz - nearZ) > radius) continue;
    // "Over water" = the whole footprint is at or under sea level. A building
    // with any part on land is a grading problem, not a phantom, and is left
    // alone here.
    if (stats.maxGround <= SEA) {
      offenders.push({
        key,
        index,
        x: Math.round(stats.cx),
        z: Math.round(stats.cz),
        minGround: Number(stats.minGround.toFixed(2)),
        maxGround: Number(stats.maxGround.toFixed(2))
      });
    }
  }
}

process.stdout.write(`scanned ${scanned} buildings (${noFootprint} without a readable footprint)\n`);
if (nearX !== null) process.stdout.write(`filtered to ${radius} m of (${nearX}, ${nearZ})\n`);
process.stdout.write(`\nENTIRELY OVER WATER: ${offenders.length}\n`);

const byKey = new Map();
for (const o of offenders) {
  if (!byKey.has(o.key)) byKey.set(o.key, []);
  byKey.get(o.key).push(o);
}
for (const [key, list] of [...byKey.entries()].sort()) {
  const indices = list.map((o) => o.index).sort((a, b) => a - b);
  const xs = list.map((o) => o.x);
  const zs = list.map((o) => o.z);
  process.stdout.write(
    `  ${key}: ${indices.length} buildings  x[${Math.min(...xs)}..${Math.max(...xs)}] ` +
      `z[${Math.min(...zs)}..${Math.max(...zs)}]  maxGround ${Math.max(...list.map((o) => o.maxGround)).toFixed(2)}\n` +
      `      indices: ${JSON.stringify(indices)}\n`
  );
}
