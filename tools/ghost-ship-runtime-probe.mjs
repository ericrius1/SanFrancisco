import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { ghostShipPoseAt } from "../src/world/ghostShip/route.ts";

const URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
const OUTPUT = resolve(".data/ghost-ship/ghost-ship-runtime.png");
const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error("Chrome not found; set CHROME_BIN");

const cleanBootSpawns = [
  { key: "landsEnd", x: -5872, z: 792 },
  { key: "marinRedwoods", x: -3150, z: -5100 },
  { key: "salesforce", x: 4117, z: 130 },
  { key: "coronaHeights", x: 398, z: 2752 }
];
const currentPose = ghostShipPoseAt(Date.now(), () => 0);
const cleanBootSpawn = cleanBootSpawns.reduce((best, candidate) => {
  const distance = Math.hypot(candidate.x - currentPose.x, candidate.z - currentPose.z);
  return distance > best.distance ? { key: candidate.key, distance } : best;
}, { key: cleanBootSpawns[0].key, distance: -1 });

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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const detailRequests = [];
const errors = [];
page.on("request", (request) => {
  if (request.url().includes("/world/ghostShip/index.ts")) detailRequests.push(request.url());
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  // Pick the registered spawn farthest from the live wall-clock route, proving
  // the optional chunk is absent from clean boot while its tiny proxy remains.
  await page.goto(`${URL}/?autostart=1&fullfps&spawn=${cleanBootSpawn.key}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__sf?.renderIdle?.(), null, { timeout: 120_000 });
  await page.waitForFunction(
    () => window.__sf?.player?.walkGrounded && !window.__sf.player.worldArrivalHeld,
    null,
    { timeout: 60_000 }
  );
  assert.equal(detailRequests.length, 0, "detailed ghost ship chunk loaded before proximity/activation");
  const landingTerrain = await page.evaluate(() => {
    const map = window.__sf.map;
    return [
      ["Marina Green", -700, -2350],
      ["Golden Gate Park polo field", -5000, 2500],
      ["Botanical Garden Great Meadow", -2260, 2450],
      ["Corona Heights meadow", 350, 2700],
      ["Mission Dolores Park", 1480, 3120],
      ["Presidio parade ground", -1680, -1050],
      ["Fort Mason lawn", 1180, -1750]
    ].map(([name, x, z]) => ({
      name,
      x,
      z,
      water: map.isWater(x, z),
      ground: map.effectiveGround(x, z)
    }));
  });
  for (const sample of landingTerrain) {
    assert.equal(sample.water, false, `${sample.name} landing is not on dry ground`);
  }

  // Guaranteed Presidio stop, mid hold window (2026-07-16 21:34:48 PDT).
  const landingEpoch = Date.parse("2026-07-17T04:34:48.000Z");
  await page.evaluate((epoch) => {
    const sf = window.__sf;
    sf.ghostShipBeacon.setClockOverride(epoch);
    sf.tick(1 / 60);
    sf.ensureGhostShipDetail();
  }, landingEpoch);
  await page.waitForFunction(() => window.__sf?.ghostShip?.root?.visible, null, { timeout: 60_000 });
  assert.equal(detailRequests.length, 1, "first activation should request exactly one detailed entry chunk");

  const landing = await page.evaluate(() => {
    const sf = window.__sf;
    const ship = sf.ghostShip;
    const boarding = new sf.THREE.Vector3(9, -3.7, 13);
    ship.root.localToWorld(boarding);
    sf.player.respawn({ x: boarding.x, y: boarding.y, z: boarding.z, heading: 0 });
    sf.tick(1 / 60);
    return {
      landed: ship.stats.landed,
      landing: ship.stats.landing,
      boarding: { x: boarding.x, y: boarding.y, z: boarding.z },
      near: ship.nearbyBoarding(sf.player.position)
    };
  });
  assert.equal(landing.landed, true);
  assert.equal(landing.landing, "Presidio parade ground");
  assert(landing.boarding.y > 0, "landing gangplank resolved below sea level");
  assert.equal(landing.near, true, "landing gangplank endpoint should be reachable on foot");

  await page.keyboard.press("e");
  await page.waitForFunction(
    () => window.__sf.embodiments.passengerOf === -1001 && window.__sf.player.riding,
    null,
    { timeout: 10_000 }
  );

  const boarded = await page.evaluate(() => {
    const sf = window.__sf;
    for (let i = 0; i < 8; i++) sf.tick(1 / 60);
    return {
      ride: sf.embodiments.passengerOf,
      seat: sf.embodiments.passengerSeat,
      water: { ...sf.ghostShip.stats },
      position: { x: sf.player.position.x, y: sf.player.position.y, z: sf.player.position.z }
    };
  });
  assert.equal(boarded.ride, -1001);
  assert(boarded.seat >= 1 && boarded.seat <= 12);
  assert.equal(boarded.water.waterRunning, true, "near/ridden hot-tub compute solver did not run");
  assert(boarded.water.waterDispatches > 0, "hot-tub solver emitted no WebGPU dispatches");
  assert(boarded.water.steamVisible > 0, "ridden ship should wake hot-tub steam");

  // Jump the shared clock into a shower window. The ship moves to its air route;
  // the local passenger must remain on the matching world seat.
  const showerEpoch = Date.parse("2026-07-17T02:01:05.000Z"); // 19:01:05 PDT
  const airborne = await page.evaluate((epoch) => {
    const sf = window.__sf;
    const before = sf.player.position.clone();
    sf.ghostShipBeacon.setClockOverride(epoch);
    for (let i = 0; i < 90; i++) sf.tick(1 / 60);
    const expected = new sf.THREE.Vector3();
    const quaternion = new sf.THREE.Quaternion();
    sf.ghostShip.seatPose(sf.embodiments.passengerSeat, expected, quaternion);
    return {
      moved: before.distanceTo(sf.player.position),
      seatError: expected.distanceTo(sf.player.position),
      showerActive: sf.ghostShip.stats.showerActive,
      starsVisible: sf.ghostShip.stats.starsVisible,
      position: { x: sf.player.position.x, y: sf.player.position.y, z: sf.player.position.z }
    };
  }, showerEpoch);
  assert(airborne.moved > 100, "world passenger did not follow the ship to its air route");
  assert(airborne.seatError < 0.05, "world passenger drifted off the deterministic deck anchor");
  assert.equal(airborne.showerActive, true);
  assert(airborne.starsVisible > 0, "rainbow star shower did not emit streaks");
  assert.equal(errors.length, 0, `browser errors:\n${errors.join("\n")}`);

  mkdirSync(dirname(OUTPUT), { recursive: true });
  await page.screenshot({ path: OUTPUT });
  console.log(JSON.stringify({ ok: true, landingTerrain, landing, boarded, airborne, detailRequests, screenshot: OUTPUT }, null, 2));
} finally {
  await browser.close();
}
