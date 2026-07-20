// Deterministic CityGen streaming policy contract.
// Run with: node --experimental-strip-types tools/citygen-detail-policy-test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  aabbDistance2,
  compareDetailAdmission,
  footprintSurfaceDistance2,
  shouldAdmitNewDetail,
} from "../src/world/citygen/stream/detailAdmission.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const boundsOf = (poly) => ({
  minx: Math.min(...poly.map(([x]) => x)),
  maxx: Math.max(...poly.map(([x]) => x)),
  minz: Math.min(...poly.map(([, z]) => z)),
  maxz: Math.max(...poly.map(([, z]) => z)),
});

const coreRadius = 80;
const coreRadius2 = coreRadius * coreRadius;
// A long block whose nearest facade is 10 m away but whose centroid is 135 m
// away must beat a smaller building outside the guaranteed footprint core.
const longBlock = [[10, -10], [260, -10], [260, 10], [10, 10]];
const longBounds = boundsOf(longBlock);
const longSurface2 = footprintSurfaceDistance2(longBlock, longBounds, 0, 0, coreRadius2);
assert.equal(longSurface2, 100, "long-block facade distance should be measured from its footprint edge");
assert.equal(aabbDistance2(longBounds, 0, 0), 100, "AABB broad-phase should match the rectangular footprint");

const outsideBlock = [[130, -5], [140, -5], [140, 5], [130, 5]];
const outsideSurface2 = footprintSurfaceDistance2(outsideBlock, boundsOf(outsideBlock), 0, 0, coreRadius2);
assert.equal(outsideSurface2, Infinity, "outside-core footprints should stop at the cheap AABB broad-phase");

const coreMetric = { centerDistance2: 135 ** 2, surfaceDistance2: longSurface2, sticky: false };
const outerMetric = { centerDistance2: 130 ** 2, surfaceDistance2: outsideSurface2, sticky: false };
assert.ok(
  compareDetailAdmission(coreMetric, outerMetric, coreRadius2, 0.76) < 0,
  "a nearby facade must rank ahead of an outer building with a closer centroid",
);

assert.equal(
  shouldAdmitNewDetail(true, coreMetric.centerDistance2, 160 ** 2, 90_000, 1),
  true,
  "the guaranteed core must not be rejected by the legacy facade-cost remainder",
);
assert.equal(
  shouldAdmitNewDetail(false, outerMetric.centerDistance2, 160 ** 2, 90_000, 1),
  false,
  "outer-ring architecture must retain the facade-cost guardrail",
);
assert.equal(
  shouldAdmitNewDetail(false, outerMetric.centerDistance2, 160 ** 2, 500, 1_000),
  true,
  "an affordable outer candidate inside the speed-adjusted band should remain eligible",
);

const worldSystemsSource = readFileSync(path.join(ROOT, "src", "app", "compose", "worldSystemsNet.ts"), "utf8");
const cityGenStart = worldSystemsSource.indexOf("const citygenMod = await import(\"../../world/citygen\")");
const cityGenEnd = worldSystemsSource.indexOf("// Legacy procedural-spawn probes", cityGenStart);
assert.ok(cityGenStart >= 0 && cityGenEnd > cityGenStart, "CityGen lazy-start block should remain discoverable");
const cityGenBlock = worldSystemsSource.slice(cityGenStart, cityGenEnd);
assert.doesNotMatch(
  cityGenBlock,
  /waitForWorldBackgroundWindow/,
  "destination-critical CityGen startup/owner preparation must not re-enter the movement-quiet gate",
);
assert.match(
  cityGenBlock,
  /beforeRenderOwnership:\s*\(isCurrent\)\s*=>\s*waitForCityGenRenderWindow\(isCurrent\)/,
  "detached owner preparation must carry its current-owner predicate into the host gate",
);
assert.match(
  cityGenBlock,
  /prepareRenderOwner:\s*\(owner\)\s*=>\s*pipeline\.prepareSceneOwner\(owner\)/,
  "CityGen owners must compile in the live beauty scene-pass context",
);

const admissionSource = readFileSync(path.join(ROOT, "src", "app", "compose", "backgroundAdmission.ts"), "utf8");
assert.match(
  admissionSource,
  /const waitForCityGenRenderWindow[\s\S]*?while \(isArrivalActive\(\) \|\| !revealSettled\(\)\)[\s\S]*?isCurrent && !isCurrent\(\)/,
  "the CityGen owner gate must remain arrival-aware and cancellable",
);

const ringSource = readFileSync(path.join(ROOT, "src", "world", "citygen", "stream", "ring.ts"), "utf8");
assert.match(
  ringSource,
  /beforeRenderOwnership\?\.\(isCurrent\)/,
  "the ring must pass the current-owner predicate before WebGPU compilation",
);
assert.doesNotMatch(
  ringSource,
  /ActiveChunkPrepare|chunk-lod:cell:/,
  "CityGen must warm shared prototypes rather than compile every streamed cell",
);
assert.match(
  ringSource,
  /shouldAdmitNewDetail\(inCore, centerDistance2, admissionR2, c, costLeft\)/,
  "the guaranteed core and legacy outer-cost policy must share the tested admission helper",
);

console.log(JSON.stringify({
  ok: true,
  coreRadius,
  longBlock: { centroidDistance: 135, facadeDistance: Math.sqrt(longSurface2) },
  contracts: {
    postRevealLazyImport: true,
    movementQuietGateExcluded: true,
    ownerPredicateForwarded: true,
    scenePassContextPreparation: true,
    prototypeOnlyChunkWarmup: true,
    corePrecedesLegacyCost: true,
  },
}, null, 2));
