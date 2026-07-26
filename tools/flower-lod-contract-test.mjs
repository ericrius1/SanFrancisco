// CPU-side contract for the wildflower ladder: the rank dissolve that makes
// blooms grow in rather than pop, the continuity of the LOD handoffs, the baked
// ecology the GPU places against, the geometry budget per grade, and the
// reserved instance memory.
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

const { createFlowerRing, FLOWER_LADDER } = await import("../src/world/wildlands/flowerRing.ts");
const { flowerEcologyAt, FLOWER_FIELD, FLOWER_HORIZON_FIELD } =
  await import("../src/world/wildlands/flowerField.ts");
const { KEEP_CEILING } = await import("../src/world/wildlands/flowerSpecies.ts");
const { rankAnnulusWindow, rankHandoffRadius, RANK_DISSOLVE_SOFT } =
  await import("../src/world/groundcover/rankDissolve.ts");
const {
  FLOWER_REACH_DEFAULT,
  FLOWER_REACH_MAX,
  FLOWER_REACH_MIN,
  FLOWER_TUNING
} = await import("../src/config.ts");

// ---- 1. the dissolve: every clump GROWS in and out, none of them pop ----------
//
// The point of the rank window is that an instance is already zero-sized by the
// distance at which its cull drops it, and that two neighbouring ranks leave at
// different distances so the boundary never sweeps the field as a ring.
const RUNGS = [
  FLOWER_LADDER.hero,
  FLOWER_LADDER.mid,
  FLOWER_LADDER.far,
  FLOWER_LADDER.dist,
  FLOWER_LADDER.horizon
];
const RANKS = Array.from({ length: 32 }, (_, index) => 0.002 + (index / 32) * 0.996);

for (const grade of RUNGS) {
  const windows = RANKS.map((rank) => rankAnnulusWindow(rank, grade));
  for (const [index, window] of windows.entries()) {
    assert(
      window.dropStart < window.dropEnd,
      `rung ${grade.visibleRadius}m rank ${RANKS[index]} must shrink over a real distance`
    );
    assert(
      Math.abs((window.dropEnd - window.dropStart) - RANK_DISSOLVE_SOFT * grade.fadeBand) < 1e-9,
      "the shrink window must be exactly one soft band wide"
    );
    if (grade.minRadius) {
      assert(
        window.growStart < window.growEnd && window.growEnd <= window.dropStart + 1e-9,
        `rung ${grade.visibleRadius}m must finish growing in before it starts shrinking out`
      );
    }
  }
  // Decorrelated ranks stagger the drop across the whole fade band — that spread
  // IS the difference between a dissolve and a ring sweeping through the meadow.
  const ends = windows.map((window) => window.dropEnd);
  const spread = Math.max(...ends) - Math.min(...ends);
  assert(
    spread > grade.fadeBand * 0.9,
    `rung ${grade.visibleRadius}m should stagger drops across its ${grade.fadeBand}m band (got ${spread.toFixed(1)}m)`
  );
}

// A repeat call is bit-identical: placement is deterministic in (cell, rank).
assert.deepEqual(
  RANKS.map((rank) => rankAnnulusWindow(rank, FLOWER_LADDER.mid)),
  RANKS.map((rank) => rankAnnulusWindow(rank, FLOWER_LADDER.mid)),
  "rank windows must be deterministic"
);

// ---- 2. ladder continuity: no gap and no doubled band between rungs -----------
const LADDER = [
  ["hero", FLOWER_LADDER.hero, FLOWER_LADDER.mid],
  ["mid", FLOWER_LADDER.mid, FLOWER_LADDER.far],
  ["far", FLOWER_LADDER.far, FLOWER_LADDER.dist],
  ["dist", FLOWER_LADDER.dist, FLOWER_LADDER.horizon]
];
for (const [name, inner, outer] of LADDER) {
  assert.equal(
    outer.minRadius,
    rankHandoffRadius(inner.visibleRadius, inner.fadeBand),
    `${name} → next handoff must sit on the shared rule`
  );
  assert.equal(outer.innerBand, inner.fadeBand, `${name} handoff bands must be complements`);
  for (const rank of RANKS) {
    const leaving = rankAnnulusWindow(rank, inner);
    const arriving = rankAnnulusWindow(rank, outer);
    assert(
      arriving.growStart <= leaving.dropEnd,
      `${name} would open a flowerless gap at rank ${rank.toFixed(3)}`
    );
    assert(
      arriving.growEnd >= leaving.dropStart - 1e-9,
      `${name} would hand off before its own clump starts to shrink`
    );
  }
}
assert.equal(FLOWER_LADDER.hero.minRadius, undefined, "the hero rung owns the player's feet");
assert(
  FLOWER_LADDER.horizon.visibleRadius >= FLOWER_REACH_MAX,
  "the horizon rung must be able to carry the full configured reach"
);

