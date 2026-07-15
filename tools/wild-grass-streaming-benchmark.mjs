// CPU-side benchmark for the part of Wildlands grass that still belongs on the
// CPU: paging the player-following RGBA foliage field. Actual grass placement,
// compaction and indirect command generation are covered by the browser WebGPU
// probe in tools/grass-orbit.mjs.
//
//   node --expose-gc tools/wild-grass-streaming-benchmark.mjs

import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.SF_WILD_GRASS_BENCH_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data/wild-grass-streaming-benchmark");

if (process.env.SF_WILD_GRASS_BENCH_BUNDLED !== "1") {
  const { build } = await import("esbuild");
  mkdirSync(OUT, { recursive: true });
  const outfile = path.join(OUT, "benchmark.mjs");
  await build({
    entryPoints: [fileURLToPath(import.meta.url)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    define: { "process.env.SF_WILD_GRASS_BENCH_BUNDLED": '"1"' },
    logLevel: "silent"
  });
  const result = spawnSync(process.execPath, ["--expose-gc", outfile], {
    cwd: ROOT,
    env: { ...process.env, SF_WILD_GRASS_BENCH_ROOT: ROOT },
    stdio: "inherit"
  });
  process.exit(result.status ?? 1);
}

const { FoliageField, FOLIAGE_FIELD_SIZE } =
  await import("../src/world/groundcover/foliageField.ts");
const { createFrameScheduler } = await import("../src/core/frameBudget.ts");

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * p))];
};
const rounded = (value) => Math.round(value * 1000) / 1000;
const summarize = (values) => ({
  count: values.length,
  medianMs: rounded(percentile(values, 0.5)),
  p90Ms: rounded(percentile(values, 0.9)),
  maxMs: rounded(Math.max(0, ...values)),
  totalMs: rounded(values.reduce((sum, value) => sum + value, 0))
});

const scheduled = [];
const slices = [];
const field = new FoliageField({
  groundHeight: (x, z) => 74 + Math.sin(x * 0.008) * 4 + Math.cos(z * 0.006) * 3,
  plantable: (x, z) => ((Math.floor(x) * 31 + Math.floor(z) * 17) & 15) !== 0,
  schedule: (job) => scheduled.push(job)
});
const drain = (limit = 1_000_000) => {
  let turns = 0;
  while (scheduled.length > 0) {
    assert(turns++ < limit, "foliage field scheduler failed to settle");
    const job = scheduled.shift();
    const started = performance.now();
    const again = job();
    slices.push(performance.now() - started);
    if (again === "again") scheduled.push(job);
  }
  return turns;
};

globalThis.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const origin = { x: -4600, z: 2080 };
const initialStarted = performance.now();
const initialPromise = field.request(origin);
const initialTurns = drain();
await initialPromise;
const initialMs = performance.now() - initialStarted;
const initialStats = { ...field.stats };
assert.equal(initialStats.sampledCells, FOLIAGE_FIELD_SIZE ** 2);
assert.equal(initialStats.fullRebuilds, 1);

const movementRequests = [];
const movementSlices = [];
let priorSlice = slices.length;
for (let step = 1; step <= 28; step++) {
  const focus = { x: origin.x + step * 6, z: origin.z };
  const started = performance.now();
  const promise = field.request(focus);
  drain();
  await promise;
  movementRequests.push(performance.now() - started);
  movementSlices.push(...slices.slice(priorSlice));
  priorSlice = slices.length;
}
const finalStats = { ...field.stats };
const expectedMovementSamples = 28 * 6 * FOLIAGE_FIELD_SIZE;
assert.equal(finalStats.sampledCells - initialStats.sampledCells, expectedMovementSamples);
assert.equal(finalStats.slabUpdates, 28);

// Also exercise the real app-wide build lane. This reports aggregate work per
// scheduler turn rather than pretending Node can time the browser GPU dispatch.
const scheduler = createFrameScheduler();
const central = new FoliageField({
  groundHeight: () => 75,
  plantable: () => true,
  schedule: (job) => scheduler.schedule("build", job)
});
const centralPromise = central.request(origin);
const aggregateFrames = [];
while (scheduler.pending > 0) {
  assert(aggregateFrames.length < 10_000, "central foliage scheduler must settle");
  const started = performance.now();
  scheduler.run(1.5);
  aggregateFrames.push(performance.now() - started);
}
await centralPromise;

globalThis.gc?.();
const heapAfter = process.memoryUsage().heapUsed;
const result = {
  generatedAt: new Date().toISOString(),
  contract: {
    fieldSize: FOLIAGE_FIELD_SIZE,
    fieldCells: FOLIAGE_FIELD_SIZE ** 2,
    fieldBytes: field.data.byteLength,
    sixMetreSlabCells: 6 * FOLIAGE_FIELD_SIZE,
    gpuCandidateThreads: 204_204,
    fixedGpuOutputBytes: 204_204 * 48,
    indirectCommandBytes: 80
  },
  initial: {
    wallMs: rounded(initialMs),
    schedulerTurns: initialTurns,
    slices: summarize(slices.slice(0, initialTurns)),
    stats: initialStats
  },
  movement: {
    requests: summarize(movementRequests),
    slices: summarize(movementSlices),
    sampledCells: expectedMovementSamples
  },
  aggregateScheduler: {
    budgetMs: 1.5,
    frames: aggregateFrames.length,
    frameWork: summarize(aggregateFrames),
    stats: { ...central.stats }
  },
  heap: {
    beforeBytes: heapBefore,
    settledBytes: heapAfter,
    retainedDeltaBytes: heapAfter - heapBefore
  },
  finalStats
};

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
field.dispose();
central.dispose();
