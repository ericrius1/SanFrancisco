// Contract test for the M14a terrain tile bake (tools/bake-terrain-tiles.mjs).
// Runs against the ACTUAL baked output in public/data/terrain/ and asserts:
//   (a) every tile's heights/surface bytes exactly match the corresponding
//       sub-rect of heightmap.bin / surface.bin;
//   (b) the sparse groundtop deltas reconstructed from all tiles exactly match
//       the original SFGD entries (count + cell indices + values);
//   (c) overview dims/encoding are sane and each texel is the box-average of
//       its 8×8 source block (±1 int16 step for rounding);
//   (d) terrain-manifest.json lists exactly the emitted tiles with true sizes,
//       covering every 800m grid position that intersects the cell grid.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "public/data");
const terrainDir = path.join(dataDir, "terrain");

// Self-healing build: public/data/terrain/ is generated output (gitignored) —
// a fresh clone won't have it. Bake it from the tracked source bins before
// asserting the contract, so `npm run build` never depends on untracked state.
if (!existsSync(path.join(terrainDir, "terrain-manifest.json"))) {
  console.log("terrain tiles contract: baked data missing — running tools/bake-terrain-tiles.mjs");
  const bakeStart = Date.now();
  const bake = spawnSync(process.execPath, [path.join(root, "tools/bake-terrain-tiles.mjs")], {
    stdio: "inherit"
  });
  if (bake.status !== 0) {
    console.error("terrain tiles contract: bake failed");
    process.exit(bake.status ?? 1);
  }
  console.log(`terrain tiles contract: bake completed in ${((Date.now() - bakeStart) / 1000).toFixed(1)} s`);
}

const meta = JSON.parse(readFileSync(path.join(dataDir, "meta.json"), "utf8"));
const { width, height } = meta.grid;
const tileCells = meta.tile / meta.grid.cellSize; // 100

const heightBuf = readFileSync(path.join(dataDir, "heightmap.bin"));
const heights = new Int16Array(heightBuf.buffer, heightBuf.byteOffset, width * height);
const surface = readFileSync(path.join(dataDir, "surface.bin"));
const sfgd = readFileSync(path.join(dataDir, "groundtop-delta.bin"));
assert.equal(sfgd.toString("ascii", 0, 4), "SFGD", "groundtop-delta.bin magic");
const origDeltaCount = sfgd.readUInt32LE(6);

const manifest = JSON.parse(readFileSync(path.join(terrainDir, "terrain-manifest.json"), "utf8"));
assert.equal(manifest.tile, meta.tile, "manifest tile size");
assert.equal(manifest.tilesX, meta.tilesX, "manifest tilesX");
assert.equal(manifest.tilesZ, meta.tilesZ, "manifest tilesZ");

// (c) overview
assert.equal(manifest.overview.scale, 8, "overview scale");
assert.equal(manifest.overview.width * 8, width, "overview width covers grid");
assert.equal(manifest.overview.height * 8, height, "overview height covers grid");
const ovBuf = readFileSync(path.join(terrainDir, "overview.bin"));
const ovW = manifest.overview.width;
const ovH = manifest.overview.height;
assert.equal(ovBuf.byteLength, ovW * ovH * 2, "overview.bin byte length");
const ov = new Int16Array(ovBuf.buffer, ovBuf.byteOffset, ovW * ovH);
const ovSurf = readFileSync(path.join(terrainDir, "overview-surface.bin"));
assert.equal(ovSurf.byteLength, ovW * ovH, "overview-surface.bin byte length");
const votes = new Uint32Array(256);
for (let oz = 0; oz < ovH; oz++) {
  for (let ox = 0; ox < ovW; ox++) {
    let sum = 0;
    votes.fill(0);
    for (let dz = 0; dz < 8; dz++) {
      const row = (oz * 8 + dz) * width + ox * 8;
      for (let dx = 0; dx < 8; dx++) {
        sum += heights[row + dx];
        votes[surface[row + dx]]++;
      }
    }
    const texel = ov[oz * ovW + ox];
    assert.ok(
      Math.abs(texel - sum / 64) <= 1,
      `overview texel ${ox},${oz}: ${texel} vs box-average ${sum / 64}`
    );
    const cls = ovSurf[oz * ovW + ox];
    assert.ok(cls <= 4, `overview surface class ${cls} at ${ox},${oz}`);
    // majority vote with the documented tie-break: the stored class must be
    // the LOWEST class id among the max-vote classes (bake uses strict `>`
    // over ascending ids, so the first max wins).
    let best = 0;
    for (let c = 1; c < 256; c++) if (votes[c] > votes[best]) best = c;
    assert.equal(
      cls,
      best,
      `overview surface ${ox},${oz}: class ${cls} is not the lowest-id majority class ${best}`
    );
  }
}
// encoding sanity: decoded range within plausible SF bounds
{
  let min = Infinity, max = -Infinity;
  for (const v of ov) { if (v < min) min = v; if (v > max) max = v; }
  const { heightBase, heightQuant } = meta.terrain;
  const minM = heightBase + min * heightQuant;
  const maxM = heightBase + max * heightQuant;
  assert.ok(minM >= -100 && maxM <= 600 && maxM > 100, `overview height range insane: ${minM}..${maxM}`);
}

