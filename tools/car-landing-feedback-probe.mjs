// Headless end-to-end QA for height/fall-scaled car landing feedback.
//
// Runs against an existing dev server so the exact checkout can remain previewed:
//   SF_PROBE_URL=http://127.0.0.1:5268 node tools/car-landing-feedback-probe.mjs

// The probe performs two real Box3D drops, then checks that the larger drop
// produces a stronger bounded event, larger camera impulse, procedural audio
// event, and pooled smoke burst without requesting a landing media asset.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const OUT = path.resolve(ROOT, ".data/car-landing-feedback");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5268";
const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function waitForLanding(page, previousSerial, timeoutMs = 12000) {
  const started = Date.now();
  let maxShake = 0;
  let maxSmoke = 0;
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(() => {
      const sf = window.__sf;
      return {
        landing: { ...sf.player.driveLandingFeedback },
        shake: sf.chase.shakeAmount,
        fx: sf.fx.debugState,
        audio: sf.vehicleAudio.debugState
      };
    });
    maxShake = Math.max(maxShake, state.shake);
    maxSmoke = Math.max(maxSmoke, state.fx.byKind.smoke);
    if (
      state.landing.serial > previousSerial &&
      state.fx.carLandingBursts > 0 &&
      state.audio.carLandingEvents > 0
    ) {
      // One more poll catches the presentation frame even when the controller
      // serial was sampled just before main consumed it.
      await sleep(20);
      const after = await page.evaluate(() => ({
        landing: { ...window.__sf.player.driveLandingFeedback },
        shake: window.__sf.chase.shakeAmount,
        fx: window.__sf.fx.debugState,
        audio: window.__sf.vehicleAudio.debugState
      }));
      maxShake = Math.max(maxShake, after.shake);
      maxSmoke = Math.max(maxSmoke, after.fx.byKind.smoke);
      return { ...after, maxShake, maxSmoke };
    }
    await sleep(16);
  }
  throw new Error(`landing serial ${previousSerial + 1} did not arrive within ${timeoutMs}ms`);
}

async function dropCar(page, clearance) {
  const before = await page.evaluate(() => ({
    serial: window.__sf.player.driveLandingFeedback.serial,
    bursts: window.__sf.fx.debugState.carLandingBursts,
    audioEvents: window.__sf.vehicleAudio.debugState.carLandingEvents,
    resources: performance.getEntriesByType("resource").length
  }));
  await page.evaluate((dropClearance) => {
    const sf = window.__sf;
    const player = sf.player;
    const ground = sf.map.rideGround(player.position.x, player.position.z, player.position.y);
    const t = sf.physics.world.getBodyTransform(player.body);
    sf.physics.world.setBodyTransform(
      player.body,
      [player.position.x, ground + player.driveSpec.rideHeight + dropClearance, player.position.z],
      t.rotation
    );
    sf.physics.world.setBodyVelocity(player.body, [0, -0.1, 0], [0, 0, 0]);
  }, clearance);
  const result = await waitForLanding(page, before.serial);
  assert(result.fx.carLandingBursts === before.bursts + 1, "landing did not emit exactly one smoke burst");
  assert(result.audio.carLandingEvents === before.audioEvents + 1, "landing did not emit exactly one audio event");
  assert(result.maxSmoke > 0, "landing smoke never became active");
  assert(result.maxShake > 0, "landing camera impulse never became active");
  return { before, ...result };
}

