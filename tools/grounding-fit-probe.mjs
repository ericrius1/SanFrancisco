// Deterministic regression coverage for ground-cover footprint seating.
// Run: node --experimental-strip-types tools/grounding-fit-probe.mjs

import assert from "node:assert/strict";

import { fitGroundY } from "../src/world/groundcover/grounding.ts";

assert.equal(
  fitGroundY(() => 12.5, 4, -3, 2, 0, 0.125),
  12.625,
  "flat ground should preserve the configured root offset"
);

const plane = (x, z) => 10 + x * 0.5 - z * 0.25;
assert.equal(
  fitGroundY(plane, 4, -2, 2, 3),
  11.5,
  "a planar footprint should seat at its minimum sampled height"
);

for (const badHeight of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  let calls = 0;
  const oneBadSample = () => (++calls === 4 ? badHeight : 7);
  assert.equal(fitGroundY(oneBadSample, 0, 0, 1, 1), null, "non-finite samples must be rejected");
}

const validSample = () => 7;
for (const args of [
  [Number.NaN, 0, 1, 1, 0],
  [0, Number.POSITIVE_INFINITY, 1, 1, 0],
  [0, 0, Number.NaN, 1, 0],
  [0, 0, 1, Number.POSITIVE_INFINITY, 0],
  [0, 0, 1, 1, Number.NEGATIVE_INFINITY]
]) {
  assert.equal(fitGroundY(validSample, ...args), null, "non-finite fit options must be rejected");
}
assert.equal(fitGroundY(validSample, 0, 0, -1, 1), null, "negative footprint radius must be rejected");
assert.equal(fitGroundY(validSample, 0, 0, 1, -1), null, "negative maxRise must be rejected");
assert.equal(
  fitGroundY(() => Number.MAX_VALUE, 0, 0, 1, 0, Number.MAX_VALUE),
  null,
  "a finite input combination that overflows the fitted height must be rejected"
);

const exactThreshold = (x) => x;
assert.equal(
  fitGroundY(exactThreshold, 0, 0, 1, 2),
  -1,
  "a footprint whose rise equals maxRise should be accepted"
);
assert.equal(
  fitGroundY(exactThreshold, 0, 0, 1, 2 - Number.EPSILON),
  null,
  "a footprint whose rise exceeds maxRise should be rejected"
);

let zeroRadiusCalls = 0;
assert.equal(
  fitGroundY(() => {
    zeroRadiusCalls += 1;
    return 3.25;
  }, 8, -5, 0, 0, 0.05),
  3.3,
  "a zero-radius footprint should remain valid"
);
assert.equal(zeroRadiusCalls, 5, "a zero-radius footprint should still follow the five-sample contract");

console.log("grounding-fit probe: ok");
