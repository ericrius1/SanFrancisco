// Regenerate public/data/colliders/*.json from data/city/city.json — colliders
// only, no mesh/terrain touch (~seconds, safe to run standalone).
//
//   node tools/bake-colliders.mjs
//
// Concave footprints (L/C/U blocks, stadium rings) decompose into several
// oriented boxes instead of one min-area rect, so courtyards and field
// interiors stop being invisible walls (see tools/collider-lib.mjs). Sub-boxes
// share the building's `i` (alive flag, facade, destruction stay per-building);
// `vol` carries the WHOLE building's single-rect volume on every sub-box so HP
// balance (buildingHpPerM3) is unchanged from the old bake.
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { decomposeFootprint, minAreaRect, polyArea } from "./collider-lib.mjs";

const ROOT = new URL("../", import.meta.url);
const PUB = new URL("public/data/", ROOT);
const round1 = (v) => Math.round(v * 10) / 10;

const city = JSON.parse(await readFile(new URL("data/city/city.json", ROOT), "utf8"));

await mkdir(new URL("colliders/", PUB), { recursive: true });

// Hand-built landmarks (landmarks.glb) live outside the OSM tile pipeline, so
// their physics proxies come from data/landmark-colliders.json (emitted by
// blender_city.py build_landmarks). Boxes are bucketed into the per-tile
// collider files; i >= LM_BASE marks them for the runtime as always-alive and
// never fracturable, and the huge vol makes chip damage a no-op regardless.
const LM_BASE = 100000;
const meta = JSON.parse(await readFile(new URL("public/data/meta.json", ROOT), "utf8"));
const lmByTile = new Map();
let lmBoxes = 0;
try {
  const lms = JSON.parse(await readFile(new URL("data/landmark-colliders.json", ROOT), "utf8"));
  // Served flat for the runtime query world (physics #solids): the bridge +
  // landmarks load once at boot as always-resident static solids, independent of
  // the per-tile stream (open-water bridge tiles aren't even in the manifest).
  await writeFile(new URL("landmark-colliders.json", PUB), JSON.stringify(lms));
  const names = [...new Set(lms.map((b) => b.lm))];
  for (const b of lms) {
    const ix = Math.floor((b.x - meta.grid.minX) / meta.tile);
    const iz = Math.floor((b.z - meta.grid.minZ) / meta.tile);
    const key = `${ix}_${iz}`;
    if (!lmByTile.has(key)) lmByTile.set(key, []);
    lmByTile.get(key).push({
      i: LM_BASE + names.indexOf(b.lm),
      p: 7,
      x: b.x,
      z: b.z,
      y: b.y,
      hy: b.hy,
      hx: b.hx,
      hz: b.hz,
      yaw: b.yaw,
      vol: 1e9
    });
    lmBoxes++;
  }
} catch {
  console.log("[colliders] no data/landmark-colliders.json — landmarks stay ghost");
}

let nBuildings = 0;
let nBoxes = 0;
let nSplit = 0;
let worstBefore = 0;
let worstAfter = 0;
const written = new Set();

for (const [key, t] of Object.entries(city.tiles)) {
  const colliders = [];
  for (const b of t.buildings) {
    const rect = minAreaRect(b.poly);
    if (!rect) continue;
    nBuildings++;
    const pa = polyArea(b.poly);
    const vol = round1(rect.hx * rect.hz * b.h); // whole-building rect volume (HP parity)
    const parts = decomposeFootprint(b.poly);
    if (parts.length > 1) nSplit++;
    if (pa > 4) {
      worstBefore = Math.max(worstBefore, rect.area / pa);
      const after = parts.reduce((s, r) => s + r.area, 0) / pa;
      worstAfter = Math.max(worstAfter, after);
    }
    for (const r of parts) {
      nBoxes++;
      colliders.push({
        i: b.i,
        p: b.p,
        x: round1(r.cx),
        z: round1(r.cz),
        y: round1((b.base + b.top) / 2),
        hy: round1((b.top - b.base) / 2),
        hx: round1(Math.max(r.hx, 0.8)),
        hz: round1(Math.max(r.hz, 0.8)),
        yaw: Math.round(r.yaw * 1000) / 1000,
        vol
      });
    }
  }
  const extra = lmByTile.get(key);
  if (extra) {
    colliders.push(...extra);
    lmByTile.delete(key);
  }
  await writeFile(new URL(`colliders/tile_${key}.json`, PUB), JSON.stringify(colliders));
  written.add(`tile_${key}.json`);
}

// landmark boxes in tiles city.json doesn't know (e.g. open-water bridge
// spans) still need a collider file — the streamer fetches by manifest key
// and tolerates a missing GLB
for (const [key, extra] of lmByTile) {
  await writeFile(new URL(`colliders/tile_${key}.json`, PUB), JSON.stringify(extra));
  written.add(`tile_${key}.json`);
}

// Sweep tile files this bake didn't write: leftovers from an older grid keep
// being served (the streamer probes keys arithmetically and a stale file is a
// 200 full of garbage boxes — invisible walls kilometres from any building).
let swept = 0;
for (const f of await readdir(new URL("colliders/", PUB))) {
  if (f.startsWith("tile_") && f.endsWith(".json") && !written.has(f)) {
    await unlink(new URL(`colliders/${f}`, PUB));
    swept++;
  }
}

console.log(
  `[colliders] ${nBuildings} buildings -> ${nBoxes} boxes (${nSplit} split, +${(
    (100 * (nBoxes - nBuildings)) / nBuildings
  ).toFixed(1)}%), worst rect/poly cover ${worstBefore.toFixed(1)}x -> ${worstAfter.toFixed(1)}x, +${lmBoxes} landmark boxes, swept ${swept} stale files`
);
