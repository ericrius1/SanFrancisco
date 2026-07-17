// Focused regression probe for the procedural residential ribbon lamps.
// Bundles and calls the production TypeScript directly, with a tiny in-memory
// localStorage stand-in for the persisted tuning module.
//
//   npm run test:citygen:lamps
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};

const bundled = await build({
  stdin: {
    contents: `
      export { buildInterior } from './src/world/citygen/interior/interior.ts';
      export { PROCEDURAL_LAMP_TUNING } from './src/world/citygen/interior/lampTuning.ts';
    `,
    resolveDir: ROOT,
    sourcefile: "citygen-lamp-probe-entry.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent",
});
const production = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const { buildInterior, PROCEDURAL_LAMP_TUNING } = production;
const tuning = PROCEDURAL_LAMP_TUNING.values;

const specForSeed = (seed) => ({
  i: 0,
  id: 810000 + seed,
  seed,
  poly: [[0, 0], [12, 0], [12, 15], [0, 15]],
  streetEdge: 0,
  doorAllowed: true,
  base: 0,
  grade: 0,
  top: 3.6,
  archetype: "victorian",
});
const lampPanels = (built) => built.panels.filter((panel) => panel.materialId.startsWith("int.lamp."));
const triangleCount = (panels) => panels.reduce((sum, panel) => sum + panel.indices.length / 3, 0);
const hashLamp = (built) => {
  const hash = crypto.createHash("sha256");
  for (const panel of lampPanels(built)) {
    hash.update(panel.materialId);
    hash.update(Buffer.from(new Float64Array(panel.positions).buffer));
    hash.update(Buffer.from(new Float64Array(panel.normals).buffer));
    hash.update(Buffer.from(new Uint32Array(panel.indices).buffer));
  }
  return hash.digest("hex");
};
const hashRoomWithoutLamp = (built) => {
  const hash = crypto.createHash("sha256");
  for (const panel of built.panels.filter((entry) => !entry.materialId.startsWith("int.lamp."))) {
    hash.update(panel.materialId);
    hash.update(Buffer.from(new Float64Array(panel.positions).buffer));
    hash.update(Buffer.from(new Float64Array(panel.normals).buffer));
    hash.update(Buffer.from(new Float64Array(panel.uvs).buffer));
    hash.update(Buffer.from(new Uint32Array(panel.indices).buffer));
  }
  hash.update(JSON.stringify(built.colliders));
  return hash.digest("hex");
};
const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };

// Force a fixture into every eligible room so topology tests do not depend on
// the authored 82% distribution default.
tuning.enabled = true;
tuning.coverage = 1;
tuning.finish = "brass";
tuning.lightTone = "warm";
tuning.rings = 5;
const first = buildInterior(specForSeed(17), "residential");
const second = buildInterior(specForSeed(17), "residential");
const firstLampPanels = lampPanels(first);
expect(firstLampPanels.length >= 3, `expected metal/cable/glow lamp buckets, found ${firstLampPanels.length}`);
expect(firstLampPanels.some((panel) => panel.materialId === "int.lamp.brass"), "gilded brass bucket missing");
expect(firstLampPanels.some((panel) => panel.materialId === "int.lamp.cable"), "suspension cable bucket missing");
expect(firstLampPanels.some((panel) => panel.materialId === "int.lamp.glow"), "warm glow bucket missing");
expect(hashLamp(first) === hashLamp(second), "same building/tuning did not generate byte-identical lamp geometry");
for (const panel of firstLampPanels) {
  expect(panel.positions.every(Number.isFinite), `${panel.materialId} contains a non-finite position`);
  expect(panel.normals.every(Number.isFinite), `${panel.materialId} contains a non-finite normal`);
  expect(panel.indices.every(Number.isInteger), `${panel.materialId} contains a non-integer index`);
}

// Compact coastal homes are still homes: fixture eligibility must not depend on
// the legacy grand-chandelier style tier.
const compactMarina = buildInterior({
  ...specForSeed(23),
  archetype: "marina",
  poly: [[0, 0], [6, 0], [6, 12], [0, 12]],
}, "residential");
expect(lampPanels(compactMarina).length > 0, "compact tier-0 Marina home did not receive a procedural lamp");

tuning.rings = 2;
const sparse = buildInterior(specForSeed(17), "residential");
const sparseTriangles = triangleCount(lampPanels(sparse));
tuning.rings = 8;
const dense = buildInterior(specForSeed(17), "residential");
const denseTriangles = triangleCount(lampPanels(dense));
expect(denseTriangles > sparseTriangles, `8 rings (${denseTriangles} tris) should exceed 2 rings (${sparseTriangles} tris)`);
expect(
  hashRoomWithoutLamp(sparse) === hashRoomWithoutLamp(dense),
  "changing ring count perturbed non-lamp room geometry or colliders",
);

tuning.rings = 5;
tuning.finish = "aged";
tuning.lightTone = "amber";
const alternate = lampPanels(buildInterior(specForSeed(17), "residential"));
expect(alternate.some((panel) => panel.materialId === "int.lamp.brass.aged"), "aged-brass selection did not change material bucket");
expect(alternate.some((panel) => panel.materialId === "int.lamp.glow.amber"), "amber selection did not change glow bucket");

tuning.enabled = false;
const disabled = buildInterior(specForSeed(17), "residential");
expect(lampPanels(disabled).length === 0, "disabled generator still emitted procedural lamp panels");
expect(disabled.panels.some((panel) => panel.materialId === "int.glow"), "disabled generator did not retain the legacy light fallback");

// Default-like coverage should distribute fixtures across a seed sweep rather
// than collapsing to all-or-none due to an RNG stream regression.
tuning.enabled = true;
tuning.coverage = 0.82;
tuning.finish = "brass";
tuning.lightTone = "warm";
let homesWithLamp = 0;
for (let seed = 1; seed <= 80; seed++) {
  if (lampPanels(buildInterior(specForSeed(seed), "residential")).length) homesWithLamp++;
}
expect(homesWithLamp >= 55 && homesWithLamp <= 80, `82% coverage produced lamps in ${homesWithLamp}/80 homes`);

const report = {
  ok: failures.length === 0,
  deterministic: hashLamp(first) === hashLamp(second),
  lampBuckets: firstLampPanels.map((panel) => panel.materialId).sort(),
  triangleScaling: { rings2: sparseTriangles, rings8: denseTriangles },
  roomStableAcrossRingCounts: hashRoomWithoutLamp(sparse) === hashRoomWithoutLamp(dense),
  compactMarinaLamp: lampPanels(compactMarina).length > 0,
  distributedHomes: `${homesWithLamp}/80`,
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
