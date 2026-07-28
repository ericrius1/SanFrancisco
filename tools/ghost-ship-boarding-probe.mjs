/**
 * Landing on the ghost ship while it is actually moving.
 *
 * The runtime probe checks a rider who is *already* standing on the deck, and
 * it does so through a frozen clock override — a ship that never moves, which
 * is exactly the case every carry bug hides behind. This one drives the shared
 * clock forward every tick and parks itself in the fastest stretch of the route
 * (the ~18 m/s climb out of a landing), then drops a walker onto the deck from
 * a height, keeps them there, walks them about, and jumps them.
 *
 * Run against a dev server: SF_PROBE_URL=http://localhost:5240 node tools/ghost-ship-boarding-probe.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { ghostShipPoseAt } from "../src/world/ghostShip/route.ts";
import { GHOST_SHIP_DECK_TOP } from "../src/world/ghostShip/collisionLayout.ts";

const URL = process.env.SF_PROBE_URL ?? "http://localhost:5240";
const OUTPUT = resolve(".data/ghost-ship/ghost-ship-boarding.png");
const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error("Chrome not found; set CHROME_BIN");

/** Capsule centre when the walker is standing: deck top + half the capsule. */
const DECK_REST_Y = GHOST_SHIP_DECK_TOP + 0.9;

// The route's own top speed, found rather than assumed: the climb-out from a
// landing is two orders of magnitude quicker than the cruise, and it is the
// only part of the day where a carry bug is visible at 60 fps.
const dayStart = Date.parse("2026-07-17T07:00:00.000Z");
const fastEpochs = [];
const airborneEpochs = [];
for (let minute = 0; minute < 24 * 60; minute++) {
  const at = dayStart + minute * 60_000;
  const a = ghostShipPoseAt(at, () => 0);
  const b = ghostShipPoseAt(at + 2000, () => 0);
  if (a.landed) continue;
  airborneEpochs.push(at);
  const speed = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 2;
  fastEpochs.push({ at, speed, x: a.x, z: a.z });
}
fastEpochs.sort((left, right) => right.speed - left.speed);
const fastest = fastEpochs[0];
assert(fastest.speed > 5, `route never exceeds 5 m/s (peak ${fastest.speed.toFixed(2)})`);

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--mute-audio"
  ]
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

/** Advance the shared route clock in lockstep with the fixed step. */
const HARNESS = `
  const sf = window.__sf;
  const ship = sf.ghostShip;
  window.__sfClock ??= 0;
  const step = () => {
    window.__sfClock += 1000 / 60;
    sf.ghostShipBeacon.setClockOverride(window.__sfClock);
    sf.tick(1 / 60);
  };
  const local = () => ship.root.worldToLocal(sf.player.position.clone());
  const placeOnDeck = (x, y, z) => {
    const spot = new sf.THREE.Vector3(x, y, z);
    ship.root.localToWorld(spot);
    sf.player.respawn({ x: spot.x, y: spot.y, z: spot.z, heading: 0 });
  };
`;

