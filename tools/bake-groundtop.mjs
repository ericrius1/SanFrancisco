// Standalone bake of public/data/groundtop.bin (the rendered top-ground surface —
// see groundtop-lib.mjs). Reads only committed artifacts (meta.json, heightmap.bin,
// city.json), so it runs anywhere without OSM/DEM raw data or Blender. The same
// computeGroundTop() is wired into tools/prepare-city.mjs for full rebuilds.
//
//   node tools/bake-groundtop.mjs

import { readFile, writeFile } from "node:fs/promises";
import { computeGroundTop } from "./groundtop-lib.mjs";

const PUB = new URL("../public/data/", import.meta.url);
const CITY = new URL("../data/city/city.json", import.meta.url);

function f32(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

const meta = JSON.parse(await readFile(new URL("meta.json", PUB)));
const grid = meta.grid;
const height = f32(await readFile(new URL("heightmap.bin", PUB)));
const expect = grid.width * grid.height;
if (height.length !== expect) throw new Error(`heightmap ${height.length} != grid ${expect}`);

const { tiles } = JSON.parse(await readFile(CITY));
const greenLists = Object.values(tiles).map((t) => t.green || []);

const top = computeGroundTop(grid, height, greenLists);
await writeFile(new URL("groundtop.bin", PUB), Buffer.from(top.buffer));

let raised = 0;
let maxLift = 0;
for (let i = 0; i < top.length; i++) {
  const d = top[i] - height[i];
  if (d > 1e-4) raised++;
  if (d > maxLift) maxLift = d;
}
console.log(
  `[groundtop] wrote ${top.length} cells (${(top.buffer.byteLength / 1e6).toFixed(1)}MB); ` +
    `raised ${raised} park cells (${((100 * raised) / top.length).toFixed(1)}%), max lift ${maxLift.toFixed(3)}m`
);
