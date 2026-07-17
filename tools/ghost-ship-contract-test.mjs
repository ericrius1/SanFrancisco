import assert from "node:assert/strict";
import {
  GHOST_SHIP_RIDE_ID,
  GHOST_SHIP_SEAT_COUNT,
  ghostShipLandingsForCivilDate,
  ghostShipPoseForCivil
} from "../src/world/ghostShip/route.ts";

const ground = () => 18;
const base = { year: 2026, month: 7, day: 16, hour: 12 };

assert.equal(GHOST_SHIP_RIDE_ID < 0, true, "world ride id must not alias a player id");
assert.equal(GHOST_SHIP_SEAT_COUNT, 12, "public deck capacity changed unexpectedly");

const presidio = ghostShipPoseForCivil({ ...base, hour: 21.58 }, ground);
assert.equal(presidio.landed, true, "the guaranteed Presidio stop should be on the ground at mid-window");
assert.equal(presidio.landingName, "Presidio parade ground");
assert.equal(presidio.y, 23.2, "landed keel clearance should follow sampled terrain");
assert.equal(presidio.pitch, 0);
assert.equal(presidio.roll, 0);

let oneLandingDate = null;
let twoLandingDate = null;
for (let day = 1; day <= 28; day++) {
  const civil = { ...base, day };
  const count = ghostShipLandingsForCivilDate(civil).length;
  if (count === 1) oneLandingDate = civil;
  if (count === 2) twoLandingDate = civil;
}
assert.ok(oneLandingDate, "date hash should produce occasional one-stop nights");
assert.ok(twoLandingDate, "date hash should produce occasional two-stop nights");

const secondLanding = ghostShipLandingsForCivilDate(twoLandingDate)[1];
const secondPose = ghostShipPoseForCivil(
  { ...twoLandingDate, hour: (secondLanding.startHour + secondLanding.endHour) * 0.5 },
  ground
);
assert.equal(secondPose.landed, true, "two-stop nights should include the late landing");
assert.equal(secondPose.landingName, secondLanding.name);

const airA = ghostShipPoseForCivil({ ...base, hour: 10 }, ground);
const airB = ghostShipPoseForCivil({ ...base, hour: 10.1 }, ground);
assert.equal(airA.landed, false);
assert.ok(Math.hypot(airB.x - airA.x, airB.z - airA.z) > 5, "air route should continuously roam");

const shower = ghostShipPoseForCivil({ ...base, hour: 19 + 1 / 60 }, ground);
assert.equal(shower.showerActive, true, "deterministic nighttime shower window should activate");

console.log("ghost ship contract: route, nightly landings, shared ride id, and shower cadence passed");
