// Extract a Chinatown building footprint list for the generated-building ring.
//
// The baked collider files (public/data/colliders/tile_X_Z.json) already carry
// every OSM building's footprint in GAME coordinates: an array of boxes
// { i, x, z, y, hx, hy, hz, yaw } (i = building index, matches
// TileStreamer.suppressBuilding; concave footprints get several boxes — see
// sf-collider-decomposition). We pick the dominant box per building as its
// oriented footprint, derive HK-generator params (length/width/floors) from its
// half-extents + height, and emit a flat list the ring streams at runtime.
//
//   node tools/export-chinatown.mjs
// → public/buildinggen/chinatown.json  { center, radius, buildings:[...] }
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLIDERS = path.join(ROOT, "public/data/colliders");
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, "public/data/manifest.json"), "utf8"));
const OUT = path.join(ROOT, "public/buildinggen/chinatown.json");

// Chinatown core, game frame. Verified transform (meta.json origin 37.79,
// -122.444): x=(lon+122.444)*87971.96, z=-(lat-37.79)*110574 — reproduces the
// Salesforce Tower at (4117,33). Grant Ave & Clay St ≈ (3300,-400).
const CENTER = { x: 3300, z: -400 };
const RADIUS = 340;               // metres — Chinatown core for the demo
const BUILDING_SCALE = 3.0;       // metres per Blender unit (matches index.ts)

// The HK kit looks native on mid-rise tenement footprints. Skip footprints it
// can't represent well: tiny sheds and big superblocks/towers keep their baked mesh.
const MIN_HALF = 4;               // metres — skip buildings narrower than ~8 m
const MAX_HALF = 34;              // metres — skip footprints wider than ~68 m
const MIN_FLOORS = 2;
const MAX_FLOORS = 12;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function tileRange() {
  const { tile, minX, minZ, tilesX, tilesZ } = MANIFEST;
  const t = (v, min) => Math.floor((v - min) / tile);
  const x0 = clamp(t(CENTER.x - RADIUS, minX), 0, tilesX - 1);
  const x1 = clamp(t(CENTER.x + RADIUS, minX), 0, tilesX - 1);
  const z0 = clamp(t(CENTER.z - RADIUS, minZ), 0, tilesZ - 1);
  const z1 = clamp(t(CENTER.z + RADIUS, minZ), 0, tilesZ - 1);
  const keys = [];
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) keys.push(`${x}_${z}`);
  return keys;
}

const buildings = [];
let scanned = 0, skippedSize = 0, skippedFar = 0;

for (const key of tileRange()) {
  const file = path.join(COLLIDERS, `tile_${key}.json`);
  if (!existsSync(file)) continue;
  const boxes = JSON.parse(readFileSync(file, "utf8"));
  const nB = MANIFEST.tiles[key]?.b ?? 0;   // i >= nB are landmark boxes, not OSM buildings

  // group boxes by building index
  const byIndex = new Map();
  for (const b of boxes) {
    if (b.i >= nB) continue;                // skip landmark colliders
    (byIndex.get(b.i) ?? byIndex.set(b.i, []).get(b.i)).push(b);
  }

  for (const [i, group] of byIndex) {
    scanned++;
    // dominant box = largest footprint area → its centre/yaw/half-extents are the
    // building's oriented rectangle; height = tallest top across all its boxes.
    let dom = group[0];
    let domArea = dom.hx * dom.hz;
    let top = -Infinity;
    for (const b of group) {
      const a = b.hx * b.hz;
      if (a > domArea) { domArea = a; dom = b; }
      top = Math.max(top, b.y + b.hy);
    }
    const cx = dom.x, cz = dom.z;
    const dx = cx - CENTER.x, dz = cz - CENTER.z;
    if (Math.hypot(dx, dz) > RADIUS) { skippedFar++; continue; }
    const hx = dom.hx, hz = dom.hz;
    if (Math.max(hx, hz) < MIN_HALF || Math.max(hx, hz) > MAX_HALF) { skippedSize++; continue; }

    const floors = clamp(Math.round(top / BUILDING_SCALE), MIN_FLOORS, MAX_FLOORS);
    // HK generator: length runs along local x, width along local z. Map the
    // dominant box's larger half-extent to length so the long facade faces the
    // street. yaw aligns local x with the box's long axis.
    let length, width, yaw;
    if (hx >= hz) {
      length = clamp(Math.round((hx * 2) / BUILDING_SCALE), 3, 12);
      width = clamp(Math.round((hz * 2) / BUILDING_SCALE), 2, 8);
      yaw = dom.yaw;
    } else {
      length = clamp(Math.round((hz * 2) / BUILDING_SCALE), 3, 12);
      width = clamp(Math.round((hx * 2) / BUILDING_SCALE), 2, 8);
      yaw = dom.yaw + Math.PI / 2;
    }
    buildings.push({
      key, i,
      x: +cx.toFixed(1), z: +cz.toFixed(1),
      yaw: +yaw.toFixed(3),
      floors, length, width,
      seed: (hashKey(key) * 131071 + i * 2654435761) >>> 0,
    });
  }
}

function hashKey(key) {
  let h = 2166136261;
  for (let k = 0; k < key.length; k++) { h ^= key.charCodeAt(k); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const out = { center: CENTER, radius: RADIUS, buildingScale: BUILDING_SCALE, buildings };
writeFileSync(OUT, JSON.stringify(out));
console.log(`scanned ${scanned} buildings across ${tileRange().length} tiles`);
console.log(`kept ${buildings.length}  (skipped ${skippedSize} by size, ${skippedFar} out of radius)`);
console.log(`floors: min ${Math.min(...buildings.map(b => b.floors))} max ${Math.max(...buildings.map(b => b.floors))}`);
console.log(`→ ${path.relative(ROOT, OUT)}  (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
