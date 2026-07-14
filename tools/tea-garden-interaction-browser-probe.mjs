// Browser regression probe for the player-facing Tea Master interaction path.
// Verifies both physical keyboard E and the standard-gamepad Y button (RDR2-style
// interact) rather than calling JapaneseTeaGarden.interact() directly.
//
// Run: node tools/tea-garden-interaction-browser-probe.mjs
// Env: SF_PROBE_URL (default http://127.0.0.1:5240), CHROME_BIN

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import sharp from "sharp";

const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
const OUT = ".data/tea-garden-interaction";

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  const chrome = candidates.find((candidate) => existsSync(candidate));
  if (!chrome) throw new Error("No Chrome found. Set CHROME_BIN.");
  return chrome;
}

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--mute-audio"
  ]
});

try {
  mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  const teaRequests = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/src/world/japaneseTeaGarden/") && !url.endsWith("/layout.ts")) {
      teaRequests.push(url);
    }
  });

  // Reproduce the player report from a clean distant boot: select the real
  // minimap landmark, teleport to the entrance, approach Hiro, then press E.
  await page.goto(`${SERVER_URL}/?autostart=1&fullfps=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(
    () => window.__sf?.player && document.body.classList.contains("started"),
    undefined,
    { timeout: 150_000 }
  );
  assert.deepEqual(teaRequests, [], "clean distant boot eagerly requested the Tea Garden");

  console.log("[probe] teleporting from the minimap to the Tea Garden entrance");
  const target = await page.evaluate(() => window.__sf.minimap.focusLandmark("Japanese Tea Garden"));
  assert.ok(target, "Tea Garden minimap landmark is missing");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    ({ x, z }) => Math.hypot(window.__sf.player.position.x - x, window.__sf.player.position.z - z) < 25,
    target,
    { timeout: 30_000 }
  );
  await page.waitForFunction(
    () => window.__sf?.japaneseTeaGarden?.debugState?.().awake,
    undefined,
    { timeout: 150_000 }
  );
  await page.waitForFunction(
    () => window.__sf.japaneseTeaGarden.group.parent === window.__sf.scene,
    undefined,
    { timeout: 150_000 }
  );
  const atEntrance = await page.evaluate(() => window.__sf.japaneseTeaGarden.debugState().guide);
  assert.equal(atEntrance.phase, "idle", "the entrance teleport corrupted Hiro's idle interaction state");
  assert.ok(atEntrance.playerDistance > 12.5, "the teleport did not exercise the far entrance state");
  assert.ok(
    teaRequests.some((url) => url.includes("/japaneseTeaGarden/index.ts")),
    "first approach did not request the Tea Garden feature"
  );

  // Move to the endpoint of the user's walk. The state transition and real E
  // event are what regressed; respawning here keeps the browser probe quick and
  // deterministic without bypassing the minimap/lazy-activation path.
  const hiroPosition = atEntrance.hiro.position;
  await page.evaluate(([x, , z]) => {
    window.__sf.player.respawn({ x: x - 3.7, z, heading: -Math.PI / 2 });
    window.__sf.chase.yaw = -Math.PI / 2;
    window.__sf.chase.pitch = 0.18;
  }, hiroPosition);
  console.log("[probe] waiting for the Tea Master interaction state");
  await page.waitForFunction(
    () => {
      const sf = window.__sf;
      const state = sf?.japaneseTeaGarden?.debugState?.();
      return state?.awake && state.guide.phase === "idle" && state.guide.playerDistance < 5.4;
    },
    undefined,
    { timeout: 150_000 }
  );

  const initial = await page.evaluate(() => window.__sf.japaneseTeaGarden.debugState().guide);
  assert.equal(initial.phase, "idle");
  const interactionRequestStart = teaRequests.length;

  // The prompt is distance-driven and remains visible while mounted. This is
  // the regression path: one E/B press must dismount and immediately hand the
  // same interaction intent to Hiro instead of requiring an unexplained second
  // press.
  await page.evaluate(() => window.__sf.player.trySwitch("drive"));
  assert.equal(await page.evaluate(() => window.__sf.player.mode), "drive");

  console.log("[probe] keyboard E from a mounted prompt");
  await page.keyboard.press("e");
  await page.waitForTimeout(500);
  const keyboardSnapshot = await page.evaluate(() => ({
    mode: window.__sf.player.mode,
    guide: window.__sf.japaneseTeaGarden.debugState().guide,
    dialogue: (() => {
      const root = document.querySelector(".projected-dialogue--tea-garden");
      return {
        hidden: root?.hidden ?? true,
        projectionHidden: root?.classList.contains("is-projection-hidden") ?? true,
        text: root?.textContent ?? ""
      };
    })()
  }));
  console.log("[probe] keyboard result", JSON.stringify({
    mode: keyboardSnapshot.mode,
    phase: keyboardSnapshot.guide.phase,
    chapter: keyboardSnapshot.guide.chapter,
    playerDistance: keyboardSnapshot.guide.playerDistance
  }));
  await page.waitForFunction(() => !window.__sf.japaneseTeaGarden.debugState().guide.busy, undefined, { timeout: 10_000 });

  const afterKeyboard = await page.evaluate(() => window.__sf.japaneseTeaGarden.debugState().guide);
  assert.equal(afterKeyboard.phase, "speaking", "keyboard E did not open the Tea Master dialogue");
  assert.equal(afterKeyboard.chapter, "welcome", "keyboard E did not start the Tea Master conversation");
  assert.equal(await page.evaluate(() => window.__sf.player.mode), "walk", "keyboard E did not dismount before talking");
  assert.equal(keyboardSnapshot.dialogue.hidden, false, "Tea Master dialogue card stayed hidden");
  assert.equal(keyboardSnapshot.dialogue.projectionHidden, false, "Tea Master dialogue card was not projected on screen");
  assert.match(keyboardSnapshot.dialogue.text, /Welcome, traveler/, "Tea Master welcome text was not visible");

  await page.evaluate(() => {
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = {
      axes: [0, 0, 0, 0],
      buttons,
      connected: true,
      id: "Tea Garden interaction probe",
      index: 0,
      mapping: "standard",
      timestamp: performance.now(),
      vibrationActuator: null
    };
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [pad]
    });
    window.__teaGardenProbePad = pad;
  });
  console.log("[probe] standard-gamepad Y to continue");
  await page.evaluate(() => {
    const button = window.__teaGardenProbePad.buttons[3];
    button.pressed = true;
    button.touched = true;
    button.value = 1;
    window.__teaGardenProbePad.timestamp = performance.now();
  });
  await page.waitForTimeout(500);
  const controllerSnapshot = await page.evaluate(() => ({
    device: window.__sf.input.device,
    padConnected: window.__sf.input.padConnected,
    guide: window.__sf.japaneseTeaGarden.debugState().guide
  }));
  console.log("[probe] controller result", JSON.stringify({
    device: controllerSnapshot.device,
    padConnected: controllerSnapshot.padConnected,
    action: controllerSnapshot.guide.hiro.action
  }));
  assert.equal(controllerSnapshot.guide.hiro.action, "serve", "controller Y did not advance the Tea Master conversation");
  await page.evaluate(() => {
    const button = window.__teaGardenProbePad.buttons[3];
    button.pressed = false;
    button.touched = false;
    button.value = 0;
    window.__teaGardenProbePad.timestamp = performance.now();
  });

  const afterController = await page.evaluate(() => window.__sf.japaneseTeaGarden.debugState().guide);
  const interactionRequests = teaRequests.slice(interactionRequestStart);
  assert.deepEqual(interactionRequests, [], "interacting with Hiro fetched additional Tea Garden modules");
  const screenshot = await page.screenshot({ path: `${OUT}/interaction.png`, fullPage: false });
  const screenshotStats = await sharp(screenshot).stats();
  assert.ok(screenshotStats.entropy > 1, `browser screenshot appears blank (entropy ${screenshotStats.entropy})`);
  assert.deepEqual(pageErrors, [], `browser errors: ${pageErrors.join("\n")}`);

  console.log(JSON.stringify({
    ok: true,
    keyboard: { phase: afterKeyboard.phase, chapter: afterKeyboard.chapter },
    controller: { action: afterController.hiro.action, device: "standard B" },
    playerDistance: afterController.playerDistance,
    requests: { boot: 0, activation: interactionRequestStart, interaction: interactionRequests.length },
    screenshotEntropy: screenshotStats.entropy,
    pageErrors: pageErrors.length
  }, null, 2));
} finally {
  await browser.close();
}
