// Contract for the player-following toroidal foliage field: progressive first
// fill, entering-slab updates, stable overlap, authoring channels, teleports,
// and latest-request-wins cancellation.
//
//   node tools/foliage-field-contract-test.mjs

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.SF_FOLIAGE_FIELD_BUNDLED !== "1") {
  const { build } = await import("esbuild");
  const output = fileURLToPath(new URL("../.data/foliage-field-test/contract.mjs", import.meta.url));
  mkdirSync(fileURLToPath(new URL("../.data/foliage-field-test/", import.meta.url)), { recursive: true });
  await build({
    entryPoints: [fileURLToPath(import.meta.url)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    define: { "process.env.SF_FOLIAGE_FIELD_BUNDLED": '"1"' },
    logLevel: "silent"
  });
  const result = spawnSync(process.execPath, [output], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const {
  FOLIAGE_FIELD_SIZE,
  FOLIAGE_FIELD_SPACING,
  FoliageField,
  foliageFieldCellStyle,
  foliageFieldUv
} = await import("../src/world/groundcover/foliageField.ts");

function manualScheduler() {
  const jobs = [];
  return {
    jobs,
    schedule(job) { jobs.push(job); },
    turn() {
      const job = jobs.shift();
      if (!job) return false;
      if (job() === "again") jobs.push(job);
      return true;
    },
    drain(limit = 10_000) {
      let turns = 0;
      while (jobs.length) {
        assert(turns++ < limit, "foliage field must settle within the scheduler cap");
        this.turn();
      }
      return turns;
    }
  };
}

const scheduler = manualScheduler();
const sampled = [];
const field = new FoliageField({
  groundHeight(x, z) {
    sampled.push([x, z]);
    return 70 + x * 0.01 - z * 0.02;
  },
  plantable(x, z) { return (Math.floor(x) + Math.floor(z)) % 5 !== 0; },
  paint(x, z) {
    return x === 0 && z === 0 ? { density: 0.25, species: 0.75, height: 1.5 } : null;
  },
  schedule: scheduler.schedule,
  now: () => 0
});

const initialPromise = field.request({ x: 0, z: 0 });
assert.equal(field.stats.ready, false);
assert.equal(field.stats.pendingCells, FOLIAGE_FIELD_SIZE ** 2);
assert(scheduler.jobs.length > 0, "first request must be progressive, not synchronous");
scheduler.drain();
await initialPromise;
assert.equal(field.stats.ready, true);
assert.equal(field.stats.sampledCells, FOLIAGE_FIELD_SIZE ** 2);
assert.equal(field.stats.fullRebuilds, 1);
assert.equal(field.stats.slabUpdates, 0);
assert.equal(field.stats.uploadedBytes, field.data.byteLength);

function texel(cellX, cellZ) {
  const wrap = (value) => ((value % FOLIAGE_FIELD_SIZE) + FOLIAGE_FIELD_SIZE) % FOLIAGE_FIELD_SIZE;
  const offset = (wrap(cellZ) * FOLIAGE_FIELD_SIZE + wrap(cellX)) * 4;
  return Array.from(field.data.slice(offset, offset + 4));
}

const origin = texel(0, 0);
assert(Math.abs(origin[0] - 70) < 1e-6);
assert(Math.abs(origin[1] - 0.25) < 1e-6);
assert(Math.abs(origin[2] - 0.75) < 1e-6);
assert(Math.abs(origin[3] - 1.5) < 1e-6);
const stableCell = { x: 40, z: -20 };
const stableBefore = texel(stableCell.x, stableCell.z);
assert(Math.abs(stableBefore[2] - foliageFieldCellStyle(stableCell.x, stableCell.z)) < 1e-6);

const uv = foliageFieldUv(-1, -1);
assert(uv.x >= 0 && uv.x < 1 && uv.y >= 0 && uv.y < 1, "negative world cells must wrap to valid UVs");
assert(Math.abs(uv.x * FOLIAGE_FIELD_SIZE - (FOLIAGE_FIELD_SIZE - 0.5)) < 1e-9);

const samplesBeforeSlab = field.stats.sampledCells;
const slabPromise = field.request({ x: 6 * FOLIAGE_FIELD_SPACING, z: 0 });
scheduler.drain();
await slabPromise;
assert.equal(field.stats.sampledCells - samplesBeforeSlab, 6 * FOLIAGE_FIELD_SIZE);
assert.equal(field.stats.fullRebuilds, 1);
assert.equal(field.stats.slabUpdates, 1);
assert.deepEqual(texel(stableCell.x, stableCell.z), stableBefore, "overlap texels must not be resampled");

const samplesBeforeTeleport = field.stats.sampledCells;
const teleportPromise = field.request({ x: FOLIAGE_FIELD_SIZE * 3, z: -FOLIAGE_FIELD_SIZE * 2 });
scheduler.drain();
await teleportPromise;
assert.equal(field.stats.sampledCells - samplesBeforeTeleport, FOLIAGE_FIELD_SIZE ** 2);
assert.equal(field.stats.fullRebuilds, 2);

// The stale promise resolves, but only the newest request is allowed to publish
// bounds or upload a generation.
const stale = field.request({ x: 1000, z: 1000 });
assert(scheduler.turn());
const latestFocus = { x: 1200, z: -900 };
const latest = field.request(latestFocus);
scheduler.drain();
await Promise.all([stale, latest]);
assert.equal(field.stats.centerX, Math.floor(latestFocus.x) - 0.5);
assert.equal(field.stats.centerZ, Math.floor(latestFocus.z) - 0.5);
assert.equal(field.stats.ready, true);

field.dispose();
assert.rejects(() => field.request({ x: 0, z: 0 }), /disposed/);

console.log("foliage field contract passed", {
  size: FOLIAGE_FIELD_SIZE,
  sampledCells: field.stats.sampledCells,
  fullRebuilds: field.stats.fullRebuilds,
  slabUpdates: field.stats.slabUpdates,
  uploadedMiB: Number((field.stats.uploadedBytes / 1024 / 1024).toFixed(2))
});
