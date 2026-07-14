// CPU benchmark for Wildlands grass streaming. It runs the real deterministic
// sampler on a flat Golden Gate Park fixture and records both immediate update
// cost and any bounded scheduler slices used to finish the exact tile set.
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

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key)
};

const { createWildGrass } = await import("../src/world/wildlands/grassField.ts");
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
const schedulerSlices = [];
const schedule = (job) => scheduled.push(job);
const drain = (limit = 1_000_000) => {
  let turns = 0;
  while (scheduled.length > 0 && turns < limit) {
    const job = scheduled.shift();
    const started = performance.now();
    const result = job();
    schedulerSlices.push(performance.now() - started);
    if (result === "again") scheduled.push(job);
    turns++;
  }
  assert(turns < limit, `grass scheduler failed to settle after ${limit} slices`);
  return turns;
};

globalThis.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const grass = createWildGrass({
  groundHeight: () => 75,
  surfaceType: () => 1,
  isWater: () => false
}, undefined, { schedule });

const origin = { x: -4000, z: 2440 };
const updateDurations = [];
const timedUpdate = (focus) => {
  const started = performance.now();
  grass.update(focus);
  const elapsed = performance.now() - started;
  updateDurations.push(elapsed);
  return elapsed;
};

const initialImmediateMs = timedUpdate(origin);
const initialSlicesBefore = schedulerSlices.length;
const initialTurns = drain();
const initialSliceDurations = schedulerSlices.slice(initialSlicesBefore);
const initialStats = structuredClone(grass.stats);
assert(initialStats.count > 0, "initial fixture must produce grass");

const movementImmediate = [];
const movementSlices = [];
for (let step = 1; step <= 28; step++) {
  // A shallow deterministic zig-zag repeatedly crosses 6m stream boundaries
  // without leaving Golden Gate Park.
  const focus = {
    x: origin.x + step * 8,
    z: origin.z + ((step % 6) - 3) * 5
  };
  const beforeSlices = schedulerSlices.length;
  movementImmediate.push(timedUpdate(focus));
  drain();
  movementSlices.push(...schedulerSlices.slice(beforeSlices));
}

globalThis.gc?.();
const heapAfterSettled = process.memoryUsage().heapUsed;
const finalStats = structuredClone(grass.stats);
const streaming = grass.group.userData.grassStreaming ?? null;

// Measure the real app-wide scheduler integration, not four unconstrained rAF
// callbacks. The central scheduler owns the aggregate per-frame budget.
const centralScheduler = createFrameScheduler();
const centrallyScheduledGrass = createWildGrass({
  groundHeight: () => 75,
  surfaceType: () => 1,
  isWater: () => false
}, undefined, {
  schedule: (job) => centralScheduler.schedule("build", job)
});
centrallyScheduledGrass.update(origin);
const aggregateFrames = [];
let aggregateFrameGuard = 0;
let criticalFrame = null;
let criticalWallMs = null;
const aggregateStarted = performance.now();
while (centralScheduler.pending > 0) {
  assert(aggregateFrameGuard++ < 10_000, "central grass scheduler must settle");
  const started = performance.now();
  centralScheduler.run(1.5);
  aggregateFrames.push(performance.now() - started);
  if (criticalFrame === null && centrallyScheduledGrass.group.userData.grassStreaming.criticalReady) {
    criticalFrame = aggregateFrames.length;
    criticalWallMs = performance.now() - aggregateStarted;
  }
}
const aggregateScheduler = {
  budgetMs: 1.5,
  frames: aggregateFrames.length,
  criticalFrame,
  criticalSimulatedMsAt60Fps: criticalFrame === null ? null : rounded(criticalFrame * 1000 / 60),
  criticalWallMs: criticalWallMs === null ? null : rounded(criticalWallMs),
  frameWork: summarize(aggregateFrames),
  grass: structuredClone(centrallyScheduledGrass.group.userData.grassStreaming)
};
centrallyScheduledGrass.dispose();

const result = {
  generatedAt: new Date().toISOString(),
  initial: {
    immediateMs: rounded(initialImmediateMs),
    schedulerTurns: initialTurns,
    schedulerSlices: summarize(initialSliceDurations),
    stats: initialStats
  },
  movement: {
    immediate: summarize(movementImmediate),
    schedulerSlices: summarize(movementSlices)
  },
  allUpdates: summarize(updateDurations),
  heap: {
    beforeBytes: heapBefore,
    settledBytes: heapAfterSettled,
    retainedDeltaBytes: heapAfterSettled - heapBefore,
    retainedDeltaMiB: rounded((heapAfterSettled - heapBefore) / (1024 * 1024))
  },
  finalStats,
  streaming,
  aggregateScheduler
};

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
grass.dispose();
