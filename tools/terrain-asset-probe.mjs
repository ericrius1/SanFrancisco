// Audits every committed terrain GLB after the Blender + meshopt bake.
// Validates full 8 m coverage, canonical height parity, smooth top-normal sharing,
// and cross-chunk normal continuity while reporting shipped geometry/byte totals.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TILE_DIR = path.join(ROOT, "public/tiles");
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "public/data/meta.json"), "utf8"));
const heightBytes = fs.readFileSync(path.join(ROOT, "public/data/heightmap.bin"));
const heights = new Int16Array(
  heightBytes.buffer,
  heightBytes.byteOffset,
  heightBytes.byteLength / Int16Array.BYTES_PER_ELEMENT
);
const { width, height, cellSize, minX, minZ } = meta.grid;
const { heightBase, heightQuant, heightProcessVersion } = meta.terrain;
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
assert(heightProcessVersion === 1, `terrain height process marker is ${heightProcessVersion}, expected 1`);
assert(heights.length === width * height, "heightmap size does not match meta grid");

const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });

function normalized(value, componentType) {
  if (componentType === 5120) return Math.max(-1, value / 127);
  if (componentType === 5121) return value / 255;
  if (componentType === 5122) return Math.max(-1, value / 32767);
  if (componentType === 5123) return value / 65535;
  return value;
}

const files = fs.readdirSync(TILE_DIR).filter((name) => /^terrain_\d+_\d+\.glb$/.test(name)).sort();
assert(files.length === 25, `expected 25 terrain chunks, found ${files.length}`);

let bytes = 0;
let vertices = 0;
let triangles = 0;
let maxHeightError = 0;
let samePositionNormalSplits = 0;
const globalTopNormals = new Map();

for (const name of files) {
  const file = path.join(TILE_DIR, name);
  bytes += fs.statSync(file).size;
  const doc = await io.read(file);
  const nodes = doc.getRoot().listNodes().filter((node) => node.getMesh());
  assert(nodes.length === 1, `${name}: expected one mesh node, found ${nodes.length}`);
  const node = nodes[0];
  const translation = node.getTranslation();
  const scale = node.getScale();
  const mesh = node.getMesh();
  assert(mesh.listPrimitives().length === 1, `${name}: expected one primitive`);
  const primitive = mesh.listPrimitives()[0];
  const position = primitive.getAttribute("POSITION");
  const normal = primitive.getAttribute("NORMAL");
  const color = primitive.getAttribute("COLOR_0");
  const indices = primitive.getIndices();
  assert(position && normal && color && indices, `${name}: missing POSITION/NORMAL/COLOR_0/indices`);
  assert(position.getCount() === normal.getCount(), `${name}: normal count mismatch`);
  vertices += position.getCount();
  triangles += indices.getCount() / 3;

  const pa = position.getArray();
  const na = normal.getArray();
  const pc = position.getComponentType();
  const nc = normal.getComponentType();
  const localTopNormals = new Map();
  for (let i = 0; i < position.getCount(); i++) {
    const x = translation[0] + scale[0] * normalized(pa[i * 3], pc);
    const y = translation[1] + scale[1] * normalized(pa[i * 3 + 1], pc);
    const z = translation[2] + scale[2] * normalized(pa[i * 3 + 2], pc);
    const nx = normalized(na[i * 3], nc);
    const ny = normalized(na[i * 3 + 1], nc);
    const nz = normalized(na[i * 3 + 2], nc);
    // Hard vertical skirts have near-zero Y normal. Every terrain-top normal has
    // a positive Y component, including steep driveable hills.
    if (ny <= 0.01) continue;

    const gx = Math.min(width - 1, Math.max(0, Math.round((x - minX) / cellSize)));
    const gz = Math.min(height - 1, Math.max(0, Math.round((z - minZ) / cellSize)));
    const expectedY = heightBase + heights[gz * width + gx] * heightQuant;
    maxHeightError = Math.max(maxHeightError, Math.abs(y - expectedY));

    // Grid spacing is 8 m, so decimetre world keys safely coalesce only the same
    // quantized boundary vertex across chunks/material splits.
    const pointKey = `${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}`;
    const normalKey = `${Math.round(nx * 127)},${Math.round(ny * 127)},${Math.round(nz * 127)}`;
    let local = localTopNormals.get(pointKey);
    if (!local) localTopNormals.set(pointKey, (local = new Set()));
    local.add(normalKey);
    let global = globalTopNormals.get(pointKey);
    if (!global) globalTopNormals.set(pointKey, (global = new Map()));
    let sources = global.get(normalKey);
    if (!sources) global.set(normalKey, (sources = new Set()));
    sources.add(name);
  }
  for (const normals of localTopNormals.values()) if (normals.size > 1) samePositionNormalSplits++;
}

const seamMismatchExamples = [];
let maxSeamNormalAngle = 0;
for (const [point, normals] of globalTopNormals) {
  if (normals.size <= 1) continue;
  const vectors = [...normals.keys()].map((key) => {
    const [x, y, z] = key.split(",").map(Number);
    const length = Math.hypot(x, y, z) || 1;
    return [x / length, y / length, z / length];
  });
  for (let i = 0; i < vectors.length; i++) for (let j = i + 1; j < vectors.length; j++) {
    const dot = Math.max(-1, Math.min(1,
      vectors[i][0] * vectors[j][0] + vectors[i][1] * vectors[j][1] + vectors[i][2] * vectors[j][2]
    ));
    maxSeamNormalAngle = Math.max(maxSeamNormalAngle, Math.acos(dot) * 180 / Math.PI);
  }
  if (seamMismatchExamples.length < 8) {
    seamMismatchExamples.push({
      point,
      normals: [...normals].map(([normal, sources]) => ({ normal, sources: [...sources] }))
    });
  }
}
const seamNormalMismatches = [...globalTopNormals.values()].filter((normals) => normals.size > 1).length;
const expectedTopTriangles = 2 * (width - 1) * (height - 1);
assert(triangles >= expectedTopTriangles, `terrain has ${triangles} triangles, below full 8 m top ${expectedTopTriangles}`);
assert(maxHeightError <= 0.06, `visual/runtime terrain differs by up to ${maxHeightError.toFixed(4)} m`);
assert(samePositionNormalSplits === 0, `${samePositionNormalSplits} in-chunk top positions have split normals`);
// Blender/export quantizes normals independently per GLB, so a shared source
// normal can land one or two int8 units apart. Bound the actual angle instead of
// requiring byte identity; the observed isolated deltas remain below 1.5°.
assert(
  maxSeamNormalAngle <= 1.5,
  `cross-chunk normal delta reached ${maxSeamNormalAngle.toFixed(3)}°: ${JSON.stringify(seamMismatchExamples)}`
);

console.log(JSON.stringify({
  ok: true,
  chunks: files.length,
  bytes,
  mebibytes: Number((bytes / 1048576).toFixed(2)),
  vertices,
  triangles,
  expectedTopTriangles,
  skirtTriangles: triangles - expectedTopTriangles,
  maxHeightError: Number(maxHeightError.toFixed(4)),
  samePositionNormalSplits,
  seamNormalMismatches,
  maxSeamNormalAngle: Number(maxSeamNormalAngle.toFixed(4))
}, null, 2));
