// Bake terrain streaming artifacts (M14a) from the committed full-map data.
//
// Reads (all from public/data — never the raw DEM):
//   meta.json            — grid + terrain encoding constants (source of truth)
//   heightmap.bin        — int16 × width*height, meters = heightBase + v*heightQuant
//   surface.bin          — uint8 × width*height, classes 0..4
//   groundtop-delta.bin  — sparse SFGD (u32 cellIndex, u16 deltaMm) entries
//
// Writes public/data/terrain/:
//   overview.bin          — 1/8-res int16 heights (width/8 × height/8), box-averaged
//                           from full-res, SAME heightBase/heightQuant encoding.
//   overview-surface.bin  — 1/8-res uint8 surface, MAJORITY VOTE over each 8×8
//                           block (ties broken by lowest class id — deterministic).
//                           Majority (not centroid) so the water class is stable.
//   tile_IX_IZ.bin        — one bundle per 800m tile position intersecting the
//                           grid (ALL 19×18 here — grid dims exceed 18×17 tiles),
//                           edge tiles clipped to grid bounds. Layout (LE):
//                             [0..3]   magic "SFTT"
//                             [4..5]   u16 version = 1
//                             [6..7]   u16 ix
//                             [8..9]   u16 iz
//                             [10..11] u16 cellsX (≤100)
//                             [12..13] u16 cellsZ (≤100)
//                             [14..]   int16 heights[cellsX*cellsZ] row-major
//                                      within tile (same encoding as heightmap.bin)
//                             then     u8 surface[cellsX*cellsZ]
//                             then     u32 deltaCount
//                             then     deltaCount × (u32 localCellIndex, u16 deltaMm)
//                                      localCellIndex = lz*cellsX + lx, ascending.
//   terrain-manifest.json — { tile, tilesX, tilesZ, overview:{scale,width,height},
//                             tiles:{ "IX_IZ": { bytes } } } — existence oracle so
//                           the runtime never probes 404s.
//
// Deterministic + idempotent: pure function of the inputs, stable ordering.
//
// Usage: node tools/bake-terrain-tiles.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "public/data");
const outDir = path.join(dataDir, "terrain");

const meta = JSON.parse(readFileSync(path.join(dataDir, "meta.json"), "utf8"));
const { width, height } = meta.grid;
const tileMeters = meta.tile; // 800
const cellSize = meta.grid.cellSize; // 8
const tileCells = tileMeters / cellSize; // 100
const tilesX = meta.tilesX;
const tilesZ = meta.tilesZ;

const heightBuf = readFileSync(path.join(dataDir, "heightmap.bin"));
const heights = new Int16Array(heightBuf.buffer, heightBuf.byteOffset, width * height);
if (heightBuf.byteLength !== width * height * 2) {
  throw new Error(`heightmap.bin size ${heightBuf.byteLength} != ${width * height * 2}`);
}
const surface = readFileSync(path.join(dataDir, "surface.bin"));
if (surface.byteLength !== width * height) {
  throw new Error(`surface.bin size ${surface.byteLength} != ${width * height}`);
}
const sfgd = readFileSync(path.join(dataDir, "groundtop-delta.bin"));
if (sfgd.toString("ascii", 0, 4) !== "SFGD") throw new Error("groundtop-delta.bin: bad SFGD magic");
const deltaCount = sfgd.readUInt32LE(6);

mkdirSync(outDir, { recursive: true });

// --- Overviews (1/8 resolution) -------------------------------------------
const OV_SCALE = 8;
if (width % OV_SCALE !== 0 || height % OV_SCALE !== 0) {
  throw new Error(`grid ${width}x${height} not divisible by overview scale ${OV_SCALE}`);
}
const ovW = width / OV_SCALE;
const ovH = height / OV_SCALE;
const ovHeights = new Int16Array(ovW * ovH);
const ovSurface = new Uint8Array(ovW * ovH);
const classVotes = new Uint32Array(256);
for (let oz = 0; oz < ovH; oz++) {
  for (let ox = 0; ox < ovW; ox++) {
    let sum = 0;
    classVotes.fill(0);
    for (let dz = 0; dz < OV_SCALE; dz++) {
      const row = (oz * OV_SCALE + dz) * width + ox * OV_SCALE;
      for (let dx = 0; dx < OV_SCALE; dx++) {
        sum += heights[row + dx];
        classVotes[surface[row + dx]]++;
      }
    }
    ovHeights[oz * ovW + ox] = Math.round(sum / (OV_SCALE * OV_SCALE));
    let best = 0;
    for (let c = 1; c < 256; c++) if (classVotes[c] > classVotes[best]) best = c; // tie → lowest id
    ovSurface[oz * ovW + ox] = best;
  }
}
writeFileSync(path.join(outDir, "overview.bin"), Buffer.from(ovHeights.buffer, 0, ovHeights.byteLength));
writeFileSync(path.join(outDir, "overview-surface.bin"), Buffer.from(ovSurface));

