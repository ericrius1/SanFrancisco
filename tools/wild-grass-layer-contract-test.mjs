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
  wildGrassBladeDensityAt,
  wildGrassGpuCandidateCapacity,
  wildGrassLayerTriangles,
  wildGrassLayersAt
} = await import("../src/world/wildlands/grassField.ts");
const { createMicroBladeClusterGeometry } = await import("../src/world/groundcover/bladeGrass.ts");
const { hash2, r2Offset } = await import("../src/world/groundcover/scatter.ts");

function scatterSpacing(kind, size = 72) {
  const points = [];
  for (let gx = 0; gx < size; gx++) {
    for (let gz = 0; gz < size; gz++) {
      const offset = kind === "r2"
        ? r2Offset(gx, gz, 11)
        : { ox: hash2(gx, gz, 11), oz: hash2(gx, gz, 17) };
      points.push([
        gx + (offset.ox - 0.5) * 0.86,
        gz + (offset.oz - 0.5) * 0.86
      ]);
    }
  }

  const nearest = [];
  let nearTouching = 0;
  for (let gx = 1; gx < size - 1; gx++) {
    for (let gz = 1; gz < size - 1; gz++) {
      const point = points[gx * size + gz];
      let best = Infinity;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dz === 0) continue;
          const other = points[(gx + dx) * size + gz + dz];
          best = Math.min(best, Math.hypot(point[0] - other[0], point[1] - other[1]));
        }
      }
      nearest.push(best);
      if (best < 0.35) nearTouching++;
    }
  }
  nearest.sort((a, b) => a - b);
  return {
    p05: nearest[Math.floor(nearest.length * 0.05)],
    nearTouching
  };
}

// Lock the reason for using R2, not merely its current output count. A future
// refactor must keep the low-discrepancy spacing advantage over white-noise
// jitter instead of silently reintroducing clumps and bald gaps.
const hashSpacing = scatterSpacing("hash");
const r2Spacing = scatterSpacing("r2");
assert(r2Spacing.p05 > hashSpacing.p05 * 1.25,
  `R2 fifth-percentile spacing regressed (${r2Spacing.p05} vs ${hashSpacing.p05})`);
assert(r2Spacing.nearTouching < hashSpacing.nearTouching * 0.4,
  `R2 near-touching pairs regressed (${r2Spacing.nearTouching} vs ${hashSpacing.nearTouching})`);
assert.deepEqual(r2Offset(-413, 271, 11), r2Offset(-413, 271, 11),
  "R2 offsets must remain deterministic at negative world cells");

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

// The GPU path owns exactly one resident draw per layer. Fixed output capacity
// covers the 2.5× density slider ceiling; the indirect instance count exposes
// only accepted candidates to rasterization.
const flatLayers = {};
let flatCount = 0;
let flatTriangles = 0;
let capacity = 0;
for (const [name, spec] of Object.entries(WILD_GRASS_LAYER_SPECS)) {
  const gpu = wildGrassGpuCandidateCapacity(spec);
  assert.equal(gpu.side % 2, 1, `${name} candidate square must have one stable centre cell`);
  assert(gpu.capacity > gpu.side ** 2 * 2, `${name} capacity must cover all three density layers`);
  capacity += gpu.capacity;

  const step = 0.68 * spec.gridStride;
  const reach = (gpu.side - 1) / 2;
  let count = 0;
  for (let gx = -reach; gx <= reach; gx++) {
    for (let gz = -reach; gz <= reach; gz++) {
      const jitter = r2Offset(gx, gz, 11);
      const x = gx * step + (jitter.ox - 0.5) * step * 0.86;
      const z = gz * step + (jitter.oz - 0.5) * step * 0.86;
      if (Math.hypot(x, z) < spec.visibleRadius) count++;
    }
  }
  const triangles = count * wildGrassLayerTriangles(spec);
  flatLayers[name] = { ...gpu, count, triangles };
  flatCount += count;
  flatTriangles += triangles;
}
assert.equal(Object.keys(flatLayers).length, 4);
assert.equal(capacity, 204204, "fixed GPU candidate capacity changed unexpectedly");
assert(flatCount > 45_000, `flat default field lost too much coverage (${flatCount})`);
assert(flatTriangles < 200_000, `default compacted geometry exceeded its envelope (${flatTriangles})`);
assert(capacity * 48 < 10 * 1024 * 1024, "GPU output buffers must stay below 10MiB");

console.log("wild grass additive layer contract: ok", JSON.stringify({
  reach: WILD_GRASS_RING_RADIUS,
  closeBladesPerM2: +wildGrassBladeDensityAt(0).toFixed(2),
  draws: 4,
  instances: flatCount,
  submittedTriangles: flatTriangles,
  gpuCapacity: capacity,
  gpuBufferMiB: +((capacity * 48) / (1024 * 1024)).toFixed(2),
  scatter: {
    p05Gain: +(r2Spacing.p05 / hashSpacing.p05).toFixed(2),
    nearTouchingReduction: +(1 - r2Spacing.nearTouching / hashSpacing.nearTouching).toFixed(2)
  },
  layers: flatLayers
}));
