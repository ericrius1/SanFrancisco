// Surgical patch: stamp the ocean beaches into surface.bin as sand so ground
// cover stops growing ON the sand. Companion to tools/mark-roads-surface.mjs —
// same shape, same reason: a surface class the bake got wrong, patched without
// the raw OSM extracts a full prepare-city run needs.
//
// Ocean Beach, Baker/Marshall's and China Beach all sit inside GGNRA/park
// polygons, which prepare-city rasterizes as class 1 green BEFORE its natural
// sand-band pass — and that pass only ever re-classed developed class 0. So the
// dry sand baked as parkland, the wildlands grass gate (grassyGround) planted a
// wildflower meadow down to the waterline, and the terrain clipmap painted the
// beach lawn-green.
//
//   node tools/mark-beaches-surface.mjs
//
// Corridors and the sweep itself live in tools/beaches.mjs, shared with
// prepare-city.mjs so a full re-bake produces the same bytes. Re-runnable; only
// touches surface.bin. After running, reload the app — WorldMap.load() picks up
// the new bytes and every surfaceType consumer (grass + wildflower gates,
// terrain paint, footstep foley) agrees that the beach is sand.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { GRID } from "./geo.mjs";
import { markBeachSand } from "./beaches.mjs";

const { width: W, height: H } = GRID;

const DATA = new URL("../public/data/", import.meta.url);
// write every copy the app might serve: public (vite dev source of truth) + dist
// (an already-built bundle) so live + headless agree.
const TARGETS = [
  new URL("../public/data/surface.bin", import.meta.url),
  new URL("../dist/data/surface.bin", import.meta.url)
];

/** Decode the baked heightmap into metres per cell (int16 quantised, or legacy float32). */
async function loadHeights(meta) {
  const buf = (await readFile(new URL("heightmap.bin", DATA))).buffer;
  const terrain = meta.terrain;
  if (terrain?.heightEncoding === "int16") {
    const raw = new Int16Array(buf);
    const { heightBase: base, heightQuant: quant } = terrain;
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = base + raw[i] * quant;
    return out;
  }
  return new Float32Array(buf);
}

async function main() {
  const meta = JSON.parse(await readFile(new URL("meta.json", DATA), "utf8"));
  const surface = new Uint8Array((await readFile(new URL("surface.bin", DATA))).buffer.slice(0));
  if (surface.length !== W * H) throw new Error(`surface.bin size ${surface.length} != ${W * H}`);
  const heights = await loadHeights(meta);
  if (heights.length !== W * H) throw new Error(`heightmap size ${heights.length} != ${W * H}`);

  const counts = markBeachSand(surface, (i) => heights[i], GRID);

  for (const url of TARGETS) {
    if (!existsSync(url)) continue;
    await writeFile(url, surface);
    console.log(`[beaches] wrote ${url.pathname}`);
  }
  const total = counts.reduce((sum, c) => sum + c.cells, 0);
  for (const c of counts) console.log(`[beaches] ${c.id}: ${c.cells} cells → sand`);
  console.log(`[beaches] ${total} cells re-classed (${((total / (W * H)) * 100).toFixed(2)}% of grid)`);
}

main();