// ---- 3. reach is real: the ecology squares actually cover it ------------------
assert(
  FLOWER_REACH_MAX <= FLOWER_LADDER.horizonHalfExtent,
  `reach ${FLOWER_REACH_MAX}m must stay inside the ${FLOWER_LADDER.horizonHalfExtent}m horizon ecology square`
);
assert(
  FLOWER_LADDER.dist.visibleRadius <= FLOWER_LADDER.nearHalfExtent,
  "every rung on the near ecology must stay inside its square"
);
// Density is what the eye reads at walking distance: keep the full wildflower
// cell all the way through the rung that covers the visible middle ground.
assert.equal(
  FLOWER_LADDER.far.gridStride,
  FLOWER_LADDER.hero.gridStride,
  "the far rung must keep the hero cell so density does not fall away mid-view"
);
assert(
  FLOWER_LADDER.far.visibleRadius > 110,
  "the full-density rungs must reach past the grass ring"
);
assert(
  FLOWER_REACH_DEFAULT > 4 * 110,
  `flowers should reach far past the 110 m grass ring by default (got ${FLOWER_REACH_DEFAULT}m)`
);
assert.equal(FLOWER_TUNING.values.reach, FLOWER_REACH_DEFAULT, "flower tuning starts at the default reach");

// ---- 4. the baked ecology the GPU places against -----------------------------
const FOCUS = { x: -4000, z: 2440 }; // GG Park poppy meadow
const groundHeight = (x, z) => 75 + (x - FOCUS.x) * 0.22 + (z - FOCUS.z) * 0.12;
const terrain = { groundHeight, surfaceType: () => 1, isWater: () => false };

const sample = flowerEcologyAt(terrain, FOCUS.x, FOCUS.z);
assert.deepEqual(sample, flowerEcologyAt(terrain, FOCUS.x, FOCUS.z), "ecology must be deterministic");
assert(sample.density > 0, "the designed poppy meadow must be plantable");

let plantable = 0;
let maxDensity = 0;
const speciesSeen = new Set();
for (let i = 0; i < 400; i++) {
  const x = FOCUS.x + (i % 20) * 7 - 70;
  const z = FOCUS.z + Math.floor(i / 20) * 7 - 70;
  const cell = flowerEcologyAt(terrain, x, z);
  assert(cell.density >= 0 && cell.density <= KEEP_CEILING, "keep shape must stay inside its ceiling");
  assert(cell.species >= 0 && cell.species < 1, "packed species must stay in the 0..1 channel");
  assert(cell.height > 0.5 && cell.height < 1.1, "base spread must stay in its authored split");
  if (cell.density > 0) {
    plantable++;
    maxDensity = Math.max(maxDensity, cell.density);
    // The packing the placement shader unpacks: species id, then its clump seed.
    const packed = cell.species * 4;
    const id = Math.floor(packed);
    assert(id >= 0 && id <= 3, `species id ${id} out of range`);
    assert(packed - id > 0 && packed - id < 1, "clump seed must stay strictly inside its cell");
    speciesSeen.add(id);
  }
}
assert(plantable > 300, `flat class-1 green should be broadly plantable (got ${plantable}/400)`);
assert(maxDensity > 0.4, "a designed drift should bake a strong keep shape");
assert(speciesSeen.size >= 1, "the meadow must select at least its dominant species");

// Water and roads bake to zero, which is also the placement pass's plantability bit.
assert.equal(
  flowerEcologyAt({ ...terrain, isWater: () => true }, FOCUS.x, FOCUS.z).density,
  0,
  "no wildflowers on water"
);
assert.equal(
  flowerEcologyAt({ ...terrain, surfaceType: () => 3 }, FOCUS.x, FOCUS.z).density,
  0,
  "no wildflowers on the streets"
);
assert.equal(
  flowerEcologyAt(terrain, FOCUS.x, FOCUS.z, () => true).density,
  0,
  "authored exclusions keep blooms off play surfaces"
);

