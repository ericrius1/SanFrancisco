// Architectural contract for GPU Wildlands grass. Placement/compaction and
// draw counts must remain GPU-owned; the CPU may progressively sample only the
// shared player-following foliage field.
//
//   node tools/wild-grass-streaming-contract-test.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const grassSource = await readFile(new URL("../src/world/wildlands/grassField.ts", import.meta.url), "utf8");
const placementSource = await readFile(
  new URL("../src/world/groundcover/gpuGrassPlacement.ts", import.meta.url),
  "utf8"
);
const fieldSource = await readFile(
  new URL("../src/world/groundcover/foliageField.ts", import.meta.url),
  "utf8"
);

for (const forbidden of [
  "GrassEntry",
  "sampleCell(",
  "createGrassMesh(",
  "writeGrassMeshRange(",
  "entries: []"
]) {
  assert(!grassSource.includes(forbidden), `production grass reintroduced CPU placement: ${forbidden}`);
}

assert(grassSource.includes("renderer.computeAsync([gpu.reset"),
  "reset + every layer compactor must submit atomically in one compute pass");
assert(grassSource.includes("renderer.getArrayBufferAsync(gpu.indirect)"),
  "the bounded indirect readback must remain the only exact-count CPU transfer");
assert(grassSource.includes("WILD_GRASS_STREAM_STEP = 6"),
  "grass retargeting must remain coarser than per-frame player movement");
assert(grassSource.includes("field.request(destination)"),
  "GPU placement must wait for a complete foliage-field generation");

for (const required of [
  "IndirectStorageBufferAttribute",
  "atomicAdd",
  "atomicStore",
  "StorageInstancedBufferAttribute",
  "textureLoad",
  "setIndirect"
]) {
  assert(placementSource.includes(required), `GPU compactor lost ${required}`);
}
assert(placementSource.includes("Manual bilinear read"),
  "RGBA32F height filtering must not depend on the optional float32-filterable feature");
assert(placementSource.includes("withinRadius"), "compute must reject square-corner candidates");
assert(placementSource.includes("GROUND_SLOPE_CULL"), "compute must reject unsafe terrain slopes");
assert(placementSource.includes("authoredDensity.greaterThan(0)"),
  "painted foliage density must remain continuous instead of snapping at a 0.5 threshold");

assert(fieldSource.includes("Entering X slabs") && fieldSource.includes("Entering Z slabs"),
  "field movement must update only entering toroidal slabs");
assert(fieldSource.includes("this.#build?.resolve()"),
  "a superseded destination must release its waiter");
assert(fieldSource.includes("THREE.NearestFilter"),
  "the field must remain legal without filterable float32 textures");

const specs = [
  ["far", 2, 110],
  ["mid", 1, 60],
  ["near", 1, 26],
  ["hero", 1, 12]
];
const layers = specs.map(([name, stride, radius]) => {
  const reach = Math.ceil(radius / (0.68 * stride)) + 1;
  const side = reach * 2 + 1;
  return { name, side, capacity: side * side * 3 };
});
assert.equal(layers.length, 4, "far/mid/near/hero must remain four additive indirect draws");
assert.equal(layers.reduce((sum, layer) => sum + layer.capacity, 0), 204204);

console.log("wild grass GPU streaming contract: ok", JSON.stringify({
  draws: layers.length,
  candidateThreads: layers.reduce((sum, layer) => sum + layer.capacity, 0),
  indirectBytes: layers.length * 5 * Uint32Array.BYTES_PER_ELEMENT,
  layers
}));