// --- Bucket sparse deltas per tile ----------------------------------------
// SFGD entries are stored in ascending cellIndex order; iterate in file order
// so per-tile lists stay ascending by localCellIndex deterministically.
const tileDeltas = new Map(); // "ix_iz" -> array of [localIndex, deltaMm]
for (let k = 0; k < deltaCount; k++) {
  const off = 10 + k * 6;
  const cellIndex = sfgd.readUInt32LE(off);
  const deltaMm = sfgd.readUInt16LE(off + 4);
  const gx = cellIndex % width;
  const gz = (cellIndex - gx) / width;
  const ix = Math.floor(gx / tileCells);
  const iz = Math.floor(gz / tileCells);
  const cellsX = Math.min(tileCells, width - ix * tileCells);
  const lx = gx - ix * tileCells;
  const lz = gz - iz * tileCells;
  const key = `${ix}_${iz}`;
  let list = tileDeltas.get(key);
  if (!list) tileDeltas.set(key, (list = []));
  list.push([lz * cellsX + lx, deltaMm]);
}

// --- Per-tile bundles ------------------------------------------------------
const manifestTiles = {};
let minOv = Infinity, maxOv = -Infinity;
for (const v of ovHeights) { if (v < minOv) minOv = v; if (v > maxOv) maxOv = v; }

let totalBytes = 0, largest = 0, smallest = Infinity;
for (let iz = 0; iz < tilesZ; iz++) {
  for (let ix = 0; ix < tilesX; ix++) {
    const x0 = ix * tileCells;
    const z0 = iz * tileCells;
    if (x0 >= width || z0 >= height) continue; // fully out of grid
    const cellsX = Math.min(tileCells, width - x0);
    const cellsZ = Math.min(tileCells, height - z0);
    const n = cellsX * cellsZ;
    const deltas = tileDeltas.get(`${ix}_${iz}`) ?? [];
    deltas.sort((a, b) => a[0] - b[0]); // already ascending; sort for safety
    const bytes = 14 + n * 2 + n + 4 + deltas.length * 6;
    const buf = Buffer.allocUnsafe(bytes);
    buf.write("SFTT", 0, "ascii");
    buf.writeUInt16LE(1, 4);
    buf.writeUInt16LE(ix, 6);
    buf.writeUInt16LE(iz, 8);
    buf.writeUInt16LE(cellsX, 10);
    buf.writeUInt16LE(cellsZ, 12);
    let off = 14;
    for (let lz = 0; lz < cellsZ; lz++) {
      const row = (z0 + lz) * width + x0;
      for (let lx = 0; lx < cellsX; lx++) {
        buf.writeInt16LE(heights[row + lx], off);
        off += 2;
      }
    }
    for (let lz = 0; lz < cellsZ; lz++) {
      surface.copy(buf, off, (z0 + lz) * width + x0, (z0 + lz) * width + x0 + cellsX);
      off += cellsX;
    }
    buf.writeUInt32LE(deltas.length, off);
    off += 4;
    for (const [local, mm] of deltas) {
      buf.writeUInt32LE(local, off);
      buf.writeUInt16LE(mm, off + 4);
      off += 6;
    }
    if (off !== bytes) throw new Error(`tile ${ix}_${iz}: wrote ${off} of ${bytes} bytes`);
    writeFileSync(path.join(outDir, `tile_${ix}_${iz}.bin`), buf);
    manifestTiles[`${ix}_${iz}`] = { bytes };
    totalBytes += bytes;
    if (bytes > largest) largest = bytes;
    if (bytes < smallest) smallest = bytes;
  }
}

const manifest = {
  tile: tileMeters,
  tilesX,
  tilesZ,
  overview: { scale: OV_SCALE, width: ovW, height: ovH },
  tiles: manifestTiles,
};
writeFileSync(path.join(outDir, "terrain-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const tileCount = Object.keys(manifestTiles).length;
const hb = meta.terrain.heightBase, hq = meta.terrain.heightQuant;
console.log(
  `bake-terrain-tiles: ${tileCount} tiles, ${totalBytes} tile bytes ` +
    `(largest ${largest}, smallest ${smallest}); overview ${ovW}x${ovH} ` +
    `(${ovHeights.byteLength} B heights, ${ovSurface.byteLength} B surface), ` +
    `overview height range ${(hb + minOv * hq).toFixed(2)}..${(hb + maxOv * hq).toFixed(2)} m; ` +
    `${deltaCount} groundtop deltas distributed`
);
