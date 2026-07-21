import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { ghostShipPoseAt } from "../src/world/ghostShip/route.ts";

const URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
const OUTPUT = resolve(".data/ghost-ship/ghost-ship-runtime.png");
const STAIRS_OUTPUT = resolve(".data/ghost-ship/ghost-ship-stairs.png");
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
const entryRequests = [];
const errors = [];
page.on("request", (request) => {
  const url = request.url();
  if (/\/world\/ghostShip\/(?:index|collision|collisionLayout|effects|hotTubWater|tuning)\.ts(?:\?|$)/.test(url)) {
    detailRequests.push(url);
  }
  if (url.includes("/world/ghostShip/index.ts")) entryRequests.push(url);
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
  assert.equal(detailRequests.length, 0, "detailed ghost ship modules loaded before proximity/activation");
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
    assert(Number.isFinite(sample.ground), `${sample.name} landing has no finite terrain sample`);
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
  assert.equal(entryRequests.length, 1, "first activation should request exactly one detailed entry module");
  assert(
    detailRequests.some((url) => url.includes("/world/ghostShip/collision.ts")),
    "first activation did not load the lazy collision runtime"
  );

  const landing = await page.evaluate(() => {
    const sf = window.__sf;
    const ship = sf.ghostShip;
    const stairX = 14.05;
    const stairT = (14.35 - stairX) / (14.35 - 5.45);
    const stairSurface = -5 + (1.37 + 5) * stairT;
    const boarding = new sf.THREE.Vector3(stairX, stairSurface + 0.04, 11.5);
    ship.root.localToWorld(boarding);
    sf.player.respawn({ x: boarding.x, y: boarding.y, z: boarding.z, heading: 0 });
    sf.chase.yaw = ship.root.rotation.y + Math.PI / 2;
    sf.tick(1 / 60);
    return {
      landed: ship.stats.landed,
      landing: ship.stats.landing,
      stairsDeployed: ship.stats.stairsDeployed,
      stairsVisible: ship.root.getObjectByName("ghost_ship_landing_stairs")?.visible ?? false,
      flightGatesVisible: ship.root.getObjectByName("ghost_ship_flight_stair_gates")?.visible ?? false,
      stairInstances: ship.root.getObjectByName("ghost_ship_landing_stair_treads")?.count ?? 0,
      boarding: { x: boarding.x, y: boarding.y, z: boarding.z },
      near: ship.nearbyBoarding(sf.player.position)
    };
  });
  assert.equal(landing.landed, true);
  assert.equal(landing.landing, "Presidio parade ground");
  assert(landing.boarding.y > 0, "landing staircase resolved below sea level");
  assert.equal(landing.near, true, "landing staircase endpoint should be reachable on foot");
  assert.equal(landing.stairsDeployed, true, "landing collision stairs were not deployed");
  assert.equal(landing.stairsVisible, true, "landing stair visuals were hidden");
  assert.equal(landing.flightGatesVisible, false, "flight gates did not retract for landing");
  assert.equal(landing.stairInstances, 60, "four stairways should render fifteen steps each");

  mkdirSync(dirname(STAIRS_OUTPUT), { recursive: true });
  await page.evaluate(() => {
    const sf = window.__sf;
    const eye = new sf.THREE.Vector3(22, 5.5, 20);
    const target = new sf.THREE.Vector3(8.5, -1.2, 11.5);
    sf.ghostShip.root.localToWorld(eye);
    sf.ghostShip.root.localToWorld(target);
    window.__sfFreeCam([eye.x, eye.y, eye.z], [target.x, target.y, target.z]);
    sf.tick(1 / 60);
  });
  await page.screenshot({ path: STAIRS_OUTPUT });
  await page.evaluate(() => window.__sfFreeCam(null));

  await page.keyboard.down("w");
  const climbed = await page.evaluate(() => {
    const sf = window.__sf;
    let frames = 0;
    let local = sf.ghostShip.root.worldToLocal(sf.player.position.clone());
    for (; frames < 240 && local.x > 5.9; frames++) {
      sf.tick(1 / 60);
      local = sf.ghostShip.root.worldToLocal(sf.player.position.clone());
    }
    return {
      local: { x: local.x, y: local.y, z: local.z },
      near: sf.ghostShip.nearbyBoarding(sf.player.position),
      frames
    };
  });
  await page.keyboard.up("w");
  assert(climbed.local.x < 6.2, `walker did not climb the starboard stairs: x=${climbed.local.x}`);
  assert(climbed.local.y > 1.7, `walker did not reach deck height: y=${climbed.local.y}`);
  assert.equal(climbed.near, true, "top stair landing is not a valid boarding station");

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
  assert.equal(boarded.water.collisionBodies, 53, "ghost ship collision rig is incomplete");

  const activationRequestCount = detailRequests.length;
  await page.keyboard.press("e");
  await page.waitForFunction(
    () => window.__sf.embodiments.passengerOf === null && !window.__sf.player.riding,
    null,
    { timeout: 10_000 }
  );

  // Jump the shared clock into a shower window. The ship moves to its air route;
  // the on-foot capsule must retain its deck-local position rather than being
  // left behind in mid-air when the moving collision frame advances.
  const showerEpoch = Date.parse("2026-07-17T02:01:05.000Z"); // 19:01:05 PDT
  const airborne = await page.evaluate((epoch) => {
    const sf = window.__sf;
    for (let i = 0; i < 30; i++) sf.tick(1 / 60);
    const before = sf.player.position.clone();
    const beforeLocal = sf.ghostShip.root.worldToLocal(before.clone());
    sf.ghostShipBeacon.setClockOverride(epoch);
    for (let i = 0; i < 90; i++) sf.tick(1 / 60);
    const afterLocal = sf.ghostShip.root.worldToLocal(sf.player.position.clone());
    return {
      moved: before.distanceTo(sf.player.position),
      localErrorXZ: Math.hypot(afterLocal.x - beforeLocal.x, afterLocal.z - beforeLocal.z),
      localY: afterLocal.y,
      walkerAboard: sf.ghostShip.stats.walkerAboard,
      showerActive: sf.ghostShip.stats.showerActive,
      starsVisible: sf.ghostShip.stats.starsVisible,
      position: { x: sf.player.position.x, y: sf.player.position.y, z: sf.player.position.z }
    };
  }, showerEpoch);
  assert(airborne.moved > 100, "on-foot player did not follow the ship to its air route");
  assert(airborne.localErrorXZ < 0.5, "on-foot player drifted across the moving deck");
  assert.equal(airborne.walkerAboard, true, "moving collision frame did not retain the walker");
  assert(airborne.localY > 1.7 && airborne.localY < 3.5, "walker did not settle on the deck floor");
  assert.equal(airborne.showerActive, true);
  assert(airborne.starsVisible > 0, "rainbow star shower did not emit streaks");
  assert.equal(
    detailRequests.length,
    activationRequestCount,
    "walking the deck triggered an unexpected second optional-module load"
  );
  assert.equal(errors.length, 0, `browser errors:\n${errors.join("\n")}`);

  mkdirSync(dirname(OUTPUT), { recursive: true });
  await page.screenshot({ path: OUTPUT });
  console.log(JSON.stringify({ ok: true, landingTerrain, landing, climbed, boarded, airborne, entryRequests, detailRequests, screenshots: [STAIRS_OUTPUT, OUTPUT] }, null, 2));
} finally {
  await browser.close();
}
