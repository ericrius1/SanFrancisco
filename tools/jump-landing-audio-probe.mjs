import assert from "node:assert/strict";

import { JumpLandingAudio } from "../src/fx/jumpLandingAudio.ts";

const bus = {
  voiceBus() {
    return null;
  },
  touch() {
    throw new Error("A locked/headless bus must not be touched by a rendered voice");
  }
};

const audio = new JumpLandingAudio(bus, { random: () => 0.42 });
const frame = (grounded, verticalSpeed, horizontalSpeed = 0) =>
  audio.update(1 / 60, { active: true, grounded, verticalSpeed, horizontalSpeed });

// Priming a grounded player is silent. One rising edge creates one takeoff even
// when several airborne frames follow, and headless edge telemetry still works.
frame(true, 0);
frame(false, 7.2, 5);
assert.equal(audio.debugState.takeoffCount, 1);
assert.equal(audio.debugState.lastEvent, "takeoff");
assert.equal(audio.debugState.lastRenderStatus, "bus-unavailable");
for (let i = 0; i < 18; i++) frame(false, i < 7 ? 3 : -6.4, 5);
assert.equal(audio.debugState.takeoffCount, 1, "airborne hold must not retrigger takeoff");

frame(true, 0, 4.5);
assert.equal(audio.debugState.landingCount, 1);
assert.equal(audio.debugState.lastEvent, "landing");
assert.ok(audio.debugState.lastIntensity > 0.6, "real jump landing should retain impact energy");

// A short grounded-state flicker cannot produce either edge sound.
const beforeFlicker = audio.debugState;
audio.reset();
frame(true, 0);
frame(false, 0.1);
for (let i = 0; i < 3; i++) frame(false, -0.1);
frame(true, 0);
assert.equal(audio.debugState.takeoffCount, beforeFlicker.takeoffCount);
assert.equal(audio.debugState.landingCount, beforeFlicker.landingCount);

// Walking off a ledge has no push-off, but a sufficiently long fall still lands.
audio.reset();
frame(true, 0);
frame(false, 0.1, 2);
for (let i = 0; i < 10; i++) frame(false, -4.2, 2);
frame(true, 0, 2);
assert.equal(audio.debugState.takeoffCount, beforeFlicker.takeoffCount);
assert.equal(audio.debugState.landingCount, beforeFlicker.landingCount + 1);

// Inactive frames clear transition history, preventing mode-switch/respawn pops.
audio.update(1 / 60, null);
assert.equal(audio.debugState.primed, false);
assert.equal(audio.debugState.grounded, null);
assert.equal(audio.debugState.pendingEvent, null);

console.log("jump/landing audio probe: PASS", audio.debugState);
