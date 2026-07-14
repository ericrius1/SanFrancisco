// CPU-side contract for the native-tree landscape/horizon population handoff.
// Run: node --experimental-strip-types tools/native-tree-lod-transition-test.mjs

import assert from "node:assert/strict";
import {
  NATIVE_TREE_LOD_CHUNK_BIAS_SPREAD,
  NATIVE_TREE_LOD_TRANSITION_WIDTH,
  nativeTreeChunkLodBias,
  nativeTreeUsesHorizonLod,
  resolveNativeTreeLodTransition
} from "../src/world/nativeTreeForest/lodTransition.ts";

const biases = [];
for (let z = -12; z <= 12; z++) {
  for (let x = -12; x <= 12; x++) {
    const bias = nativeTreeChunkLodBias(x, z);
    biases.push(bias);
    assert.equal(bias, nativeTreeChunkLodBias(x, z), "chunk bias must be repeatable");
    assert(
      Math.abs(bias) <= NATIVE_TREE_LOD_CHUNK_BIAS_SPREAD,
      "chunk bias must remain inside the bounded spread"
    );
  }
}
assert(Math.min(...biases) < -10, "sampled chunks must reach the negative side of the stagger");
assert(Math.max(...biases) > 10, "sampled chunks must reach the positive side of the stagger");
assert(new Set(biases.map((bias) => bias.toFixed(4))).size > 600, "chunk stagger must be well distributed");

const center = 220;
const hysteresis = 14;
const outwardStart = center + hysteresis - NATIVE_TREE_LOD_TRANSITION_WIDTH;
const outwardFinish = center + hysteresis;
const inwardStart = center - hysteresis + NATIVE_TREE_LOD_TRANSITION_WIDTH;
const inwardFinish = center - hysteresis;

assert.equal(outwardStart, 210);
assert.equal(outwardFinish, 234, "outward settle must retain the old +14m endpoint");
assert.equal(inwardStart, 230);
assert.equal(inwardFinish, 206, "inward settle must retain the old -14m endpoint");

let priorFraction = -1;
let lod = /** @type {2 | 3} */ (2);
for (let distance = 200; distance <= 240; distance++) {
  const state = resolveNativeTreeLodTransition(distance, center, lod);
  assert(state.horizonFraction >= priorFraction, "outward horizon population must be monotonic");
  priorFraction = state.horizonFraction;
  lod = state.settledLod;
}
assert.equal(lod, 3);
assert.equal(resolveNativeTreeLodTransition(outwardStart, center, 2).horizonFraction, 0);
assert.equal(resolveNativeTreeLodTransition(222, center, 2).horizonFraction, 0.5);
assert.equal(resolveNativeTreeLodTransition(outwardFinish, center, 2).settledLod, 3);

priorFraction = 2;
lod = 3;
for (let distance = 240; distance >= 198; distance--) {
  const state = resolveNativeTreeLodTransition(distance, center, lod);
  assert(state.horizonFraction <= priorFraction, "inward horizon population must be monotonic");
  priorFraction = state.horizonFraction;
  lod = state.settledLod;
}
assert.equal(lod, 2);
assert.equal(resolveNativeTreeLodTransition(inwardStart, center, 3).horizonFraction, 1);
assert.equal(resolveNativeTreeLodTransition(218, center, 3).horizonFraction, 0.5);
assert.equal(resolveNativeTreeLodTransition(inwardFinish, center, 3).settledLod, 2);

// Reversing inside a band must walk the same population back, not choose a new
// random subset or jump to the opposite hysteresis band.
const outwardHalf = resolveNativeTreeLodTransition(222, center, 2);
const outwardQuarter = resolveNativeTreeLodTransition(216, center, outwardHalf.settledLod);
assert.equal(outwardHalf.direction, 1);
assert.equal(outwardQuarter.direction, 1);
assert.equal(outwardQuarter.horizonFraction, 0.25);

const ranks = Array.from({ length: 128 }, (_, index) => (index + 0.5) / 128);
for (const fraction of [0, 0.125, 0.25, 0.5, 0.875, 1]) {
  const horizon = ranks.filter((rank) => nativeTreeUsesHorizonLod(rank, fraction));
  const landscape = ranks.filter((rank) => !nativeTreeUsesHorizonLod(rank, fraction));
  assert.equal(horizon.length + landscape.length, ranks.length, "every tree must appear exactly once");
  assert.equal(new Set([...horizon, ...landscape]).size, ranks.length, "LOD populations must not overlap");
  assert.equal(horizon.length, Math.round(ranks.length * fraction));
}

console.log("native tree LOD transition contract: ok", JSON.stringify({
  chunkBiasRange: [Math.min(...biases), Math.max(...biases)].map((value) => +value.toFixed(3)),
  transitionWidth: NATIVE_TREE_LOD_TRANSITION_WIDTH,
  outwardBand: [outwardStart, outwardFinish],
  inwardBand: [inwardFinish, inwardStart],
  ranks: ranks.length
}));
