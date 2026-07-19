// Headless browser contract for the player/interaction SFX pass.
// Run against an existing worktree server:
//   SF_PROBE_URL=http://127.0.0.1:5245 node tools/player-audio-browser-probe.mjs

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5245";
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
    "--autoplay-policy=no-user-gesture-required"
  ]
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const requests = [];
const errors = [];
page.on("request", (request) => requests.push(request.url()));
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

const matches = (needle) => requests.filter((url) => url.toLowerCase().includes(needle));

try {
  await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(() => window.__sf?.renderIdle?.(), null, { timeout: 120_000 });
  await page.waitForFunction(() => window.__sf?.worldArrival?.active === false, null, { timeout: 120_000 });
  await page.waitForTimeout(1200);

  // Optional tool audio must not exist in the clean boot waterfall.
  assert.equal(matches("paintaudio").length, 0, "clean boot eagerly requested paint audio");
  assert.equal(matches("bubbleaudio").length, 0, "clean boot eagerly requested bubble audio");

  // The HUD stays compact until requested, then exposes the four semantic mix
  // groups. Set an intentionally foreground-heavy mix for the live graph test.
  const mixerButton = page.locator("#hud .mixer-btn");
  const mixerPanel = page.locator("#hud .audio-sliders");
  assert.equal(await mixerPanel.isVisible(), false, "sound mixer should start collapsed");
  await mixerButton.click();
  assert.equal(await mixerPanel.isVisible(), true, "sound mixer did not open");
  assert.deepEqual(
    await page.locator("#hud .audio-lbl").allTextContents(),
    ["Music", "FX", "World", "Voice"],
    "sound mixer groups changed"
  );
  await page.locator('[data-kind="effects"]').evaluate((slider) => {
    slider.value = "80";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[data-kind="soundscape"]').evaluate((slider) => {
    slider.value = "20";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  if (process.env.SF_MIXER_SCREENSHOT) {
    await page.screenshot({ path: process.env.SF_MIXER_SCREENSHOT, fullPage: false });
  }
  await mixerButton.click();
  assert.equal(await mixerPanel.isVisible(), false, "sound mixer did not collapse");
  await page.evaluate(() => {
    window.__sf.gameplaySfxBus.voiceBus(0.5);
  });
  await page.waitForFunction(
    () => window.__sf.gameplaySfxBus.debugState.level > 0.63,
    null,
    { timeout: 2_000 }
  );
  const foregroundMix = await page.evaluate(() => window.__sf.gameplaySfxBus.debugState);
  assert(
    foregroundMix.level > 0.63,
    `foreground FX slider did not reach gameplay bus (${foregroundMix.level})`
  );

  // Real keyboard movement unlocks Web Audio and drives gait-synchronized steps.
  const walkSamples = [];
  await page.keyboard.down("w");
  for (let i = 0; i < 9; i++) {
    await page.waitForTimeout(250);
    walkSamples.push(await page.evaluate(() => ({
      speed: window.__sf.player.speed,
      grounded: window.__sf.player.walkGrounded,
      phase: window.__sf.player.walkStridePhase,
      steps: window.__sf.playerFoleyAudio.debugState.stepEvents
    })));
  }
  await page.keyboard.up("w");
  await page.waitForTimeout(250);
  const walking = await page.evaluate(() => ({
    foley: window.__sf.playerFoleyAudio.debugState,
    bus: window.__sf.gameplaySfxBus.debugState,
    player: {
      mode: window.__sf.player.mode,
      speed: window.__sf.player.speed,
      grounded: window.__sf.player.walkGrounded,
      position: window.__sf.player.position.toArray()
    },
    input: {
      suspended: window.__sf.input.suspended,
      locked: window.__sf.input.locked,
      freeCursor: window.__sf.input.freeCursor
    }
  }));
  assert(
    walking.foley.stepEvents >= 2,
    `walking emitted only ${walking.foley.stepEvents} steps: ${JSON.stringify({ walking, walkSamples })}`
  );
  assert.equal(walking.bus.unlocked, true, "movement gesture did not unlock gameplay SFX");

  // Exercise the grass sprint voice in the real browser graph without moving
  // the world to an unloaded region. The standalone probe covers edge math;
  // this confirms browser nodes and shared-bus lifecycle.
  const grass = await page.evaluate(() => {
    const audio = window.__sf.playerFoleyAudio;
    for (let i = 0; i < 18; i++) audio.update(1 / 60, {
      active: true,
      grounded: true,
      swimming: false,
      speed: 11.2,
      stridePhase: 200 + i * 0.25,
      surfaceType: 1,
      running: true,
      indoor: false
    });
    return audio.debugState;
  });
  assert.equal(grass.surface, "grass");
  assert(grass.rustle > 0.1, `grass sprint rustle stayed at ${grass.rustle}`);

  // A normal jump should create both edge events on ordinary ground.
  const jumpBefore = await page.evaluate(() => window.__sf.jumpLandingAudio.debugState);
  await page.keyboard.press("Space");
  await page.waitForTimeout(1900);
  const jumpAfter = await page.evaluate(() => window.__sf.jumpLandingAudio.debugState);
  assert(
    jumpAfter.takeoffCount > jumpBefore.takeoffCount,
    `jump takeoff did not fire (${jumpBefore.takeoffCount} -> ${jumpAfter.takeoffCount})`
  );
  assert(
    jumpAfter.landingCount > jumpBefore.landingCount,
    `jump landing did not fire (${jumpBefore.landingCount} -> ${jumpAfter.landingCount})`
  );

  // First optional activation requests exactly the paint chunk, then an actual
  // shot/impact can render through the already-unlocked shared bus.
  await page.evaluate(() => window.__sf.setTool("spray"));
  await page.waitForFunction(() => window.__sf.getPaintAudio() !== null, null, { timeout: 10_000 });
  assert(matches("paintaudio").length >= 1, "paint activation did not request its chunk");
  assert.equal(matches("bubbleaudio").length, 0, "paint activation also requested bubble audio");
  const paint = await page.evaluate(() => {
    const audio = window.__sf.getPaintAudio();
    const shot = audio.shot({ sourceId: "probe", pressure: 0.8 });
    const impact = audio.impact({ sourceId: "probe", material: "concrete", speed: 46 });
    return { shot, impact, state: audio.debugState };
  });
  assert.equal(paint.shot, true);
  assert.equal(paint.impact, true);
  assert.equal(paint.state.shots, 1);
  assert.equal(paint.state.impacts, 1);

  // The subsequent tool choice requests only its newly selected bubble chunk.
  const bubbleRequestsBefore = matches("bubbleaudio").length;
  await page.evaluate(() => window.__sf.setTool("bubbles"));
  await page.waitForFunction(() => window.__sf.getBubbleAudio() !== null, null, { timeout: 10_000 });
  assert(matches("bubbleaudio").length > bubbleRequestsBefore, "bubble activation did not request its chunk");
  const bubble = await page.evaluate(() => {
    const audio = window.__sf.getBubbleAudio();
    const blow = audio.blow({ duration: 0.25, sourceId: "probe" });
    const pop = audio.pop({ radius: 0.48, sourceId: "probe" });
    return { blow, pop, state: audio.debugState };
  });
  assert.equal(bubble.blow, true);
  assert.equal(bubble.pop, true);
  assert.equal(bubble.state.blowCount, 1);
  assert.equal(bubble.state.popCount, 1);

  const interactions = await page.evaluate(() => {
    const door = window.__sf.doorAudio.event("opened", { sourceId: "probe" });
    const before = window.__sf.modeTransitionAudio.debugState.played;
    window.__sf.modeTransitionAudio.event("walk", "board");
    return {
      door,
      doorState: window.__sf.doorAudio.debugState,
      modeBefore: before,
      modeAfter: window.__sf.modeTransitionAudio.debugState.played
    };
  });
  assert.equal(interactions.door, true);
  assert.equal(interactions.doorState.emitted.opened, 1);
  assert(interactions.modeAfter > interactions.modeBefore, "mode-transition voice did not render");

  assert.deepEqual(errors, [], `browser errors:\n${errors.join("\n")}`);
  console.log("player audio browser probe: PASS", {
    walking,
    grass,
    jump: jumpAfter,
    paint: paint.state,
    bubble: bubble.state,
    interactions,
    lazyRequests: {
      paint: matches("paintaudio"),
      bubble: matches("bubbleaudio")
    }
  });
} finally {
  await browser.close();
}
