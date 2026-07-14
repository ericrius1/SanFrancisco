// Deterministic contract for progressive Wildlands grass streaming:
// bounded scheduler work, nearest-first atomic hidden publish, pipeline-layout
// admission, outgoing coverage retention, and stale cancellation.
//
//   node tools/wild-grass-streaming-contract-test.mjs

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.SF_WILD_GRASS_STREAMING_BUNDLED !== "1") {
  const { build } = await import("esbuild");
  const output = fileURLToPath(new URL("../.data/wild-grass-streaming-test/contract.mjs", import.meta.url));
  mkdirSync(fileURLToPath(new URL("../.data/wild-grass-streaming-test/", import.meta.url)), { recursive: true });
  await build({
    entryPoints: [fileURLToPath(import.meta.url)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    define: { "process.env.SF_WILD_GRASS_STREAMING_BUNDLED": '"1"' },
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
  WILD_GRASS_STREAM_MARGIN,
  createWildGrass
} = await import("../src/world/wildlands/grassField.ts");
const {
  createGroundcoverPreparationRegistry,
  prepareGroundcoverRootPipelines
} = await import("../src/world/wildlands/index.ts");

const MAP = {
  groundHeight: () => 75,
  surfaceType: () => 1,
  isWater: () => false
};
const A = { x: -4000, z: 2440 };
const B = { x: -3820, z: 2470 };

function manualScheduler() {
  const jobs = [];
  return {
    jobs,
    schedule: (job) => jobs.push(job),
    turn() {
      const job = jobs.shift();
      if (!job) return false;
      if (job() === "again") jobs.push(job);
      return true;
    },
    drain(limit = 100_000) {
      let turns = 0;
      while (jobs.length > 0) {
        assert(turns++ < limit, "scheduler must settle within its deterministic turn cap");
        this.turn();
      }
      return turns;
    }
  };
}

function parseTile(mesh) {
  const match = mesh.name.match(/^wildlands_grass_(far|mid|near|hero)_(-?\d+)_(-?\d+)$/);
  assert(match, `unexpected streamed grass name ${mesh.name}`);
  return { layer: match[1], tx: Number(match[2]), tz: Number(match[3]) };
}

function tileDistance(tile, focus) {
  const size = WILD_GRASS_LAYER_SPECS[tile.layer].tileSize;
  const minX = tile.tx * size;
  const minZ = tile.tz * size;
  const dx = Math.max(minX - focus.x, 0, focus.x - (minX + size));
  const dz = Math.max(minZ - focus.z, 0, focus.z - (minZ + size));
  return Math.hypot(dx, dz);
}

// Initial generation stays out of the scene until a tile is completely sampled
// and uploaded, then enters hidden for WebGPU pipeline preparation.
const scheduler = manualScheduler();
const grass = createWildGrass(MAP, undefined, {
  schedule: scheduler.schedule,
  requirePreparation: true,
  sliceBudgetMs: 0.5
});
grass.update(A);
assert.equal(grass.group.children.length, 0, "requesting a ring must not synchronously publish partial meshes");
assert(grass.group.userData.grassStreaming.pendingJobs > 0);

let first = null;
let turnsToFirst = 0;
while (!first) {
  assert(scheduler.turn(), "scheduler ran dry before its nearest tile published");
  assert(++turnsToFirst < 20_000, "nearest tile must publish progressively");
  first = grass.group.children[0] ?? null;
}
assert.equal(parseTile(first).layer, "far", "zero-distance ties must retain stable layer order");
assert.equal(tileDistance(parseTile(first), A), 0, "the first published tile must contain the focus");
assert.equal(first.visible, false, "an unprepared completed tile must publish hidden");
assert(first.geometry.instanceCount > 0, "atomic publish requires a complete non-zero instance buffer");
for (const name of ["aGrassTransform", "aGrassShape", "aGrassColor"]) {
  assert(first.geometry.getAttribute(name), `atomic tile is missing ${name}`);
}

// The first material/layout compiles once. A later tile from that same layer is
// immediately recognized by the registry and needs no second compile.
const registry = createGroundcoverPreparationRegistry();
let compiles = 0;
assert.equal(await prepareGroundcoverRootPipelines(
  grass.group,
  [first],
  async () => { compiles++; },
  registry
), true);
assert.equal(first.visible, true);
let sameLayout = null;
while (!sameLayout) {
  assert(scheduler.turn(), "scheduler ran dry before a sibling layout published");
  sameLayout = grass.group.children.find((mesh) => mesh !== first && parseTile(mesh).layer === "far") ?? null;
}
assert.equal(sameLayout.visible, false, "new sibling is hidden until registry admission");
assert.equal(registry.has(sameLayout), true, "sibling must inherit the warmed material/layout");
assert.equal(await prepareGroundcoverRootPipelines(
  grass.group,
  [sameLayout],
  async () => { compiles++; },
  registry
), false, "warmed sibling must not compile again");
sameLayout.visible = true;
assert.equal(compiles, 1, "one layout must compile exactly once");

while (!grass.group.userData.grassStreaming.criticalReady) {
  assert(scheduler.turn(), "scheduler ran dry before destination-critical coverage");
}
await grass.whenCriticalReady();
const criticalPendingJobs = grass.group.userData.grassStreaming.pendingJobs;
assert(criticalPendingJobs > 0,
  "destination-critical coverage must resolve before the optional outer ring");
assert.equal(grass.group.userData.grassStreaming.criticalLayers, 4,
  "far, mid, near and hero layers must all reach the critical milestone");

scheduler.drain();
await grass.whenSettled();
const initialStreaming = grass.group.userData.grassStreaming;
assert.equal(grass.stats.count, 133501, "progressive build must preserve exact final placement");
assert.equal(grass.stats.draws, 38, "progressive build must preserve exact final draw topology");
assert(initialStreaming.maxSampleStepsPerSlice <= 128, "sample work must obey its hard slice cap");
assert(initialStreaming.maxUploadEntriesPerSlice <= 128, "buffer upload work must obey its hard slice cap");
assert.equal(initialStreaming.retainedEntryArrays, 0, "settled tiles must retain no GrassEntry arrays");
assert.equal(initialStreaming.retainedEntries, 0, "settled generation must release its entry cache");
for (const mesh of grass.group.children) {
  if (mesh.visible) assert(registry.has(mesh), `${mesh.name} became visible without a prepared layout`);
}

// Movement retains outgoing coverage while replacements are still building.
grass.dispose();
const motionScheduler = manualScheduler();
const movingGrass = createWildGrass(MAP, undefined, { schedule: motionScheduler.schedule });
movingGrass.update(A);
motionScheduler.drain();
await movingGrass.whenSettled();
const outgoing = new Set(movingGrass.group.children);
const replacementFocus = { x: A.x + 40, z: A.z + 1 };
movingGrass.update(replacementFocus);
const retainedOutgoing = [...outgoing].filter((mesh) => movingGrass.group.children.includes(mesh));
assert(retainedOutgoing.length > outgoing.size * 0.6,
  "movement must retain the outgoing ring while replacement layers build");
assert(retainedOutgoing.some((mesh) => {
  const tile = parseTile(mesh);
  return tileDistance(tile, replacementFocus) >
    WILD_GRASS_LAYER_SPECS[tile.layer].visibleRadius + WILD_GRASS_STREAM_MARGIN;
}), "at least one exiting tile must cover the replacement build boundary");
motionScheduler.turn();
assert(retainedOutgoing.every((mesh) => movingGrass.group.children.includes(mesh)),
  "one partial build slice must retain outgoing coverage");
motionScheduler.drain();
await movingGrass.whenSettled();

// Superseding a partially sampled generation cancels every old descriptor and
// forbids a stale off-scene mesh from publishing at the new focus.
movingGrass.update({ x: A.x + 80, z: A.z + 10 });
for (let i = 0; i < 7; i++) motionScheduler.turn();
const staleBefore = movingGrass.group.userData.grassStreaming.staleJobs;
movingGrass.update(B);
motionScheduler.drain();
await movingGrass.whenSettled();
const afterMove = movingGrass.group.userData.grassStreaming;
assert(afterMove.staleJobs > staleBefore, "superseded generation must record canceled jobs");
assert.equal(afterMove.pendingJobs, 0);
for (const mesh of movingGrass.group.children) {
  const tile = parseTile(mesh);
  assert(
    tileDistance(tile, B) <= WILD_GRASS_LAYER_SPECS[tile.layer].visibleRadius + WILD_GRASS_STREAM_MARGIN,
    `${mesh.name} was stale-published outside the replacement ring`
  );
}

// Refresh and dispose also invalidate queued work. No queued continuation may
// republish after either lifecycle boundary.
movingGrass.update({ x: B.x + 16, z: B.z });
for (let i = 0; i < 5; i++) motionScheduler.turn();
const refreshGeneration = movingGrass.group.userData.grassStreaming.generation;
movingGrass.refresh();
assert(movingGrass.group.userData.grassStreaming.generation > refreshGeneration);
motionScheduler.drain();
await movingGrass.whenSettled();
assert.equal(movingGrass.group.userData.grassStreaming.retainedEntries, 0);

// Adversarial continuous 6.1m shifts cannot reset every partial tile. Four
// bounded scheduler turns per shift are enough for a still-desired nearest tile
// to make observable progress and publish while the player keeps walking.
const walkingScheduler = manualScheduler();
const walkingGrass = createWildGrass(MAP, undefined, {
  schedule: walkingScheduler.schedule,
  sliceBudgetMs: 0.5
});
let firstWalkingPublish = -1;
for (let step = 0; step < 40; step++) {
  walkingGrass.update({ x: A.x + step * 6.1, z: A.z });
  for (let turn = 0; turn < 4; turn++) walkingScheduler.turn();
  if (firstWalkingPublish < 0 && walkingGrass.group.children.length > 0) {
    firstWalkingPublish = step;
  }
}
assert(firstWalkingPublish >= 0, "continuous 6.1m shifts must not starve first grass publish");
assert(
  walkingGrass.group.userData.grassStreaming.preservedJobs > 0,
  "continuous movement must preserve still-desired partial jobs"
);
walkingScheduler.drain();
await walkingGrass.whenSettled();
assert(walkingGrass.stats.count > 0);
walkingGrass.dispose();

const disposeScheduler = manualScheduler();
const disposable = createWildGrass(MAP, undefined, { schedule: disposeScheduler.schedule });
disposable.update(A);
for (let i = 0; i < 5; i++) disposeScheduler.turn();
disposable.dispose();
disposeScheduler.drain();
assert.equal(disposable.group.children.length, 0, "disposed grass must reject every stale publish");
assert.equal(disposable.group.userData.grassStreaming.pendingJobs, 0);

movingGrass.dispose();
console.log("wild grass progressive streaming contract: ok", JSON.stringify({
  turnsToFirst,
  compiles,
  criticalPendingJobs,
  initialCount: 133501,
  initialDraws: 38,
  firstWalkingPublish,
  maxSampleStepsPerSlice: initialStreaming.maxSampleStepsPerSlice,
  maxUploadEntriesPerSlice: initialStreaming.maxUploadEntriesPerSlice,
  staleJobs: afterMove.staleJobs
}));
