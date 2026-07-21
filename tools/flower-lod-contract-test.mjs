// CPU-side contract for the wildflower geometry ladder, footprint grounding,
// bounded sector meshes, and reserved instance memory.
// Run: node tools/flower-lod-contract-test.mjs

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Node's type stripping intentionally does not resolve the app's bundler-style
// extensionless TypeScript imports. Self-bundle this fixture with the project's
// esbuild first, then execute the isolated output. The define folds this branch
// out of the bundle, so the test body runs exactly once.
if (process.env.SF_FLOWER_LOD_BUNDLED !== "1") {
  const { build } = await import("esbuild");
  const output = fileURLToPath(new URL("../.data/flower-lod-test/contract.mjs", import.meta.url));
  mkdirSync(fileURLToPath(new URL("../.data/flower-lod-test/", import.meta.url)), { recursive: true });
  await build({
    entryPoints: [fileURLToPath(import.meta.url)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    define: { "process.env.SF_FLOWER_LOD_BUNDLED": '"1"' },
    logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [output], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

// Config persistence is browser-owned. A tiny deterministic store keeps this
// module test independent from a developer's saved Tweakpane values.
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key)
};

const {
  createFlowerRing,
  flowerEdgeFadeWindow,
  FLOWER_EDGE_FADE_BAND_METRES,
  FLOWER_EDGE_STAGGER_METRES
} = await import("../src/world/wildlands/flowerRing.ts");
const {
  FLOWER_REACH_DEFAULT,
  FLOWER_REACH_MAX,
  FLOWER_REACH_MIN,
  FLOWER_TUNING
} = await import("../src/config.ts");

const FOCUS = { x: -4000, z: 2440 };
const groundHeight = (x, z) => 75 + (x - FOCUS.x) * 0.22 + (z - FOCUS.z) * 0.12;
const flowers = createFlowerRing({
  groundHeight,
  surfaceType: () => 1,
  isWater: () => false
});
flowers.update(FOCUS);

const stats = flowers.stats;
const LEGACY_DEFAULT_CLUMPS = 5337;
const LEGACY_DEFAULT_TRIANGLES = 538116;
const LEGACY_DEFAULT_DRAWS = 32;
const LEGACY_RESERVED_INSTANCE_BYTES = 3_344_384;
assert.equal(FLOWER_REACH_DEFAULT, 1100, "default flower reach should be 10x the former 110 m ring");
assert.equal(FLOWER_TUNING.values.reach, FLOWER_REACH_DEFAULT, "flower tuning should start at the 1.1 km reach");
assert.equal(stats.reach, FLOWER_REACH_DEFAULT, "runtime reach must follow the Tweakpane value");
assert(stats.count > 100, `expected populated test meadow, got ${stats.count}`);
assert(stats.count > LEGACY_DEFAULT_CLUMPS, "110 m reach should populate more of the meadow than the former 80 m ring");
assert(stats.lodInstances.hero > 0, "hero flower LOD must populate");
assert(stats.lodInstances.mid > 0, "mid flower LOD must populate");
assert(stats.lodInstances.far > 0, "far flower LOD must populate");
assert.equal(stats.droppedByCapacity, 0, "default meadow must not overflow a flower bucket");

for (let species = 0; species < stats.trianglesPerClump.length; species++) {
  const hero = stats.trianglesPerClumpByLod.hero[species];
  const mid = stats.trianglesPerClumpByLod.mid[species];
  assert(mid < hero * 0.5, `species ${species} mid LOD should remove at least half its triangles (${hero} -> ${mid})`);
}
assert(
  stats.trianglesPerClumpByLod.far < Math.min(...stats.trianglesPerClumpByLod.hero) * 0.15,
  "far accent must stay below 15% of the cheapest hero clump"
);
assert.equal(stats.trianglesPerClumpByLod.far, 6, "far flowers should use the six-triangle crossed accent");
// The default density rose 1 → 1.4 when per-frame GPU frustum culling landed:
// `submittedTriangles` is now the LIVE envelope, of which the cull pass
// rasterizes only the in-view fraction (~30-40%; tools/grass-cull-probe.mjs
// verifies the real drawn counts). Guard the geometry ladder like-for-like at
// density 1 below; here just bound the live envelope against the density knob.
const defaultDensity = FLOWER_TUNING.values.density;
assert(
  stats.submittedTriangles <= LEGACY_DEFAULT_TRIANGLES * Math.max(1, defaultDensity),
  `default ring live envelope exceeds density-scaled budget (${stats.submittedTriangles} <= ${LEGACY_DEFAULT_TRIANGLES} * ${defaultDensity})`
);
assert(
  stats.draws <= LEGACY_DEFAULT_DRAWS,
  `extended default ring should not add flower draws (${stats.draws} <= ${LEGACY_DEFAULT_DRAWS})`
);
const tunedDensity = FLOWER_TUNING.values.density;
FLOWER_TUNING.values.density = 1;
flowers.refresh();
// The 10x reach adds only six-triangle far accents beyond the legacy 110 m
// field. Keep that new horizon inside a narrow 3% live-geometry allowance.
const EXTENDED_REACH_TRIANGLE_BUDGET = Math.ceil(LEGACY_DEFAULT_TRIANGLES * 1.03);
assert(
  flowers.stats.submittedTriangles <= EXTENDED_REACH_TRIANGLE_BUDGET,
  `density-1 extended ring must stay near the former triangle envelope (${flowers.stats.submittedTriangles} <= ${EXTENDED_REACH_TRIANGLE_BUDGET})`
);
FLOWER_TUNING.values.density = tunedDensity;
flowers.refresh();
assert(
  stats.reservedInstanceBytes <= LEGACY_RESERVED_INSTANCE_BYTES,
  `extended default ring should not reserve more instance memory (${stats.reservedInstanceBytes} <= ${LEGACY_RESERVED_INSTANCE_BYTES})`
);

const edgeWindows = Array.from({ length: 128 }, (_, index) =>
  flowerEdgeFadeWindow(FLOWER_TUNING.values.reach, (index / 128) * Math.PI * 2)
);
const repeatedEdgeWindows = Array.from({ length: 128 }, (_, index) =>
  flowerEdgeFadeWindow(FLOWER_TUNING.values.reach, (index / 128) * Math.PI * 2)
);
assert.deepEqual(edgeWindows, repeatedEdgeWindows, "edge staggering must be deterministic");
assert(
  edgeWindows.every((window) => Math.abs(window.end - window.start - FLOWER_EDGE_FADE_BAND_METRES) < 1e-9),
  "every flower should traverse the complete broad fade band"
);
const earliestEdgeEnd = Math.min(...edgeWindows.map((window) => window.end));
const latestEdgeEnd = Math.max(...edgeWindows.map((window) => window.end));
assert(
  latestEdgeEnd - earliestEdgeEnd > FLOWER_EDGE_STAGGER_METRES * 0.98,
  "yaw phases should distribute outer fade endpoints across the stagger band"
);
assert(latestEdgeEnd <= FLOWER_TUNING.values.reach + 1e-9, "no staggered flower may exceed configured reach");

const legacyCapacityPerSpecies = Math.ceil(((119 * 2) / 1.6) ** 2 * 0.5);
const legacyReservedBytes = legacyCapacityPerSpecies * 4 * (16 + 3 + 4) * Float32Array.BYTES_PER_ELEMENT;
assert(
  stats.reservedInstanceBytes < legacyReservedBytes,
  `LOD buckets should reserve less instance memory (${stats.reservedInstanceBytes} < ${legacyReservedBytes})`
);

// GPU per-instance frustum culling replaced the old CPU sector meshes: each
// populated bucket submits one indirect draw whose count is written by the
// per-frame cull compute, so CPU frustum culling stays off and the geometry
// carries a conservative whole-ring bound.
const populatedMeshes = flowers.group.children.filter(
  (child) => child.isMesh && (child.userData.flowerCount ?? 0) > 0
);
assert(populatedMeshes.length >= 5, "hero species + mid + far buckets should populate the test meadow");
for (const mesh of populatedMeshes) {
  assert.equal(mesh.frustumCulled, false, `${mesh.name} visibility is owned by the GPU per-instance cull`);
  assert(mesh.geometry.boundingSphere, `${mesh.name} must have an explicit conservative bound`);
  assert(
    Number.isFinite(mesh.geometry.boundingSphere.radius) && mesh.geometry.boundingSphere.radius > 0,
    `${mesh.name} bound must be finite`
  );
  const indirect = mesh.geometry.getIndirect?.() ?? mesh.geometry.indirect ?? null;
  assert(indirect, `${mesh.name} must draw through the shared indirect buffer`);
}

// The centre sample is never lower than the minimum of a sloped footprint. Every
// hero anchor must therefore be at least ROOT_SINK below its centre ground; this
// catches a regression back to map.groundHeight(px,pz) centre-only seating.
// Anchors live in the shared packed data0 storage plane now.
const flowerData0 = flowers.group.userData.flowerData0;
assert(flowerData0, "flower ring must expose its packed data0 plane for contracts");
const heroMeshes = flowers.group.children.filter((child) => child.name.startsWith("wildlands_flowers_hero_"));
let groundedHeroAnchors = 0;
for (const mesh of heroMeshes) {
  const base = mesh.userData.flowerBase ?? 0;
  const liveRows = mesh.userData.flowerCount ?? 0;
  for (let i = 0; i < liveRows; i++) {
    const slot = (base + i) * 4;
    const x = flowerData0[slot];
    const y = flowerData0[slot + 1];
    const z = flowerData0[slot + 2];
    assert(y <= groundHeight(x, z) - 0.034, `${mesh.name} anchor ${i} is not footprint-seated`);
    groundedHeroAnchors += 1;
  }
}
assert(groundedHeroAnchors > 0, "grounding contract needs at least one hero anchor");

const defaultReachCount = flowers.stats.count;
FLOWER_TUNING.values.reach = FLOWER_REACH_MIN;
flowers.refresh();
assert.equal(flowers.stats.reach, FLOWER_REACH_MIN, "lowering reach must update the live flower ring");
assert(flowers.stats.count < defaultReachCount, "lower reach should submit fewer flowers");

FLOWER_TUNING.values.density = 2.5;
FLOWER_TUNING.values.reach = FLOWER_REACH_MAX;
flowers.refresh();
const stressStats = flowers.stats;
assert.equal(stressStats.reach, FLOWER_REACH_MAX, "raising reach must update the live flower ring");
assert.equal(stressStats.droppedByCapacity, 0, "maximum supported density/reach must not overflow a flower bucket");

flowers.dispose();
assert.equal(flowers.group.children.length, 0, "dispose must release all flower bucket meshes");

console.log("flower LOD contract: ok", JSON.stringify({
  clumps: stats.count,
  lodInstances: stats.lodInstances,
  submittedInstances: stats.submittedInstances,
  triangles: stats.trianglesPerClumpByLod,
  submittedTriangles: stats.submittedTriangles,
  edgeFade: {
    band: FLOWER_EDGE_FADE_BAND_METRES,
    stagger: FLOWER_EDGE_STAGGER_METRES,
    earliestEnd: +earliestEdgeEnd.toFixed(2),
    latestEnd: +latestEdgeEnd.toFixed(2)
  },
  stressClumps: stressStats.count,
  draws: stats.draws,
  reservedMiB: +(stats.reservedInstanceBytes / (1024 * 1024)).toFixed(2),
  legacyReservedMiB: +(legacyReservedBytes / (1024 * 1024)).toFixed(2)
}));
