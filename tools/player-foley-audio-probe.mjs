import assert from "node:assert/strict";

import { PlayerFoleyAudio } from "../src/fx/playerFoleyAudio.ts";

const updates = [];
const bus = {
  debugState: { ctx: "none", unlocked: false, level: 0, hold: 0 },
  voiceBus() {
    return null;
  },
  update(dt, continuous) {
    updates.push({ dt, continuous });
  }
};

const audio = new PlayerFoleyAudio(bus);
const frame = (stridePhase, overrides = {}) => audio.update(1 / 60, {
  active: true,
  grounded: true,
  swimming: false,
  speed: 5.2,
  stridePhase,
  surfaceType: 0,
  running: false,
  indoor: false,
  ...overrides
});

frame(0);
assert.equal(audio.debugState.stepEvents, 0, "priming a gait phase must stay silent");
frame(Math.PI + 0.01);
assert.equal(audio.debugState.stepEvents, 1, "one crossed half-cycle should emit one footfall");
frame(Math.PI * 2 + 0.01);
assert.equal(audio.debugState.stepEvents, 2, "the next half-cycle should alternate feet once");

audio.update(1 / 60, null);
frame(100);
assert.equal(audio.debugState.stepEvents, 2, "resuming at a distant phase must not replay stale steps");

for (let i = 0; i < 12; i++) frame(100 + i * 0.1, {
  speed: 11.2,
  surfaceType: 1,
  running: true
});
assert.equal(audio.debugState.surface, "grass");
assert.ok(audio.debugState.rustle > 0.08, "sprinting on grass should raise the foliage bed");
assert.equal(updates.at(-1)?.continuous, true, "live foliage should keep the shared bus awake");

for (let i = 0; i < 40; i++) frame(102 + i * 0.1, {
  speed: 0,
  surfaceType: 0,
  running: false
});
assert.ok(audio.debugState.rustle < 0.01, "leaving grass should release the foliage bed");

console.log("player foley audio probe: PASS", audio.debugState);
