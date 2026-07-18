import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { advanceWindPhase, sampleWindGust, windResponseAlpha } from "../src/world/vegetation/windModel.ts";

assert.equal(advanceWindPhase(12.5, 1 / 60, 0), 12.5, "zero tempo must freeze wind phase");
assert.equal(advanceWindPhase(2, -1, 3), 2, "negative frame deltas must not rewind wind");
assert.equal(advanceWindPhase(2, 1, 3), 2.3, "long frames must use the bounded integration step");

let phase = 0;
let previous = sampleWindGust(phase);
let maxDelta = 0;
for (let frame = 0; frame < 60 * 180; frame++) {
  phase = advanceWindPhase(phase, 1 / 60, 3);
  const gust = sampleWindGust(phase);
  assert.ok(gust >= 0 && gust <= 1, `gust out of range: ${gust}`);
  maxDelta = Math.max(maxDelta, Math.abs(gust - previous));
  previous = gust;
}
assert.ok(maxDelta < 0.01, `high-tempo gust delta is too abrupt: ${maxDelta}`);

const fullStep = windResponseAlpha(1 / 60, 0.32);
const halfStep = windResponseAlpha(1 / 120, 0.32);
assert.ok(Math.abs((1 - halfStep) ** 2 - (1 - fullStep)) < 1e-12, "response must be frame-rate independent");

const swaySource = readFileSync(new URL("../src/world/groundcover/sway.ts", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("../src/world/vegetation/wind.ts", import.meta.url), "utf8");
assert.doesNotMatch(swaySource, /curl\.div\(curl\.length/, "zero-magnitude curl must never be normalized");
assert.match(swaySource, /baseDir\.add\(curl\.mul\(WIND_FLOW_CURL_GAIN\)\)/, "flow must be a bounded prevailing-wind perturbation");
assert.match(swaySource, /load\.clamp\(0\.08, 1\)/, "shared wind load must retain its non-reversing bound");
assert.doesNotMatch(swaySource, /time\.mul\(windSpeed/, "shader phase must use the integrated wind clock");
assert.doesNotMatch(runtimeSource, /Math\.random/, "gusts must stay deterministic and frame-rate independent");

console.log(JSON.stringify({ ok: true, highTempoMaxFrameDelta: maxDelta }, null, 2));
