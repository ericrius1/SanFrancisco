import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

const URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
const OUTPUT = resolve(".data/phoenix/phoenix-ground-mount.png");
const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error("Chrome not found; set CHROME_BIN");

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
const phoenixRequests = [];
const errors = [];
page.on("request", (request) => {
  if (request.url().includes("phoenix-hero")) phoenixRequests.push(request.url());
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto(`${URL}/?autostart=1&fullfps`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__sf?.renderIdle?.(), null, { timeout: 120_000 });
  await page.waitForFunction(
    () => window.__sf?.player?.walkGrounded && !window.__sf.player.worldArrivalHeld,
    null,
    { timeout: 60_000 }
  );
  assert.equal(phoenixRequests.length, 0, "Phoenix loaded before first use");

  const origin = await page.evaluate(() => {
    const p = window.__sf.player.position;
    return { x: p.x, y: p.y, z: p.z };
  });
  const heroResponse = page.waitForResponse(
    (response) => response.url().includes("/models/phoenix-hero.glb") && response.status() === 200,
    { timeout: 30_000 }
  );
  await page.evaluate(() => window.__sf.switchMode("bird"));
  await heroResponse;
  await page.waitForFunction(
    () => {
      const sf = window.__sf;
      return sf.player.mode === "walk" &&
        sf.abandonedMounts.debugMounts().some((mount) => mount.mode === "bird" && mount.parked) &&
        sf.player.meshes.bird.userData.phoenixAsset &&
        sf.player.meshes.bird.getObjectByName("phoenix_saddle");
    },
    null,
    { timeout: 30_000 }
  );

  const summoned = await page.evaluate(() => {
    const sf = window.__sf;
    const mount = sf.abandonedMounts.debugMounts().find((item) => item.mode === "bird" && item.parked);
    const rider = sf.player.meshes.bird.getObjectByName("phoenix_local_rider");
    return {
      mode: sf.player.mode,
      mount,
      passengerSeats: sf.player.meshes.bird.userData.passengerSeats,
      capacity: sf.player.meshes.bird.userData.rideCapacity,
      saddle: sf.player.meshes.bird.getObjectByName("phoenix_saddle")?.name,
      riderVisible: rider?.visible
    };
  });
  assert.equal(summoned.mode, "walk", "ground summon should leave the player on foot");
  assert.equal(summoned.mount.parked, true);
  assert.equal(summoned.mount.persistent, true);
  assert.equal(summoned.capacity, 2, "driver plus two passengers should fit");
  assert.equal(summoned.passengerSeats.length, 2);
  assert.notDeepEqual(summoned.passengerSeats[0], summoned.passengerSeats[1]);
  assert.equal(summoned.saddle, "phoenix_saddle");
  assert.equal(summoned.riderVisible, false, "parked summon must not duplicate the walking avatar");
  assert(Math.hypot(summoned.mount.x - origin.x, summoned.mount.z - origin.z) < 5.2);
  assert(Math.hypot(summoned.mount.x - origin.x, summoned.mount.z - origin.z) > 3.5);

  const boarding = await page.evaluate(() => {
    const sf = window.__sf;
    const mount = sf.abandonedMounts.debugMounts().find((item) => item.mode === "bird" && item.parked);
    if (!mount) throw new Error("summoned Phoenix was not interactable from E range");
    return mount;
  });
  await page.keyboard.press("e");
  await page.waitForFunction(
    () => window.__sf.player.mode === "bird" && window.__sf.player.meshes.bird.getObjectByName("phoenix_local_rider")?.visible,
    null,
    { timeout: 10_000 }
  );
  const boarded = await page.evaluate(() => {
    const sf = window.__sf;
    const body = sf.physics.world.getBodyTransform(sf.player.body);
    return {
      mode: sf.player.mode,
      bodyY: body.position[1],
      playerY: sf.player.position.y,
      waitingMounts: sf.abandonedMounts.debugMounts().filter((mount) => mount.mode === "bird" && mount.parked).length,
      riderVisible: sf.player.meshes.bird.getObjectByName("phoenix_local_rider")?.visible
    };
  });
  assert.equal(boarded.mode, "bird");
  assert.equal(boarded.waitingMounts, 0);
  assert.equal(boarded.riderVisible, true);
  assert(Math.abs(boarded.bodyY - boarding.y) < 1, "boarding invoked the old cruise-height lift");
  assert(boarded.bodyY < origin.y + 5, "grounded Phoenix spawned too high");
  assert.equal(phoenixRequests.length, 1, "summon and boarding should share one Phoenix load");

  const seats = await page.evaluate(() => {
    const sf = window.__sf;
    sf.remotes.setBirdAssetsEnabled(false);
    const driverId = 9101;
    const firstId = 9102;
    const secondId = 9103;
    const t = performance.now() - 200;
    const sample = (mode, x, ride, rideSeat) => ({
      t,
      mode,
      x,
      y: sf.player.position.y,
      z: sf.player.position.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      speed: 0,
      ride,
      rideSeat
    });
    sf.remotes.add({ id: driverId, name: "Phoenix Driver", hue: 20 });
    sf.remotes.sample(driverId, sample("bird", sf.player.position.x + 2, undefined, undefined));
    sf.remotes.update(1 / 60);
    const first = sf.remotes.nearestDriver(sf.player.position, 10)?.seat ?? 0;
    const seatOne = new sf.THREE.Vector3();
    const seatTwo = new sf.THREE.Vector3();
    const seatQuat = new sf.THREE.Quaternion();
    sf.remotes.ridePose(driverId, 1, seatOne, seatQuat);
    sf.remotes.ridePose(driverId, 2, seatTwo, seatQuat);
    const seatDistance = seatOne.distanceTo(seatTwo);

    sf.remotes.add({ id: firstId, name: "Friend One", hue: 120 });
    sf.remotes.sample(firstId, sample("walk", sf.player.position.x + 2, driverId, 1));
    sf.remotes.update(1 / 60);
    const second = sf.remotes.nearestDriver(sf.player.position, 10)?.seat ?? 0;

    sf.remotes.add({ id: secondId, name: "Friend Two", hue: 220 });
    sf.remotes.sample(secondId, sample("walk", sf.player.position.x + 2, driverId, 2));
    sf.remotes.update(1 / 60);
    const full = sf.remotes.nearestDriver(sf.player.position, 10);
    sf.remotes.remove(firstId);
    sf.remotes.remove(secondId);
    sf.remotes.remove(driverId);
    return { first, second, full: full?.id === driverId, seatDistance };
  });
  assert.equal(seats.first, 1);
  assert.equal(seats.second, 2);
  assert.equal(seats.full, false, "Phoenix must reject a third passenger");
  assert(seats.seatDistance > 1, "passengers were glued to the same saddle anchor");
  assert.equal(errors.length, 0, `browser errors:\n${errors.join("\n")}`);

  mkdirSync(dirname(OUTPUT), { recursive: true });
  await page.screenshot({ path: OUTPUT });
  console.log(JSON.stringify({ ok: true, origin, summoned, boarding, boarded, seats, phoenixRequests, screenshot: OUTPUT }, null, 2));
} finally {
  await browser.close();
}
