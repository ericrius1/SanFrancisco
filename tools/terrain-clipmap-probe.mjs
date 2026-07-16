import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TERRAIN_CLIPMAP_CENTER_SNAP,
  TERRAIN_CLIPMAP_GRID_CELLS,
  createTerrainClipmapLayout,
  createTerrainClipmapSourceGridCenter,
  terrainClipmapCenter,
  terrainClipmapTriangleCount,
  terrainClipmapVertexCount
} from "../src/world/terrainClipmapLayout.ts";
import {
  createTerrainDetailTextureData,
  createTerrainNormalMipData,
  createTerrainSurfaceMipData
} from "../src/world/terrainMaterialData.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const layout = createTerrainClipmapLayout();
const sourceGridCenter = createTerrainClipmapSourceGridCenter();

const ramp = new Float32Array(25);
for (let z = 0; z < 5; z++) {
  for (let x = 0; x < 5; x++) ramp[z * 5 + x] = x * 4 + z * 2;
}
const normalMip = createTerrainNormalMipData(ramp, 5, 5, 8, 2).mipmaps[0];
const normalOffset = (2 * 5 + 2) * 2;
const normalX = normalMip.data[normalOffset] / 255 * 2 - 1;
const normalZ = normalMip.data[normalOffset + 1] / 255 * 2 - 1;
const normalY = Math.sqrt(Math.max(0, 1 - normalX ** 2 - normalZ ** 2));
assert(Math.abs(normalX + 0.436) < 0.015, `filtered normal X is ${normalX}`);
assert(Math.abs(normalY - 0.873) < 0.015, `filtered normal Y is ${normalY}`);
assert(Math.abs(normalZ + 0.218) < 0.015, `filtered normal Z is ${normalZ}`);

const surfaceMip = createTerrainSurfaceMipData(new Uint8Array([1, 1, 0]), 3, 1, 1).mipmaps[0];
const surfaceOffset = 4;
assert(surfaceMip.data[surfaceOffset] > 0, "surface feather lost the adjacent developed class");
assert(surfaceMip.data[surfaceOffset + 1] > 0, "surface feather lost the dominant grass class");
assert(
  Math.abs(surfaceMip.data[surfaceOffset] + surfaceMip.data[surfaceOffset + 1] - 255) <= 1,
  "surface feather weights no longer normalize"
);

const detailA = createTerrainDetailTextureData();
const detailB = createTerrainDetailTextureData();
assert.deepEqual(detailA, detailB, "terrain detail generation is not deterministic");
let macroNeighborDelta = 0;
for (let y = 0; y < 256; y++) {
  for (let x = 0; x < 256; x++) {
    const here = detailA[(y * 256 + x) * 2];
    const right = detailA[(y * 256 + ((x + 1) % 256)) * 2];
    macroNeighborDelta += Math.abs(here - right);
  }
}
macroNeighborDelta /= 256 * 256;
assert(macroNeighborDelta < 8, `macro field is still hash-cell noisy (${macroNeighborDelta.toFixed(2)})`);

assert.equal(layout.length, 7, "clipmap must retain seven nested levels");
assert.equal(layout.flatMap((level) => level.patches).length, 28, "clipmap patch count changed");
assert.equal(terrainClipmapTriangleCount(layout), 180_224, "clipmap triangle budget changed");
assert.equal(terrainClipmapVertexCount(layout), 93_724, "clipmap vertex budget changed");
assert.equal(layout[0].spacing, 1, "near terrain is no longer one-metre geometry");
assert.equal(layout.at(-1).halfExtent, 4096, "clipmap coverage radius changed");
assert.equal(sourceGridCenter.spacing, 8, "comparison centre must use the source lattice");
assert.equal(sourceGridCenter.halfExtent, layout[3].halfExtent, "comparison centre must fill the 8 m ring");
assert.equal(sourceGridCenter.triangles, 32_768, "comparison centre triangle budget changed");

