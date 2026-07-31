import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeFrameSequence, evaluateShadowTemporalProbe } from "./lib/shadow-temporal-analysis.mjs";

const makeFrame = (value, pixels = 64) => {
  const frame = new Uint8Array(pixels * 4);
  for (let i = 0; i < frame.length; i += 4) {
    frame[i] = value;
    frame[i + 1] = value;
    frame[i + 2] = value;
    frame[i + 3] = 255;
  }
  return frame;
};

const staticFrames = Array.from({ length: 10 }, () => makeFrame(80));
const smoothFrames = Array.from({ length: 17 }, (_, i) => makeFrame(40 + i));
const period2Frames = Array.from({ length: 17 }, (_, i) => makeFrame(i % 2 === 0 ? 40 : 80));
const period4HoldFrames = Array.from({ length: 17 }, (_, i) => makeFrame(40 + Math.floor(i / 4) * 8));

const smooth = analyzeFrameSequence(smoothFrames);
assert.equal(smooth.period2Score, 0);
assert.equal(smooth.period4Score, 0);

const period2 = analyzeFrameSequence(period2Frames);
assert(period2.period2Score > 0.99);

const period4 = analyzeFrameSequence(period4HoldFrames);
assert(period4.period4Score > 0.99);

const passing = evaluateShadowTemporalProbe({ staticFrames, motionFrames: smoothFrames });
assert.equal(passing.pass, true, passing.failures.join("; "));

const failing2 = evaluateShadowTemporalProbe({ staticFrames, motionFrames: period2Frames });
assert.equal(failing2.pass, false);
assert(failing2.failures.some((failure) => failure.includes("period-2")));

const failing4 = evaluateShadowTemporalProbe({ staticFrames, motionFrames: period4HoldFrames });
assert.equal(failing4.pass, false);
assert(failing4.failures.some((failure) => failure.includes("period-4")));

// Dynamic-map cadence is a presented-frame correctness contract. A previous
// governor parity gate turned Sutro's intentional 30 fps pocket into 15 Hz
// avatar shadows; self-shadow and wall projections then blinked in lockstep.
const clipmapSource = await readFile(
  new URL("../src/world/shadows/clipmapShadowNode.ts", import.meta.url),
  "utf8"
);
assert.doesNotMatch(clipmapSource, /heroShadowHalfRate/);
assert.match(
  clipmapSource,
  /if \(domain\.id === ["']hero["']\) reason \|= SHADOW_UPDATE_REASON\.EVERY_FRAME/
);

console.log("shadow temporal analysis: pass");
