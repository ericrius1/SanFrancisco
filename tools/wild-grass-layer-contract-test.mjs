// CPU-side contract for the additive wild-grass field: pointed microblade
// geometry, deterministic streamed tiles, stable mesh identity, close density,
// 110m reach, and a bounded submitted-geometry/draw envelope.
// Run: node tools/wild-grass-layer-contract-test.mjs

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.SF_WILD_GRASS_BUNDLED !== "1") {
  const { build } = await import("esbuild");
  const output = fileURLToPath(new URL("../.data/wild-grass-layer-test/contract.mjs", import.meta.url));
  mkdirSync(fileURLToPath(new URL("../.data/wild-grass-layer-test/", import.meta.url)), { recursive: true });
  await build({
    entryPoints: [fileURLToPath(import.meta.url)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    define: { "process.env.SF_WILD_GRASS_BUNDLED": '"1"' },
    logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [output], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key)
};

const {
  WILD_GRASS_LAYER_SPECS,
  WILD_GRASS_RING_RADIUS,
  createWildGrass,
  wildGrassBladeDensityAt,
  wildGrassLayerTriangles,
  wildGrassLayersAt
} = await import("../src/world/wildlands/grassField.ts");
const { createMicroBladeClusterGeometry } = await import("../src/world/groundcover/bladeGrass.ts");
const {
  createGroundcoverPreparationRegistry,
  prepareGroundcoverRootPipelines
} = await import("../src/world/wildlands/index.ts");
const THREE = await import("three/webgpu");

assert.equal(WILD_GRASS_RING_RADIUS, 110, "far field must reach 110m");
assert.deepEqual(wildGrassLayersAt(0), ["far", "mid", "near", "hero"]);
assert.deepEqual(wildGrassLayersAt(20), ["far", "mid", "near"]);
assert.deepEqual(wildGrassLayersAt(40), ["far", "mid"]);
assert.deepEqual(wildGrassLayersAt(90), ["far"]);
assert.deepEqual(wildGrassLayersAt(111), []);
assert(
  wildGrassBladeDensityAt(0) >= 23,
  `close field must exceed 23 blade strips/m², got ${wildGrassBladeDensityAt(0)}`
);

for (const [name, spec] of Object.entries(WILD_GRASS_LAYER_SPECS)) {
  assert(spec.fadeBand >= 8, `${name} fade must be a broad rank-staggered band`);
  assert(spec.visibleRadius > spec.fadeBand, `${name} must have a fully populated interior`);
  assert(spec.tileSize >= 28, `${name} tile must remain coarse enough for bounded draws`);
  if (spec.geometry.kind !== "micro") continue;
  const geometry = createMicroBladeClusterGeometry(spec.geometry);
  assert.equal(
    (geometry.index?.count ?? geometry.getAttribute("position").count) / 3,
    spec.geometry.blades,
    `${name} micro geometry must submit one triangle per blade`
  );
  assert.equal(geometry.getAttribute("position").count, spec.geometry.blades * 3);
  const ranks = geometry.getAttribute("aGrassBladeRank");
  for (let i = 0; i < ranks.count; i += 3) {
    assert(ranks.getX(i) > 0 && ranks.getX(i) < 1, `${name} blade rank must stay inside (0,1)`);
    assert.equal(ranks.getX(i), ranks.getX(i + 1), `${name} rank must be constant across a blade`);
    assert.equal(ranks.getX(i), ranks.getX(i + 2), `${name} rank must be constant across a blade`);
  }
  geometry.dispose();
}

const FOCUS = { x: -4000, z: 2440 };
const scheduledGrassJobs = [];
const scheduleGrass = (job) => scheduledGrassJobs.push(job);
const drainGrass = () => {
  let turns = 0;
  while (scheduledGrassJobs.length > 0) {
    const job = scheduledGrassJobs.shift();
    if (job() === "again") scheduledGrassJobs.push(job);
    assert(++turns < 100_000, "progressive grass jobs must settle");
  }
};
const grass = createWildGrass({
  groundHeight: () => 75,
  surfaceType: () => 1,
  isWater: () => false
}, undefined, { schedule: scheduleGrass });
grass.update(FOCUS);
drainGrass();

const initial = grass.stats;
for (const name of ["far", "mid", "near", "hero"]) {
  const layer = initial.layers[name];
  assert(layer.count > 0, `${name} layer must populate in the flat GG Park fixture`);
  assert(layer.draws > 0, `${name} layer must own at least one draw`);
  assert.equal(layer.trianglesPerCluster, wildGrassLayerTriangles(WILD_GRASS_LAYER_SPECS[name]));
  assert.equal(layer.submittedTriangles, layer.count * layer.trianglesPerCluster);
}
assert(initial.draws <= 52, `resident grass draws must remain near the legacy envelope, got ${initial.draws}`);
assert(
  initial.submittedTriangles <= 575_000,
  `submitted grass triangles must remain near the legacy high-end envelope, got ${initial.submittedTriangles}`
);
assert(initial.count * 36 < 6 * 1024 * 1024, "compact live instance payload must stay below 6MiB");

const populated = grass.group.children.filter((child) => child.geometry?.instanceCount > 0);
assert.equal(populated.length, initial.draws, "each non-empty layer tile should be exactly one draw");
for (const mesh of populated) {
  assert(/^wildlands_grass_(far|mid|near|hero)_/.test(mesh.name), `${mesh.name} must expose its additive layer`);
  assert.equal(mesh.frustumCulled, true, `${mesh.name} must participate in frustum culling`);
  assert.equal(mesh.isInstancedMesh, undefined, `${mesh.name} must retain compact InstancedBufferGeometry rendering`);
  const attributes = ["aGrassTransform", "aGrassShape", "aGrassColor"]
    .map((attributeName) => mesh.geometry.getAttribute(attributeName));
  const bytes = attributes.reduce(
    (sum, attribute) => sum + attribute.itemSize * attribute.array.BYTES_PER_ELEMENT,
    0
  );
  assert.equal(bytes, 36, `${mesh.name} must retain the compact 36-byte instance payload`);
}

// Pipeline preparation is allowed to force an otherwise hidden root visible
// only while that root is detached. It must restore both master visibility and
// parent/sibling order before resolving.
const preparationRegistry = createGroundcoverPreparationRegistry();
const foliageParent = new THREE.Group();
const beforeSibling = new THREE.Group();
const afterSibling = new THREE.Group();
foliageParent.add(beforeSibling, grass.group, afterSibling);
grass.group.visible = false;
let observedDetachedCompile = false;
await prepareGroundcoverRootPipelines(
  grass.group,
  populated,
  async (root) => {
    observedDetachedCompile = true;
    assert.equal(root.parent, null, "hidden root must compile while detached from the live scene");
    assert.equal(root.visible, true, "detached root must be traversable during compile");
  },
  preparationRegistry
);
assert(observedDetachedCompile, "the first populated ring must warm its pipelines");
assert.equal(grass.group.parent, foliageParent, "prepared root must return to its original parent");
assert.equal(grass.group.visible, false, "prepared root must preserve the master foliage toggle");
assert.deepEqual(
  foliageParent.children,
  [beforeSibling, grass.group, afterSibling],
  "prepared root must return at its original sibling position"
);
grass.group.visible = true;

const firstMesh = populated.find((mesh) => mesh.geometry.getAttribute("aGrassColor").count > 8);
assert(firstMesh, "fixture needs one populated mesh for rank inspection");
const rankBytes = firstMesh.geometry.getAttribute("aGrassColor").array;
const observedRanks = new Set();
for (let i = 3; i < Math.min(rankBytes.length, 4 * 128); i += 4) observedRanks.add(rankBytes[i]);
assert(observedRanks.size > 16, "instance alpha byte must contain varied deterministic fade ranks");
assert(!observedRanks.has(0) && !observedRanks.has(255), "fade ranks must stay strictly inside (0,255)");

// Below the 6m stream step, only focus uniforms move; every tile object stays.
const beforeSmallMove = new Map(grass.group.children.map((mesh) => [mesh.name, mesh]));
grass.update({ x: FOCUS.x + 3, z: FOCUS.z + 1 });
drainGrass();
assert.equal(grass.group.children.length, beforeSmallMove.size);
for (const mesh of grass.group.children) assert.equal(mesh, beforeSmallMove.get(mesh.name));

// Crossing the stream step may add/remove only entering/exiting tiles. Shared
// world tiles retain object identity: there is no distance-band LOD replacement.
grass.update({ x: FOCUS.x + 8, z: FOCUS.z + 1 });
drainGrass();
let stableSharedTiles = 0;
for (const mesh of grass.group.children) {
  const previous = beforeSmallMove.get(mesh.name);
  if (!previous) continue;
  assert.equal(mesh, previous, `${mesh.name} must not be replaced when focus crosses a layer band`);
  stableSharedTiles++;
}
assert(stableSharedTiles > initial.draws * 0.6, "most shared streamed tiles should retain identity");

// A real stream shift creates fresh mesh/buffer objects. Because each entering
// tile reuses a warmed layer material + vertex layout, the reveal gate must
// admit it immediately instead of launching another compile-and-reveal job.
const beforeStreamShift = new Set(grass.group.children);
grass.update({ x: FOCUS.x + 40, z: FOCUS.z + 1 });
drainGrass();
const enteringTiles = grass.group.children.filter((mesh) => !beforeStreamShift.has(mesh));
assert(enteringTiles.length > 0, "fixture must stream at least one fresh grass tile");
for (const mesh of enteringTiles) {
  assert(
    preparationRegistry.has(mesh),
    `${mesh.name} must inherit the already-warmed pipeline/layout for its grass layer`
  );
}

grass.dispose();
assert.equal(grass.group.children.length, 0, "dispose must release every additive layer tile");

console.log("wild grass additive layer contract: ok", JSON.stringify({
  reach: WILD_GRASS_RING_RADIUS,
  closeBladesPerM2: +wildGrassBladeDensityAt(0).toFixed(2),
  draws: initial.draws,
  instances: initial.count,
  submittedTriangles: initial.submittedTriangles,
  instanceMiB: +((initial.count * 36) / (1024 * 1024)).toFixed(2),
  layers: initial.layers
}));
