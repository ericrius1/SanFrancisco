// Two-client passenger sync probe.
//
// Client A drives a car along the Golden Gate deck; client B glues into the
// passenger seat. On the DRIVER's client we measure, every rendered frame, the
// distance between the passenger avatar's root and the car mesh's live
// passenger-seat anchor. Before the ride-glue ordering fix this sat around
// speed × frame-time (0.2–0.5 m at cruise — the "passenger isn't in the car"
// glitch); after it the offset must be essentially zero. The passenger's own
// view of the seat is asserted tight too, and the ride must survive the drive.
//
// Usage: node tools/passenger-sync-probe.mjs   (dev server on 5240 by default;
// override with SF_PROBE_URL)

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
const DRIVE_MS = 9000;

function chromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  const result = candidates.find((candidate) => existsSync(candidate));
  if (!result) throw new Error("Chrome/Chromium not found; set CHROME_BIN");
  return result;
}

const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--hide-scrollbars",
    "--mute-audio"
  ]
});

const pages = [];
try {
  const errors = [[], []];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (error) => errors[i].push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors[i].push(message.text());
    });
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=goldenGate`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
  }
  const [driver, passenger] = pages;

  await Promise.all(pages.map((page) => page.waitForFunction(
    () => window.__sf?.player && window.__sf?.net?.status === "online" && window.__sf?.renderIdle?.(),
    undefined,
    { timeout: 180_000 }
  )));

  const driverId = await driver.evaluate(() => window.__sf.net.selfId);
  const passengerId = await passenger.evaluate(() => window.__sf.net.selfId);
  assert(driverId > 0 && passengerId > 0 && driverId !== passengerId, "both clients must be online");

  // Driver into the car on the deck; passenger stands beside the lane.
  await driver.evaluate(() => {
    const sf = window.__sf;
    const p = sf.player.position;
    sf.player.teleportTo({ x: p.x, y: p.y, z: p.z, facing: 0.07, mode: "drive" });
  });
  await passenger.evaluate(() => {
    const sf = window.__sf;
    const p = sf.player.position;
    sf.player.teleportTo({ x: p.x + 2, y: p.y, z: p.z, facing: 0.07, mode: "walk" });
  });

  // Passenger must see the driver's car before boarding it.
  await passenger.waitForFunction(
    (id) => window.__sf.remotes.avatars.get(id)?.mode === "drive",
    driverId,
    { timeout: 30_000 }
  );
  await passenger.evaluate((id) => window.__sf.embodiments.startPassengerRide(id, 1), driverId);

  // Driver sees the seat claim arrive over the wire.
  await driver.waitForFunction(
    (id) => window.__sf.remotes.avatars.get(id)?.ride === window.__sf.net.selfId,
    passengerId,
    { timeout: 30_000 }
  );

  // Per-frame seat-offset collector on the driver's client.
  await driver.evaluate((id) => {
    const sf = window.__sf;
    const seatWorld = new sf.THREE.Vector3();
    window.__probe = { frames: 0, glued: 0, sum: 0, max: 0, speedSum: 0 };
    const tick = () => {
      const probe = window.__probe;
      const avatar = sf.remotes.avatars.get(id);
      const mesh = sf.player.mode === "drive" ? sf.player.meshes.drive : null;
      probe.frames++;
      if (avatar && avatar.ride === sf.net.selfId && mesh) {
        const seat = mesh.userData.passengerSeat;
        seatWorld.set(seat[0], seat[1], seat[2]).applyQuaternion(mesh.quaternion).add(mesh.position);
        const d = seatWorld.distanceTo(avatar.root.position);
        probe.glued++;
        probe.sum += d;
        probe.max = Math.max(probe.max, d);
        probe.speedSum += sf.player.speed;
      }
      window.__probeRaf = requestAnimationFrame(tick);
    };
    tick();
  }, passengerId);

  // Passenger-side collector: my glued pose vs my view of the driver's seat.
  await passenger.evaluate((id) => {
    const sf = window.__sf;
    const seatWorld = new sf.THREE.Vector3();
    window.__probe = { frames: 0, glued: 0, sum: 0, max: 0 };
    const tick = () => {
      const probe = window.__probe;
      const avatar = sf.remotes.avatars.get(id);
      const body = avatar?.bodies.drive;
      probe.frames++;
      if (avatar && body && sf.embodiments.passengerOf === id) {
        const seat = body.userData.passengerSeat;
        seatWorld.set(seat[0], seat[1], seat[2]).applyQuaternion(avatar.root.quaternion).add(avatar.root.position);
        const d = seatWorld.distanceTo(sf.player.renderPosition);
        probe.glued++;
        probe.sum += d;
        probe.max = Math.max(probe.max, d);
      }
      window.__probeRaf = requestAnimationFrame(tick);
    };
    tick();
  }, driverId);

  await driver.keyboard.down("KeyW");
  await driver.waitForTimeout(DRIVE_MS);
  await driver.keyboard.up("KeyW");

  const driverView = await driver.evaluate(() => {
    cancelAnimationFrame(window.__probeRaf);
    return window.__probe;
  });
  const passengerView = await passenger.evaluate(() => {
    cancelAnimationFrame(window.__probeRaf);
    return window.__probe;
  });
  const rideIntact = await passenger.evaluate((id) => window.__sf.embodiments.passengerOf === id, driverId);

  const meanOffset = driverView.sum / Math.max(1, driverView.glued);
  const meanSpeed = driverView.speedSum / Math.max(1, driverView.glued);
  const passengerMean = passengerView.sum / Math.max(1, passengerView.glued);
  console.log(
    `[driver view] frames=${driverView.frames} glued=${driverView.glued} ` +
    `meanOffset=${meanOffset.toFixed(4)}m maxOffset=${driverView.max.toFixed(4)}m meanSpeed=${meanSpeed.toFixed(1)}m/s`
  );
  console.log(
    `[passenger view] frames=${passengerView.frames} glued=${passengerView.glued} ` +
    `meanOffset=${passengerMean.toFixed(4)}m maxOffset=${passengerView.max.toFixed(4)}m`
  );

  assert(rideIntact, "ride ended prematurely during the drive");
  assert(driverView.glued > 100, "driver view collected too few glued frames");
  assert(meanSpeed > 5, `car never got up to speed (${meanSpeed.toFixed(1)} m/s)`);
  assert(
    driverView.glued / driverView.frames > 0.95,
    "passenger avatar was not glued for part of the drive"
  );
  assert(meanOffset < 0.02, `driver-view mean seat offset ${meanOffset.toFixed(4)}m (want < 0.02)`);
  assert(driverView.max < 0.15, `driver-view max seat offset ${driverView.max.toFixed(4)}m (want < 0.15)`);
  assert(passengerMean < 0.05, `passenger-view mean seat offset ${passengerMean.toFixed(4)}m (want < 0.05)`);

  // 503s come from optional same-origin feeds (weather/starlink) the relay
  // proxies best-effort; they are unrelated to presence sync.
  const fatal = errors.flat().filter((e) => !/favicon|Autoplay|AudioContext|503 \(Service Unavailable\)/i.test(e));
  assert.deepEqual(fatal, [], `page errors: ${fatal.join(" | ")}`);
  console.log("passenger-sync-probe PASS");
} finally {
  await browser.close();
}
