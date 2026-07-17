import assert from "node:assert/strict";
import {
  GHOST_SHIP_LANDMARK_NAME,
  GHOST_SHIP_RIDE_ID,
  GHOST_SHIP_SEAT_COUNT,
  ghostShipClaimSeat,
  ghostShipLandingsForCivilDate,
  ghostShipPoseForCivil
} from "../src/world/ghostShip/route.ts";

const ground = () => 18;
const base = { year: 2026, month: 7, day: 16, hour: 12 };

assert.equal(GHOST_SHIP_RIDE_ID < 0, true, "world ride id must not alias a player id");
assert.equal(GHOST_SHIP_SEAT_COUNT, 12, "public deck capacity changed unexpectedly");
assert.equal(GHOST_SHIP_LANDMARK_NAME, "Ghost Ship");
assert.equal(ghostShipClaimSeat([1, 2, 3]), 4);
assert.equal(ghostShipClaimSeat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 0);

const landings = ghostShipLandingsForCivilDate(base);
assert.ok(landings.length >= 8, "each day should land often across the city");
assert.equal(landings[0].name, "Marina Green");
assert.ok(landings.some((l) => l.name === "Presidio parade ground"));

const presidio = ghostShipPoseForCivil({ ...base, hour: 21.35 }, ground);
assert.equal(presidio.landed, true, "the Presidio evening stop should be on the ground at mid-window");
assert.equal(presidio.landingName, "Presidio parade ground");
assert.equal(presidio.y, 23.2, "landed keel clearance should follow sampled terrain");
assert.equal(presidio.pitch, 0);
assert.equal(presidio.roll, 0);

const marina = ghostShipPoseForCivil({ ...base, hour: 8.45 }, ground);
assert.equal(marina.landed, true, "morning Marina Green stop should be on the ground");
assert.equal(marina.landingName, "Marina Green");

const late = landings[landings.length - 1];
const latePose = ghostShipPoseForCivil(
  { ...base, hour: (late.startHour + late.endHour) * 0.5 },
  ground
);
assert.equal(latePose.landed, true, "late-night landing should be on the ground");
assert.equal(latePose.landingName, late.name);

const airA = ghostShipPoseForCivil({ ...base, hour: 10 }, ground);
const airB = ghostShipPoseForCivil({ ...base, hour: 10.1 }, ground);
assert.equal(airA.landed, false);
assert.ok(Math.hypot(airB.x - airA.x, airB.z - airA.z) > 5, "air route should continuously roam");

const shower = ghostShipPoseForCivil({ ...base, hour: 19 + 1 / 60 }, ground);
assert.equal(shower.showerActive, true, "deterministic nighttime shower window should activate");

console.log("ghost ship contract: route, frequent landings, shared ride id, and shower cadence passed");
