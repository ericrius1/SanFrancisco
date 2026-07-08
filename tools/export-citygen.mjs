// CityGen footprint export.
//
// Reads the full baked geometry payload (data/city/city.json) — which carries the
// REAL OSM footprint polygon + real base/top heights per building — classifies
// each building to an SF archetype (tools/citygen-classify.mjs) and emits a
// compact, tile-bucketed record for the runtime streaming ring. Crucially it
// keeps the real `poly` (NOT a bbox rectangle): the old export
// (export-buildings-citywide.mjs) collapsed each footprint to an oriented box,
// which is why generated buildings visibly "shifted" from their baked twin. Here
// the generated silhouette == the baked silhouette, so the swap is invisible.
//
//   node tools/export-citygen.mjs
// → public/citygen/buildings.json
//     { tile, minX, minZ, tilesX, tilesZ, cells: { "tx_tz": [ {i,id,poly,base,top,h,archetype,seed}, ... ] } }
//
// `i` is the tile-local building index — it pairs with tiles.suppressBuilding(key,i)
// so the ring can hide the baked twin. Towers/superblocks are left out (kept baked).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify, isTower, isTooSmall, ARCHETYPES } from "./citygen-classify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CITY = path.join(ROOT, "data/city/city.json");
const MANIFEST = path.join(ROOT, "public/data/manifest.json");
const OUTDIR = path.join(ROOT, "public/citygen");
const OUT = path.join(OUTDIR, "buildings.json");

/** FNV-1a hash of the OSM id → deterministic per-building seed. */
function seedOf(id) {
  let h = 2166136261 >>> 0;
  const s = String(id);
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const city = JSON.parse(await readFile(CITY, "utf8"));
const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
const { tile, minX, minZ, tilesX, tilesZ } = manifest;

const cells = {};
const hist = Object.fromEntries(ARCHETYPES.map((a) => [a, 0]));
let total = 0, kept = 0, towers = 0, tiny = 0;

for (const [key, t] of Object.entries(city.tiles)) {
  const list = t.buildings ?? t.b ?? [];
  const out = [];
  for (const b of list) {
    total++;
    if (isTower(b)) { towers++; continue; }
    if (isTooSmall(b)) { tiny++; continue; }
    const [cx, cz] = b.c ?? [0, 0];
    const seed = seedOf(b.id);
    const height = (b.top ?? b.h ?? 0) - (b.base ?? 0);
    const archetype = classify(cx, cz, { area: b.area, height, p: b.p, seed });
    hist[archetype] = (hist[archetype] ?? 0) + 1;
    out.push({
      i: b.i,
      id: b.id,
      poly: b.poly,
      base: b.base ?? 0,
      top: b.top ?? (b.base ?? 0) + (b.h ?? 9),
      h: b.h,
      archetype,
      seed,
    });
    kept++;
  }
  if (out.length) cells[key] = out;
}

await mkdir(OUTDIR, { recursive: true });
const payload = { tile, minX, minZ, tilesX, tilesZ, cells };
const json = JSON.stringify(payload);
await writeFile(OUT, json);

const sizeKB = (json.length / 1024).toFixed(0);
console.log(`scanned ${total} buildings from city.json`);
console.log(`kept ${kept}  (skipped ${towers} towers, ${tiny} too-small), across ${Object.keys(cells).length} tiles`);
console.log("archetype histogram:");
for (const a of ARCHETYPES) {
  const n = hist[a];
  const pct = kept ? ((n / kept) * 100).toFixed(1) : "0.0";
  console.log(`  ${a.padEnd(10)} ${String(n).padStart(6)}  ${pct.padStart(5)}%`);
}
console.log(`→ ${path.relative(ROOT, OUT)}  (${sizeKB} KB)`);
