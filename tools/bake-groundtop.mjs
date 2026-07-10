// Standalone bake of public/data/groundtop-delta.bin (the rendered top-ground
// surface as a sparse delta over the heightmap — see groundtop-lib.mjs).
// Reads only committed artifacts (meta.json, heightmap.bin, city.json), so it
// runs anywhere without OSM/DEM raw data or Blender. The same computeGroundTop()
// is wired into tools/prepare-city.mjs for full rebuilds.
//
//   node tools/bake-groundtop.mjs

import { readFile, writeFile } from "node:fs/promises";
import { computeGroundTop } from "./groundtop-lib.mjs";
import { decodeHeightmapBuffer, encodeGroundTopDelta } from "./terrain-codec.mjs";

const PUB = new URL("../public/data/", import.meta.url);
const CITY = new URL("../data/city/city.json", import.meta.url);

const meta = JSON.parse(await readFile(new URL("meta.json", PUB)));
const grid = meta.grid;
const expect = grid.width * grid.height;

// Support both float32 (legacy) and int16 (post-repack) heightmap formats
const hmBuf = await readFile(new URL("heightmap.bin", PUB));
const height = decodeHeightmapBuffer(hmBuf.buffer, meta);
if (height.length !== expect) throw new Error(`heightmap ${height.length} != grid ${expect}`);

const { tiles } = JSON.parse(await readFile(CITY));
const tileVals = Object.values(tiles);
const greenLists = tileVals.map((t) => t.green || []);
const roadLists = tileVals.map((t) => t.roads || []);

const top = computeGroundTop(grid, height, greenLists, roadLists);

// write sparse delta instead of full float32 groundtop
const deltaBuf = encodeGroundTopDelta(height, top);
await writeFile(new URL("groundtop-delta.bin", PUB), deltaBuf);

let raised = 0;
let maxLift = 0;
for (let i = 0; i < top.length; i++) {
  const d = top[i] - height[i];
  if (d > 1e-4) raised++;
  if (d > maxLift) maxLift = d;
}
console.log(
  `[groundtop] wrote groundtop-delta.bin ${(deltaBuf.byteLength / 1e3).toFixed(1)}KB (was ${(top.buffer.byteLength / 1e6).toFixed(1)}MB float32); ` +
    `raised ${raised} ground cells park+road (${((100 * raised) / top.length).toFixed(1)}%), max lift ${maxLift.toFixed(3)}m`
);
