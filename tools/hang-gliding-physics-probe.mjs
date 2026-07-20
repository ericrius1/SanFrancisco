import assert from "node:assert/strict";
import {
  HANG_GLIDER_FLIGHT,
  stepHangGliderFlight
} from "../src/vehicles/plane/hangGliderPhysics.ts";
import { sampleHangGlidingLift } from "../src/gameplay/hangGliding/layout.ts";

const makeState = () => ({
  heading: 0,
  pitch: -0.04,
  bank: 0,
  airspeed: HANG_GLIDER_FLIGHT.launchSpeed
});

const run = (state, intent, seconds, thermalLift = 0) => {
  let result;
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    result = stepHangGliderFlight(state, intent, dt, thermalLift);
  }
  return result;
};

const neutral = makeState();
const neutralStep = run(neutral, { roll: 0, pitch: 0, tuck: false, flare: false }, 3);
assert.ok(neutralStep.verticalSpeed < -0.4, "neutral glide must descend");
assert.ok(neutral.airspeed > 18 && neutral.airspeed < 24, "neutral glide should settle near best glide");

const dive = makeState();
run(dive, { roll: 0, pitch: -1, tuck: true, flare: false }, 3);
assert.ok(dive.airspeed > neutral.airspeed + 7, "tucked dive must build airspeed");

const flared = { ...dive };
const flareStep = run(flared, { roll: 0, pitch: 1, tuck: false, flare: true }, 2);
assert.ok(flared.airspeed < dive.airspeed - 7, "flare must trade airspeed away");
assert.ok(flareStep.verticalSpeed > -5, "flare should remain controllable for touchdown");

const banked = makeState();
const bankStep = run(banked, { roll: 1, pitch: 0, tuck: false, flare: false }, 3);
assert.ok(Math.abs(banked.heading) > 0.8, "bank must produce a meaningful turn");
assert.ok(bankStep.sinkRate > neutralStep.sinkRate + 0.5, "bank load must cost altitude");

const thermal = makeState();
const thermalStep = run(thermal, { roll: 0, pitch: 0, tuck: false, flare: false }, 2, 5.5);
assert.ok(thermalStep.verticalSpeed > 3.5, "thermal core must produce sustained climb");

const stalled = makeState();
const stallStep = run(stalled, { roll: 0, pitch: 1, tuck: false, flare: true }, 5);
assert.equal(stallStep.stalled, true, "held bar-back flare must eventually stall");
assert.ok(stallStep.sinkRate > neutralStep.sinkRate * 3, "stall must deepen the sink polar");

const thermals = [{ x: 10, z: 20, radius: 100, strength: 6, baseY: 0, topY: 200 }];
const coreLift = sampleHangGlidingLift(thermals, 10, 20, 0);
const edgeLift = sampleHangGlidingLift(thermals, 95, 20, 0);
const outsideLift = sampleHangGlidingLift(thermals, 111, 20, 0);
assert.ok(coreLift > edgeLift * 20, "thermal lift must be concentrated in the core");
assert.equal(outsideLift, 0, "thermal lift must be zero outside its radius");

console.log(JSON.stringify({
  neutral: { speed: neutral.airspeed, sink: neutralStep.sinkRate },
  diveSpeed: dive.airspeed,
  flareSpeed: flared.airspeed,
  bank: banked.bank,
  heading: banked.heading,
  thermalClimb: thermalStep.verticalSpeed,
  stallSink: stallStep.sinkRate,
  lift: { core: coreLift, edge: edgeLift, outside: outsideLift }
}, null, 2));
