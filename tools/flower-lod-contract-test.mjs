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

const { createFlowerRing } = await import("../src/world/wildlands/flowerRing.ts");
const { FLOWER_TUNING } = await import("../src/config.ts");

const FOCUS = { x: -4000, z: 2440 };
const groundHeight = (x, z) => 75 + (x - FOCUS.x) * 0.22 + (z - FOCUS.z) * 0.12;
const flowers = createFlowerRing({
  groundHeight,
  surfaceType: () => 1,
  isWater: () => false
});
flowers.update(FOCUS);

const stats = flowers.stats;
assert(stats.count > 100, `expected populated test meadow, got ${stats.count}`);
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

const legacyCapacityPerSpecies = Math.ceil(((119 * 2) / 1.6) ** 2 * 0.5);
const legacyReservedBytes = legacyCapacityPerSpecies * 4 * (16 + 3 + 4) * Float32Array.BYTES_PER_ELEMENT;
assert(
  stats.reservedInstanceBytes < legacyReservedBytes,
  `LOD buckets should reserve less instance memory (${stats.reservedInstanceBytes} < ${legacyReservedBytes})`
);

const populatedMeshes = flowers.group.children.filter((child) => child.isInstancedMesh && child.count > 0);
assert(populatedMeshes.length > 4, "spatial flower sectors should produce more than the legacy four global meshes");
for (const mesh of populatedMeshes) {
  assert.equal(mesh.frustumCulled, true, `${mesh.name} must participate in frustum culling`);
  assert(mesh.boundingSphere, `${mesh.name} must have an explicit instance bound`);
  assert(Number.isFinite(mesh.boundingSphere.radius) && mesh.boundingSphere.radius > 0, `${mesh.name} bound must be finite`);
}

// The centre sample is never lower than the minimum of a sloped footprint. Every
// hero anchor must therefore be at least ROOT_SINK below its centre ground; this
// catches a regression back to map.groundHeight(px,pz) centre-only seating.
const heroMeshes = flowers.group.children.filter((child) => child.name.startsWith("wildlands_flowers_hero_"));
let groundedHeroAnchors = 0;
for (const mesh of heroMeshes) {
  const anchors = mesh.geometry.getAttribute("aFlowerAnchor");
  for (let i = 0; i < mesh.count; i++) {
    const x = anchors.getX(i);
    const y = anchors.getY(i);
    const z = anchors.getZ(i);
    assert(y <= groundHeight(x, z) - 0.034, `${mesh.name} anchor ${i} is not footprint-seated`);
    groundedHeroAnchors += 1;
  }
}
assert(groundedHeroAnchors > 0, "grounding contract needs at least one hero anchor");

FLOWER_TUNING.values.density = 2.5;
FLOWER_TUNING.values.reach = 110;
flowers.refresh();
const stressStats = flowers.stats;
assert.equal(stressStats.droppedByCapacity, 0, "maximum supported density/reach must not overflow a flower bucket");

flowers.dispose();
assert.equal(flowers.group.children.length, 0, "dispose must release all flower bucket meshes");

console.log("flower LOD contract: ok", JSON.stringify({
  clumps: stats.count,
  lodInstances: stats.lodInstances,
  triangles: stats.trianglesPerClumpByLod,
  submittedTriangles: stats.submittedTriangles,
  stressClumps: stressStats.count,
  draws: stats.draws,
  reservedMiB: +(stats.reservedInstanceBytes / (1024 * 1024)).toFixed(2),
  legacyReservedMiB: +(legacyReservedBytes / (1024 * 1024)).toFixed(2)
}));