for (const level of layout) {
  const occupied = new Set();
  let cells = 0;
  for (const patch of level.patches) {
    const minX = patch.offsetCellsX - patch.widthCells / 2;
    const minZ = patch.offsetCellsZ - patch.depthCells / 2;
    for (let z = minZ; z < minZ + patch.depthCells; z++) {
      for (let x = minX; x < minX + patch.widthCells; x++) {
        const key = `${x},${z}`;
        assert(!occupied.has(key), `level ${level.level} overlaps at ${key}`);
        occupied.add(key);
        cells++;
      }
    }
  }
  const expectedCells = level.level === 0
    ? TERRAIN_CLIPMAP_GRID_CELLS ** 2
    : TERRAIN_CLIPMAP_GRID_CELLS ** 2 - (TERRAIN_CLIPMAP_GRID_CELLS / 2) ** 2;
  assert.equal(cells, expectedCells, `level ${level.level} has a gap or overlap`);
  if (level.level > 0) {
    const holeHalfExtent = (TERRAIN_CLIPMAP_GRID_CELLS / 4) * level.spacing;
    assert.equal(
      holeHalfExtent,
      layout[level.level - 1].halfExtent,
      `level ${level.level} hole does not meet its child ring`
    );
  }
}

for (let value = -10_000; value <= 10_000; value += 0.25) {
  const center = terrainClipmapCenter(value);
  assert(center % TERRAIN_CLIPMAP_CENTER_SNAP === 0, "clipmap centre left its stable source phase");
  assert(Math.abs(center - value) <= TERRAIN_CLIPMAP_CENTER_SNAP / 2, "clipmap snap moved too far");
}

const meta = JSON.parse(await readFile(path.join(ROOT, "public/data/meta.json"), "utf8"));
const heightBuffer = await readFile(path.join(ROOT, "public/data/heightmap.bin"));
const encoded = new Int16Array(
  heightBuffer.buffer,
  heightBuffer.byteOffset,
  heightBuffer.byteLength / Int16Array.BYTES_PER_ELEMENT
);
assert.equal(encoded.length, meta.grid.width * meta.grid.height, "heightmap dimensions do not match metadata");
assert.equal(meta.grid.cellSize, 8, "clipmap source assumptions require the canonical 8 m lattice");

let encodedMin = Infinity;
let encodedMax = -Infinity;
for (const value of encoded) {
  encodedMin = Math.min(encodedMin, value);
  encodedMax = Math.max(encodedMax, value);
}
const sourceMin = meta.terrain.heightBase + encodedMin * meta.terrain.heightQuant;
const sourceMax = meta.terrain.heightBase + encodedMax * meta.terrain.heightQuant;
const textureMin = Math.floor(sourceMin) - 1;
const textureRange = Math.ceil(sourceMax) + 1 - textureMin;
let maxTextureError = 0;
for (let i = 0; i < encoded.length; i++) {
  const source = meta.terrain.heightBase + encoded[i] * meta.terrain.heightQuant;
  const quantized = Math.round(((source - textureMin) / textureRange) * 65535);
  const decoded = textureMin + (quantized / 65535) * textureRange;
  maxTextureError = Math.max(maxTextureError, Math.abs(decoded - source));
}
assert(maxTextureError < 0.01, `RG8 height pyramid adds ${maxTextureError.toFixed(4)} m of source error`);

// The runtime stores each 16-bit value as filterable RG8 high/low bytes. Since
// decoding is linear, filtering the channels must equal filtering the original
// scalar even at a byte carry (255 -> 256).
for (const [a, b] of [[0, 65535], [255, 256], [4095, 4096], [32767, 32768]]) {
  for (const t of [0, 0.17, 0.5, 0.83, 1]) {
    const ar = (a >>> 8) / 255;
    const ag = (a & 255) / 255;
    const br = (b >>> 8) / 255;
    const bg = (b & 255) / 255;
    const decodedFiltered = (
      (ar * (1 - t) + br * t) * 255 * 256 +
      (ag * (1 - t) + bg * t) * 255
    ) / 65535;
    const filteredScalar = (a * (1 - t) + b * t) / 65535;
    assert(Math.abs(decodedFiltered - filteredScalar) < 1e-12, "RG8 height filtering lost scalar linearity");
  }
}

console.log(JSON.stringify({
  ok: true,
  levels: layout.length,
  patches: layout.flatMap((level) => level.patches).length,
  vertices: terrainClipmapVertexCount(layout),
  triangles: terrainClipmapTriangleCount(layout),
  nearSpacing: layout[0].spacing,
  coverageRadius: layout.at(-1).halfExtent,
  sourceGrid: `${meta.grid.width}x${meta.grid.height}@${meta.grid.cellSize}m`,
  maxHeightTextureErrorMeters: Number(maxTextureError.toFixed(6))
}, null, 2));