// expected tile keys: every 800m position intersecting the grid
const expectedKeys = new Set();
for (let iz = 0; iz < meta.tilesZ; iz++) {
  for (let ix = 0; ix < meta.tilesX; ix++) {
    if (ix * tileCells < width && iz * tileCells < height) expectedKeys.add(`${ix}_${iz}`);
  }
}
const manifestKeys = new Set(Object.keys(manifest.tiles));
assert.deepEqual([...manifestKeys].sort(), [...expectedKeys].sort(), "manifest tile keys");

// (d) emitted files == manifest entries
const diskTiles = readdirSync(terrainDir).filter((f) => /^tile_\d+_\d+\.bin$/.test(f));
assert.equal(diskTiles.length, manifestKeys.size, "tile file count matches manifest");

// (a)+(b): per-tile byte-exactness + delta reconstruction
const rebuiltDeltas = new Map(); // global cellIndex -> deltaMm
for (const key of manifestKeys) {
  const [ix, iz] = key.split("_").map(Number);
  const buf = readFileSync(path.join(terrainDir, `tile_${key}.bin`));
  assert.equal(buf.byteLength, manifest.tiles[key].bytes, `tile ${key}: manifest bytes`);
  assert.equal(buf.toString("ascii", 0, 4), "SFTT", `tile ${key}: magic`);
  assert.equal(buf.readUInt16LE(4), 1, `tile ${key}: version`);
  assert.equal(buf.readUInt16LE(6), ix, `tile ${key}: header ix`);
  assert.equal(buf.readUInt16LE(8), iz, `tile ${key}: header iz`);
  const cellsX = buf.readUInt16LE(10);
  const cellsZ = buf.readUInt16LE(12);
  const x0 = ix * tileCells;
  const z0 = iz * tileCells;
  assert.equal(cellsX, Math.min(tileCells, width - x0), `tile ${key}: cellsX`);
  assert.equal(cellsZ, Math.min(tileCells, height - z0), `tile ${key}: cellsZ`);
  const n = cellsX * cellsZ;
  let off = 14;
  for (let lz = 0; lz < cellsZ; lz++) {
    for (let lx = 0; lx < cellsX; lx++) {
      const v = buf.readInt16LE(off + (lz * cellsX + lx) * 2);
      const orig = heights[(z0 + lz) * width + (x0 + lx)];
      if (v !== orig) assert.fail(`tile ${key}: height mismatch at ${lx},${lz}: ${v} != ${orig}`);
    }
  }
  off += n * 2;
  for (let lz = 0; lz < cellsZ; lz++) {
    const cmp = buf.compare(surface, (z0 + lz) * width + x0, (z0 + lz) * width + x0 + cellsX, off + lz * cellsX, off + lz * cellsX + cellsX);
    assert.equal(cmp, 0, `tile ${key}: surface row ${lz} mismatch`);
  }
  off += n;
  const dCount = buf.readUInt32LE(off);
  off += 4;
  assert.equal(off + dCount * 6, buf.byteLength, `tile ${key}: trailing byte length`);
  let prevLocal = -1;
  for (let k = 0; k < dCount; k++) {
    const local = buf.readUInt32LE(off);
    const mm = buf.readUInt16LE(off + 4);
    off += 6;
    assert.ok(local > prevLocal, `tile ${key}: delta local indices not ascending`);
    prevLocal = local;
    assert.ok(local < n, `tile ${key}: delta local index ${local} out of range`);
    const lx = local % cellsX;
    const lz = (local - lx) / cellsX;
    const global = (z0 + lz) * width + (x0 + lx);
    assert.ok(!rebuiltDeltas.has(global), `duplicate delta for global cell ${global}`);
    rebuiltDeltas.set(global, mm);
  }
}

assert.equal(rebuiltDeltas.size, origDeltaCount, "reconstructed delta count");
for (let k = 0; k < origDeltaCount; k++) {
  const off = 10 + k * 6;
  const cellIndex = sfgd.readUInt32LE(off);
  const deltaMm = sfgd.readUInt16LE(off + 4);
  if (rebuiltDeltas.get(cellIndex) !== deltaMm) {
    assert.fail(`delta mismatch at cell ${cellIndex}: ${rebuiltDeltas.get(cellIndex)} != ${deltaMm}`);
  }
}

console.log(
  `terrain tiles contract: ok (${manifestKeys.size} tiles byte-exact, ` +
    `${origDeltaCount} deltas reconstructed, overview ${ovW}x${ovH} verified)`
);
