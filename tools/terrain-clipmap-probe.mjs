import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TERRAIN_CLIPMAP_CENTER_SNAP,
  TERRAIN_CLIPMAP_GRID_CELLS,
  createTerrainClipmapLayout,
  terrainClipmapCenter,
  terrainClipmapTriangleCount,
  terrainClipmapVertexCount
} from "../src/world/terrainClipmapLayout.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const layout = createTerrainClipmapLayout();

assert.equal(layout.length, 7, "clipmap must retain seven nested levels");
assert.equal(layout.flatMap((level) => level.patches).length, 28, "clipmap patch count changed");
assert.equal(terrainClipmapTriangleCount(layout), 180_224, "clipmap triangle budget changed");
assert.equal(terrainClipmapVertexCount(layout), 93_724, "clipmap vertex budget changed");
assert.equal(layout[0].spacing, 1, "near terrain is no longer one-metre geometry");
assert.equal(layout.at(-1).halfExtent, 4096, "clipmap coverage radius changed");

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
