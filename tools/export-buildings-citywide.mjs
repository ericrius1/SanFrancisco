// Citywide building footprint export for the generated-building ring.
//
// Same derivation as export-chinatown.mjs (dominant collider box → oriented
// footprint → HK-generator params) but across the WHOLE city, bucketed into the
// tile grid so the ring only scans cells near the player instead of a flat list.
// Towers / superblocks (dominant half-extent > MAX_HALF) are left OUT so they
// keep their baked mesh — only the walkable mid-rise fabric is replaced.
//
//   node tools/export-buildings-citywide.mjs
// → public/buildinggen/buildings-citywide.json
//     { tile, minX, minZ, tilesX, tilesZ, buildingScale, cells: { "x_z": [ ... ] } }
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLIDERS = path.join(ROOT, "public/data/colliders");
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, "public/data/manifest.json"), "utf8"));
const OUT = path.join(ROOT, "public/buildinggen/buildings-citywide.json");

const BUILDING_SCALE = 3.0;
const MIN_HALF = 4;      // metres — skip buildings narrower than ~8 m (sheds)
const MAX_HALF = 34;     // metres — skip footprints wider than ~68 m (towers/superblocks stay baked)
const MIN_FLOORS = 2;
const MAX_FLOORS = 12;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function hashKey(key) {
  let h = 2166136261;
  for (let k = 0; k < key.length; k++) { h ^= key.charCodeAt(k); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const { tile, minX, minZ, tilesX, tilesZ } = MANIFEST;
const cells = {};
let scanned = 0, kept = 0, skippedSize = 0;

for (let tx = 0; tx < tilesX; tx++) {
  for (let tz = 0; tz < tilesZ; tz++) {
    const key = `${tx}_${tz}`;
    const file = path.join(COLLIDERS, `tile_${key}.json`);
    if (!existsSync(file)) continue;
    const boxes = JSON.parse(readFileSync(file, "utf8"));
    const nB = MANIFEST.tiles[key]?.b ?? 0;

    const byIndex = new Map();
    for (const b of boxes) {
      if (b.i >= nB) continue;                 // landmark colliders, not OSM buildings
      (byIndex.get(b.i) ?? byIndex.set(b.i, []).get(b.i)).push(b);
    }

    const list = [];
    for (const [i, group] of byIndex) {
      scanned++;
      let dom = group[0], domArea = dom.hx * dom.hz, top = -Infinity;
      for (const b of group) {
        const a = b.hx * b.hz;
        if (a > domArea) { domArea = a; dom = b; }
        top = Math.max(top, b.y + b.hy);
      }
      const hx = dom.hx, hz = dom.hz;
      if (Math.max(hx, hz) < MIN_HALF || Math.max(hx, hz) > MAX_HALF) { skippedSize++; continue; }

      const floors = clamp(Math.round(top / BUILDING_SCALE), MIN_FLOORS, MAX_FLOORS);
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
      list.push({
        i, x: +dom.x.toFixed(1), z: +dom.z.toFixed(1), yaw: +yaw.toFixed(3),
        floors, length, width,
        seed: (hashKey(key) * 131071 + i * 2654435761) >>> 0,
      });
      kept++;
    }
    if (list.length) cells[key] = list;
  }
}

const out = { tile, minX, minZ, tilesX, tilesZ, buildingScale: BUILDING_SCALE, cells };
writeFileSync(OUT, JSON.stringify(out));
const sizeKB = (JSON.stringify(out).length / 1024).toFixed(0);
console.log(`scanned ${scanned} buildings citywide`);
console.log(`kept ${kept} (skipped ${skippedSize} by size), across ${Object.keys(cells).length} tiles`);
console.log(`→ ${path.relative(ROOT, OUT)}  (${sizeKB} KB)`);