try {
  await page.goto(`${URL}/?autostart=1&fullfps&spawn=marinRedwoods`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__sf?.renderIdle?.(), null, { timeout: 180_000 });
  await page.waitForFunction(
    () => window.__sf?.player?.walkGrounded && !window.__sf.player.worldArrivalHeld,
    null,
    { timeout: 90_000 }
  );

  await page.evaluate((epoch) => {
    const sf = window.__sf;
    window.__sfClock = epoch;
    sf.ghostShipBeacon.setClockOverride(epoch);
    sf.tick(1 / 60);
    sf.ensureGhostShipDetail();
  }, fastest.at);
  await page.waitForFunction(() => window.__sf?.ghostShip?.root?.visible, null, { timeout: 90_000 });

  const shipSpeed = await page.evaluate(`(() => {
    ${HARNESS}
    const before = ship.root.position.clone();
    step();
    return ship.root.position.distanceTo(before) * 60;
  })()`);
  assert(shipSpeed > 5, `probe parked in a slow stretch of the route (${shipSpeed.toFixed(2)} m/s)`);

  // --- a walker dropped onto the deck lands on it and stays -----------------
  const drops = [];
  for (const height of [6, 18]) {
    const drop = await page.evaluate(`(() => {
      ${HARNESS}
      placeOnDeck(0, ${height} + 1.37, 2);
      let peakAfterLanding = -Infinity;
      let landedFrame = -1;
      for (let i = 0; i < 300; i++) {
        step();
        const p = local();
        if (landedFrame < 0 && sf.player.walkGrounded && p.y < ${DECK_REST_Y} + 0.2) landedFrame = i;
        if (landedFrame >= 0) peakAfterLanding = Math.max(peakAfterLanding, p.y);
      }
      const settled = local();
      const before = settled.clone();
      for (let i = 0; i < 300; i++) step();
      const after = local();
      return {
        landedFrame,
        peakAfterLanding,
        restY: after.y,
        driftXZ: Math.hypot(after.x - before.x, after.z - before.z),
        aboard: ship.stats.walkerAboard,
        grounded: sf.player.walkGrounded
      };
    })()`);
    drops.push({ height, ...drop });

    assert(drop.landedFrame >= 0, `${height} m drop never landed on the moving deck`);
    assert(
      Math.abs(drop.restY - DECK_REST_Y) < 0.12,
      `${height} m drop did not come to rest on the deck (local y ${drop.restY.toFixed(3)})`
    );
    // The bug this probe exists for: the capsule burrows into the moving deck,
    // the solver ejects it, and each bounce throws it higher until it is gone.
    assert(
      drop.peakAfterLanding < DECK_REST_Y + 0.35,
      `${height} m drop was bounced off the deck (peaked at local y ${drop.peakAfterLanding.toFixed(3)})`
    );
    assert(
      drop.driftXZ < 0.35,
      `${height} m drop slid ${drop.driftXZ.toFixed(2)} m across the deck while standing still`
    );
    assert.equal(drop.aboard, true, `${height} m drop is no longer carried by the deck`);
    assert.equal(drop.grounded, true, `${height} m drop never regained its footing on the deck`);
  }

  // Pixels, not just numbers: a walker on their feet on the flying deck.
  mkdirSync(dirname(OUTPUT), { recursive: true });
  await page.evaluate(`(() => {
    ${HARNESS}
    sf.hud.setHidden(true);
    const eye = new sf.THREE.Vector3(13, 5.6, 15);
    const target = new sf.THREE.Vector3(0, 2.1, 1);
    ship.root.localToWorld(eye);
    ship.root.localToWorld(target);
    window.__sfFreeCam([eye.x, eye.y, eye.z], [target.x, target.y, target.z]);
    step();
  })()`);
  await page.screenshot({ path: OUTPUT });
  await page.evaluate(() => {
    window.__sfFreeCam(null);
    window.__sf.hud.setHidden(false);
  });

  // --- walking the moving deck moves at walking pace ------------------------
  await page.evaluate(`(() => {
    ${HARNESS}
    placeOnDeck(2.2, 2.4, -4);
    sf.chase.yaw = ship.root.rotation.y + Math.PI;
    for (let i = 0; i < 90; i++) step();
  })()`);
  await page.keyboard.down("w");
  const walked = await page.evaluate(`(() => {
    ${HARNESS}
    const before = local();
    for (let i = 0; i < 90; i++) step();
    const after = local();
    return {
      travelled: Math.hypot(after.x - before.x, after.z - before.z),
      y: after.y,
      aboard: ship.stats.walkerAboard
    };
  })()`);
  await page.keyboard.up("w");
  assert(
    walked.travelled > 3 && walked.travelled < 14,
    `deck walk covered ${walked.travelled.toFixed(2)} m in 1.5 s — not a walking pace`
  );
  assert(
    Math.abs(walked.y - DECK_REST_Y) < 0.2,
    `walking the moving deck left the floor (local y ${walked.y.toFixed(3)})`
  );
  assert.equal(walked.aboard, true, "walking the deck dropped the carry");

  // --- jumping lands you back on the same deck spot -------------------------
  await page.evaluate(`(() => {
    ${HARNESS}
    for (let i = 0; i < 60; i++) step();
  })()`);
  const jumped = await page.evaluate(`(() => {
    ${HARNESS}
    window.__sfJumpBefore = local();
    return { y: window.__sfJumpBefore.y };
  })()`);
  await page.keyboard.press("Space");
  const jump = await page.evaluate(`(() => {
    ${HARNESS}
    let peak = -Infinity;
    for (let i = 0; i < 180; i++) {
      step();
      peak = Math.max(peak, local().y);
    }
    const after = local();
    const before = window.__sfJumpBefore;
    return {
      peak,
      restY: after.y,
      driftXZ: Math.hypot(after.x - before.x, after.z - before.z),
      grounded: sf.player.walkGrounded
    };
  })()`);
  assert(jump.peak > jumped.y + 1, `jump aboard the moving ship barely left the deck (${jump.peak.toFixed(2)})`);
  assert(
    Math.abs(jump.restY - DECK_REST_Y) < 0.12,
    `jump aboard the moving ship did not land back on the deck (local y ${jump.restY.toFixed(3)})`
  );
  assert(
    jump.driftXZ < 1.5,
    `jump aboard the moving ship drifted ${jump.driftXZ.toFixed(2)} m down the deck`
  );
  assert.equal(jump.grounded, true, "jump aboard the moving ship never landed");

  // --- entering walk over open water keeps you on the deck ------------------
  // Half the air route is over the bay and the Pacific. The walk entry hops a
  // body standing in water to the nearest shore; a deck is not water, and a
  // rider stepping off a mount onto one must not be flung inland.
  const overWater = await page.evaluate(`((candidates) => {
    ${HARNESS}
    // Park on the first stretch of route that is genuinely over open water.
    let water = false;
    for (const epoch of candidates) {
      window.__sfClock = epoch;
      sf.ghostShipBeacon.setClockOverride(epoch);
      sf.tick(1 / 60);
      if (sf.map.isWater(ship.root.position.x, ship.root.position.z)) {
        water = true;
        break;
      }
    }
    if (!water) return { water: false };
    placeOnDeck(0, 2.4, 2);
    for (let i = 0; i < 90; i++) step();
    const before = local();
    // The exact path a dismount takes: leave walk, land the body on the deck,
    // re-enter walk — which is what runs the shore hop.
    sf.player.trySwitch("plane");
    const spot = new sf.THREE.Vector3(before.x, 2.4, before.z);
    ship.root.localToWorld(spot);
    sf.player.position.copy(spot);
    sf.player.trySwitch("walk");
    for (let i = 0; i < 120; i++) step();
    const after = local();
    return {
      water: true,
      hopped: Math.hypot(after.x - before.x, after.z - before.z),
      restY: after.y,
      grounded: sf.player.walkGrounded
    };
  })(${JSON.stringify(airborneEpochs)})`);
  assert.equal(overWater.water, true, "route never passed over water on the sampled day");
  assert(
    overWater.hopped < 3,
    `entering walk on the deck hopped ${overWater.hopped.toFixed(1)} m to shore`
  );
  assert(
    Math.abs(overWater.restY - DECK_REST_Y) < 0.2,
    `entering walk on the deck left the floor (local y ${overWater.restY.toFixed(3)})`
  );
  assert.equal(overWater.grounded, true, "entering walk on the deck lost its footing");

  assert.equal(errors.length, 0, `browser errors:\n${errors.join("\n")}`);
  console.log(
    JSON.stringify(
      {
        ok: true,
        routePeakSpeed: +fastest.speed.toFixed(2),
        shipSpeed: +shipSpeed.toFixed(2),
        drops,
        walked,
        jump,
        overWater,
        screenshot: OUTPUT
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
