// Verify baked building/landmark collider boxes do not occupy road corridors.
//
//   node tools/check-road-collider-overlap.mjs          # audit only, exit 1 on overlap
//   node tools/check-road-collider-overlap.mjs --write  # remove overlapping boxes

import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  filterRoadOverlappingColliders,
  loadRoadClearanceIndexFromRoadsJson
} from "./road-collider-clearance.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, "public", "data");
const WRITE = process.argv.includes("--write");

const index = await loadRoadClearanceIndexFromRoadsJson(path.join(DATA, "roads.json"));
const examples = [];
let files = 0;
let boxes = 0;
let dropped = 0;

async function checkFile(file, flatLandmarks = false) {
  const raw = JSON.parse(await readFile(file, "utf8"));
  const { kept, dropped: bad } = filterRoadOverlappingColliders(raw, index);
  files++;
  boxes += raw.length;
  dropped += bad.length;
  for (const item of bad.slice(0, Math.max(0, 12 - examples.length))) {
    examples.push({
      file: path.relative(ROOT, file),
      id: item.collider.i ?? item.collider.lm ?? null,
      x: Math.round(item.collider.x * 10) / 10,
      z: Math.round(item.collider.z * 10) / 10,
      hx: item.collider.hx,
      hz: item.collider.hz,
      road: item.roadId
    });
  }
  if (WRITE && bad.length) {
    await writeFile(file, JSON.stringify(kept));
    if (flatLandmarks) {
      console.log(`[road-collider] ${path.relative(ROOT, file)}: removed ${bad.length} landmark boxes`);
    }
  }
}

for (const f of await readdir(path.join(DATA, "colliders"))) {
  if (!/^tile_.+\.json$/.test(f)) continue;
  await checkFile(path.join(DATA, "colliders", f));
}

const landmarkFile = path.join(DATA, "landmark-colliders.json");
try {
  await checkFile(landmarkFile, true);
} catch {
  // Optional in older data sets.
}

const msg =
  `[road-collider] ${files} files, ${boxes} boxes, ${dropped} road-overlap boxes` +
  (WRITE ? " removed" : " found");
console.log(msg);
if (examples.length) console.log(JSON.stringify({ examples }, null, 2));
if (dropped && !WRITE) process.exit(1);