async function main() {
  assert(existsSync(CHROME), `Chrome not found at ${CHROME}`);
  mkdirSync(OUT, { recursive: true });
  const errors = [];
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures",
      "--use-angle=metal",
      "--hide-scrollbars",
      "--mute-audio"
    ]
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await page.goto(`${SERVER_URL}/?autostart=1&fullfps=1&profile=1&spawn=coronaHeights`, {
      waitUntil: "domcontentloaded",
      timeout: 120000
    });
    await page.waitForFunction(
      () => window.__sf?.player && window.__sf?.renderIdle?.() && window.__sfManual,
      undefined,
      { timeout: 180000 }
    );
    await page.keyboard.press("KeyW"); // real gesture unlocks the existing vehicle AudioContext
    await page.waitForTimeout(250);

    await page.evaluate(() => {
      const sf = window.__sf;
      sf.sky.setTimeOfDay(14);
      const x = sf.player.position.x;
      const z = sf.player.position.z;
      const ground = sf.map.rideGround(x, z, sf.player.position.y);
      sf.player.teleportTo({ x, y: ground, z, facing: 0, mode: "drive" });
    });
    await page.waitForFunction(
      () => window.__sf.player.mode === "drive" && window.__sf.player.driveJumpState.readyForTakeoff,
      undefined,
      { timeout: 10000 }
    );

    const bootResources = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => entry.name)
    );
    const medium = await dropCar(page, 3);
    await page.waitForFunction(
      () => !window.__sf.player.driveJumpState.airborne && window.__sf.player.driveJumpState.readyForTakeoff,
      undefined,
      { timeout: 6000 }
    );
    await page.waitForTimeout(900); // let the first pooled smoke burst retire
    const high = await dropCar(page, 8);

    assert(
      high.landing.strength > medium.landing.strength,
      `larger drop was not stronger (${medium.landing.strength} vs ${high.landing.strength})`
    );
    assert(high.landing.strength <= 1, `landing strength escaped its range: ${high.landing.strength}`);
    assert(
      high.landing.height > medium.landing.height,
      `tracked jump height did not increase (${medium.landing.height} vs ${high.landing.height})`
    );
    assert(
      high.landing.fallDistance > medium.landing.fallDistance,
      `tracked fall distance did not increase (${medium.landing.fallDistance} vs ${high.landing.fallDistance})`
    );
    assert(
      high.maxShake > medium.maxShake,
      `camera shake did not scale (${medium.maxShake} vs ${high.maxShake})`
    );
    assert(
      high.maxSmoke >= medium.maxSmoke,
      `smoke count did not scale (${medium.maxSmoke} vs ${high.maxSmoke})`
    );
    assert(
      high.audio.lastCarLandingStrength > medium.audio.lastCarLandingStrength,
      "procedural landing audio strength did not scale"
    );
    assert(
      high.audio.lastCarLandingLevel > medium.audio.lastCarLandingLevel,
      "procedural landing audio level did not scale"
    );
    assert(
      medium.audio.lastCarLandingPeak >= 0.5 && high.audio.lastCarLandingPeak >= 1,
      `landing mix is too quiet (${medium.audio.lastCarLandingPeak} / ${high.audio.lastCarLandingPeak})`
    );

    // Capture while the high-drop smoke pool is still live, in authored daylight.
    const screenshotPath = path.join(OUT, "landing-feedback.png");
    const screenshot = await page.screenshot({ path: screenshotPath });
    const stats = await sharp(screenshot).stats();
    const maxDeviation = Math.max(...stats.channels.slice(0, 3).map((channel) => channel.stdev));
    assert(maxDeviation > 8, `browser screenshot looks blank (max stdev ${maxDeviation})`);

    await page.keyboard.press("Slash");
    await page.waitForTimeout(200);
    // textContent includes controls nested under collapsed Tweakpane folders;
    // innerText deliberately omits those hidden descendants.
    const tuningText = await page.locator("body").textContent();
    assert(tuningText.includes("landing feedback"), "car landing tuning folder is missing");
    assert(tuningText.includes("min jump height"), "height response control is missing");
    assert(tuningText.includes("smoke puffs max"), "smoke response control is missing");

    const finalResources = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => entry.name)
    );
    const landingRequests = finalResources
      .slice(bootResources.length)
      .filter((name) => /landing|car[-_ ]?impact|road[-_ ]?impact|\.(mp3|wav|ogg)(\?|$)/i.test(name));
    assert(
      landingRequests.length === 0,
      `landing feedback fetched optional media: ${landingRequests.join(", ")}`
    );
    assert(errors.length === 0, `page errors: ${errors.slice(0, 4).join(" | ")}`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          url: SERVER_URL,
          medium: {
            height: Number(medium.landing.height.toFixed(2)),
            fallDistance: Number(medium.landing.fallDistance.toFixed(2)),
            strength: Number(medium.landing.strength.toFixed(3)),
            soundPeak: Number(medium.audio.lastCarLandingPeak.toFixed(3)),
            maxShake: Number(medium.maxShake.toFixed(3)),
            maxSmoke: medium.maxSmoke
          },
          high: {
            height: Number(high.landing.height.toFixed(2)),
            fallDistance: Number(high.landing.fallDistance.toFixed(2)),
            strength: Number(high.landing.strength.toFixed(3)),
            soundPeak: Number(high.audio.lastCarLandingPeak.toFixed(3)),
            maxShake: Number(high.maxShake.toFixed(3)),
            maxSmoke: high.maxSmoke
          },
          audioContext: high.audio.ctx,
          audioEvents: high.audio.carLandingEvents,
          smokeBursts: high.fx.carLandingBursts,
          landingMediaRequests: landingRequests,
          screenshot: screenshotPath,
          screenshotMaxDeviation: Number(maxDeviation.toFixed(2)),
          errors
        },
        null,
        2
      )
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