// ---- 5. the built ring: geometry ladder, draws, reserved memory ---------------
const flowers = createFlowerRing(terrain);
const stats = flowers.stats;

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

// The CPU no longer scatters anything, so the whole envelope is reserved GPU
// slots. Hold it under what the old per-move re-scatter reserved.
const LEGACY_RESERVED_INSTANCE_BYTES = 3_326_208;
assert(
  stats.reservedInstanceBytes <= LEGACY_RESERVED_INSTANCE_BYTES,
  `the placed ladder must not reserve more instance memory (${stats.reservedInstanceBytes} <= ${LEGACY_RESERVED_INSTANCE_BYTES})`
);
assert.equal(stats.droppedByCapacity, 0, "a freshly built ring drops nothing");

// A rung that overflows drops candidates in GRID order, which carves an empty
// quadrant rather than thinning evenly — so every rung must reserve past the
// worst case it can be asked for: the baked keep ceiling on plantable ground at
// the maximum density. (0.9 is the plantable share of an open wildlands region
// after the slope gate.)
const WORST_CASE_KEEP = KEEP_CEILING * 0.9;
for (const rung of flowers.group.userData.flowerRungs) {
  const headroom = rung.capacity / rung.candidates;
  assert(
    headroom >= WORST_CASE_KEEP,
    `${rung.tier}${rung.species ?? ""} reserves ${(headroom * 100).toFixed(0)}% of its grid, ` +
    `below the ${(WORST_CASE_KEEP * 100).toFixed(0)}% a maximum-density superbloom can keep`
  );
}

// One indirect draw per rung: four hero species, four mid species, two shared accents.
const meshes = flowers.group.children.filter((child) => child.isMesh);
assert.equal(meshes.length, 11, `expected the eleven-rung ladder, got ${meshes.length}`);
const BEAUTY_ONLY_LAYER = 31;
for (const mesh of meshes) {
  assert.equal(mesh.frustumCulled, false, `${mesh.name} visibility is owned by the GPU per-instance cull`);
  assert(!mesh.material.alphaHash, `${mesh.name} must dissolve by growth, never by dithered coverage`);
  assert(!mesh.material.opacityNode, `${mesh.name} must stay fully opaque`);
  assert.equal(mesh.layers.mask >>> 0, (1 << BEAUTY_ONLY_LAYER) >>> 0, `${mesh.name} must stay out of the ink prepass`);
  assert(mesh.geometry.boundingSphere, `${mesh.name} must have an explicit conservative bound`);
  const indirect = mesh.geometry.getIndirect?.() ?? mesh.geometry.indirect ?? null;
  assert(indirect, `${mesh.name} must draw through the shared indirect buffer`);
}
assert(flowers.group.userData.flowerIndirect, "the ring must expose its indirect buffer for cull probes");

// Reach is a live uniform on every rung, so the slider moves the whole ladder.
FLOWER_TUNING.values.reach = FLOWER_REACH_MIN;
assert.equal(flowers.stats.reach, FLOWER_REACH_MIN, "lowering reach must update the live flower ring");
FLOWER_TUNING.values.reach = FLOWER_REACH_MAX;
assert.equal(flowers.stats.reach, FLOWER_REACH_MAX, "raising reach must update the live flower ring");
FLOWER_TUNING.values.reach = FLOWER_REACH_DEFAULT;

flowers.dispose();
assert.equal(flowers.group.children.length, 0, "dispose must release all flower rung meshes");

console.log("flower LOD contract: ok", JSON.stringify({
  ladder: RUNGS.map((grade) => ({
    radius: grade.visibleRadius,
    band: grade.fadeBand,
    min: grade.minRadius ?? 0,
    stride: grade.gridStride
  })),
  reach: { default: FLOWER_REACH_DEFAULT, max: FLOWER_REACH_MAX },
  ecology: {
    near: FLOWER_FIELD,
    horizon: FLOWER_HORIZON_FIELD,
    cells: FLOWER_FIELD.size ** 2 + FLOWER_HORIZON_FIELD.size ** 2
  },
  triangles: stats.trianglesPerClumpByLod,
  reservedInstances: stats.reservedInstances,
  reservedInstanceBytes: stats.reservedInstanceBytes,
  draws: meshes.length
}, null, 0));
