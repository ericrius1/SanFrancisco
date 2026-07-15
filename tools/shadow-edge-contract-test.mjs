import assert from "node:assert/strict";
import {
  CLIPMAP_SHADOW_EDGES,
  shadowMapEdgeWeight
} from "../src/world/shadows/edgeConfig.ts";

const heroHalfExtent = 16;
const hero = CLIPMAP_SHADOW_EDGES.hero;
const heroFadeEnd = heroHalfExtent - hero.sampleMarginMeters;
assert(heroFadeEnd < heroHalfExtent, "hero fade must finish inside the projection");
assert.equal(
  shadowMapEdgeWeight(heroHalfExtent, heroHalfExtent, hero.fadeMeters, hero.sampleMarginMeters),
  0,
  "hero visibility must be neutral before the PCF footprint reaches the edge"
);
assert.equal(
  shadowMapEdgeWeight(heroFadeEnd - hero.fadeMeters, heroHalfExtent, hero.fadeMeters, hero.sampleMarginMeters),
  1,
  "hero fade no longer preserves the projection interior"
);

let previous = 1;
let largestStep = 0;
for (let radius = heroFadeEnd - hero.fadeMeters; radius <= heroHalfExtent; radius += 0.01) {
  const weight = shadowMapEdgeWeight(radius, heroHalfExtent, hero.fadeMeters, hero.sampleMarginMeters);
  assert(weight <= previous + 1e-12, "hero edge retirement is not monotonic");
  largestStep = Math.max(largestStep, previous - weight);
  previous = weight;
}
assert(largestStep < 0.004, `hero edge retirement has a visible step (${largestStep})`);

const localHalfExtent = 48;
const local = CLIPMAP_SHADOW_EDGES.local;
const localFadeEnd = localHalfExtent - local.sampleMarginMeters;
const localFadeStart = localFadeEnd - local.fadeMeters;
assert(localFadeEnd < localHalfExtent, "local fade must finish inside the projection");
assert(
  local.fadeMeters >= localHalfExtent * 0.45,
  "local fade is too narrow to hide broad low-sun projection boundaries"
);
assert(
  localFadeStart <= localHalfExtent * 0.5,
  "local shadows remain fully opaque too close to the projection edge"
);
assert.equal(
  shadowMapEdgeWeight(localHalfExtent, localHalfExtent, local.fadeMeters, local.sampleMarginMeters),
  0,
  "local visibility must be neutral before the PCF footprint reaches the edge"
);

previous = 1;
largestStep = 0;
for (let radius = localFadeStart; radius <= localHalfExtent; radius += 0.01) {
  const weight = shadowMapEdgeWeight(radius, localHalfExtent, local.fadeMeters, local.sampleMarginMeters);
  assert(weight <= previous + 1e-12, "local edge retirement is not monotonic");
  largestStep = Math.max(largestStep, previous - weight);
  previous = weight;
}
assert(largestStep < 0.001, `local edge retirement has a visible step (${largestStep})`);
assert(
  512 - CLIPMAP_SHADOW_EDGES.far.sampleMarginMeters < 512,
  "far raster fade still ends on its projection boundary"
);

console.log("shadow projection edges: pass");
