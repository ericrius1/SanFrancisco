// Marin Orbital end-to-end WebGPU probe.
// Usage: SF_PROBE_URL=http://127.0.0.1:5244 node tools/marin-rocket-probe.mjs

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data/marin-rocket-probe");
const URL = (process.env.SF_PROBE_URL ?? "http://localhost:5244").replace(/\/$/, "");
const OPTIONAL_CODE = /\/src\/(?:gameplay\/marinRocket\/(?:index|experience|mesh|ui|audio)|vehicles\/plane\/rocketFlight)\.ts(?:\?|$)/;
const SITE = { x: -4_640, z: -5_690 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function findChrome() {
  for (const file of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean)) if (await exists(file)) return file;
  throw new Error("Chrome/Chromium not found; set CHROME_BIN");
}

async function waitHttp(url, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function frame(page, count = 2) {
  await page.evaluate((frames) => {
    for (let i = 0; i < frames; i++) window.__sf.tick(1 / 60);
  }, count);
  await page.evaluate(() => window.__sf.renderer.backend.device.queue.onSubmittedWorkDone());
  await sleep(100);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await waitHttp(URL);
  const browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-gpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      `--use-angle=${process.platform === "darwin" ? "metal" : "swiftshader"}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--hide-scrollbars",
      "--mute-audio"
    ]
  });

  const requests = [];
  const errors = [];
  const checks = [];
  const check = (id, pass, detail) => checks.push({ id, pass, detail });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    const page = await context.newPage();
    page.on("request", (request) => requests.push(request.url()));
    page.on("pageerror", (error) => errors.push(`page: ${error}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });

    await page.goto(`${URL}/?autostart=1&profile=1&fullfps=1&spawn=transamerica&via=marin-rocket-probe`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
    await page.waitForFunction(
      () => window.__sf?.player && window.__sf?.renderer?.backend?.device && document.body.classList.contains("started"),
      undefined,
      { timeout: 180_000 }
    );
    await page.waitForFunction(() => window.__sf.renderIdle(), undefined, { timeout: 180_000 });
    const bootOptional = requests.filter((url) => OPTIONAL_CODE.test(url));
    check("clean-boot-has-no-rocket-code", bootOptional.length === 0, bootOptional);
    check(
      "launch-site-starts-dormant",
      await page.evaluate(() => window.__sf.optionalWorldSites.find((site) => site.id === "marin-headlands")?.state === "dormant"),
      null
    );

    const beforeActivation = requests.length;
    await page.evaluate(() => window.__sf.ensureOptionalWorldSite("marin-headlands"));
    await page.waitForFunction(() => window.__sf?.marinRocket?.debugState?.craftParked, undefined, { timeout: 120_000 });
    const activationCode = requests.slice(beforeActivation).filter((url) => OPTIONAL_CODE.test(url));
    check("approach-loads-rocket-chunk", activationCode.length >= 5, activationCode);

    const beforeArrivalGeneration = await page.evaluate(() => {
      const sf = window.__sf;
      const generation = sf.worldArrival.snapshot.generation;
      sf.teleportToTarget(-4_640, -5_690, "Marin Orbital Launch Field");
      return generation;
    });
    await page.waitForFunction(
      (before) => {
        const sf = window.__sf;
        return sf.worldArrival.snapshot.generation > before &&
          sf.worldArrival.snapshot.state === "idle" && !sf.player.worldArrivalHeld;
      },
      beforeArrivalGeneration,
      { timeout: 180_000 }
    );
    const mapArrival = await page.evaluate(() => ({
      x: window.__sf.player.position.x,
      z: window.__sf.player.position.z,
      mode: window.__sf.player.mode
    }));
    check(
      "map-pin-navigation-arrives-safely-beside-pad",
      mapArrival.mode === "walk" && Math.hypot(mapArrival.x + 4_622, mapArrival.z + 5_686) < 3,
      mapArrival
    );

    await page.evaluate((site) => {
      const sf = window.__sf;
      sf.sky.cycleEnabled = false;
      sf.sky.setTimeOfDay(15.2);
      const y = sf.marinRocket.padY;
      sf.player.teleportTo({ x: site.x + 2.25, y: y + 1.6, z: site.z - 1.45, facing: Math.PI / 2, mode: "walk" });
      sf.chase.cutTo(sf.player);
    }, SITE);
    await page.waitForFunction(() => document.querySelector(".mr-prompt")?.classList.contains("show"), undefined, {
      timeout: 15_000
    });
    const pad = await page.evaluate(() => {
      const sf = window.__sf;
      const craft = sf.scene.getObjectByName("marin_starjet");
      const terrain = [];
      for (const dx of [-14, 0, 14]) for (const dz of [-9, 0, 9]) {
        terrain.push({ dx, dz, y: sf.map.baseGroundTop(-4_640 + dx, -5_690 + dz) });
      }
      const scout = [];
      for (let x = -5_000; x <= -4_300; x += 20) for (let z = -6_350; z <= -5_650; z += 20) {
        const samples = [];
        let real = true;
        for (const dx of [-14, 0, 14]) for (const dz of [-9, 0, 9]) {
          real &&= sf.map.isTileRealAt(x + dx, z + dz);
          samples.push(sf.map.baseGroundTop(x + dx, z + dz));
        }
        if (!real || sf.map.isWater(x, z)) continue;
        const lo = Math.min(...samples);
        const hi = Math.max(...samples);
        scout.push({ x, z, y: samples[4], spread: hi - lo });
      }
      scout.sort((a, b) => a.spread - b.spread);
      const worldUi = sf.pipeline?.worldUiScene;
      const sign = worldUi?.getObjectByName?.("marin_orbital_sign")
        ?? sf.scene.getObjectByName("marin_orbital_sign");
      return {
        prompt: document.querySelector(".mr-prompt-copy")?.textContent ?? "",
        craftVisible: craft?.visible,
        craftParent: craft?.parent?.name,
        signOnWorldUi: !!sign && sign.parent === worldUi,
        signInBeauty: !!sf.scene.getObjectByName("marin_orbital_sign"),
        signVisible: !!sign?.visible,
        state: sf.marinRocket.debugState,
        ground: sf.map.baseGroundTop(-4_640, -5_690),
        terrain,
        scout: scout.slice(0, 16)
      };
    });
    check(
      "grounded-starjet-and-boarding-prompt",
      pad.craftVisible && pad.state.craftParked && /board Starjet/.test(pad.prompt) && pad.state.padY - pad.ground > 0.35,
      pad
    );
    check("orbital-sign-bypasses-post-chain", pad.signOnWorldUi && pad.signVisible, pad);
    if (process.env.SF_SCOUT_ONLY) {
      const result = { pad };
      await writeFile(path.join(OUT, "scout.json"), `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    await page.evaluate(() => {
      const sf = window.__sf;
      window.__sfFreeCam([-4_614, sf.marinRocket.padY + 40, -5_667], [-4_640, sf.marinRocket.padY + 1.2, -5_690]);
    });
    await frame(page, 3);
    await page.locator("canvas").first().screenshot({ path: path.join(OUT, "launch-field.png") });
    await page.evaluate(() => window.__sfFreeCam(null));

    const beforeBoarding = requests.length;
    const boarded = await page.evaluate(() => {
      const sf = window.__sf;
      const consumed = sf.marinRocket.tryInteract(sf.player, sf.hud, sf.input, sf.chase);
      return { consumed, state: sf.marinRocket.debugState };
    });
    await page.waitForFunction(() => window.__sf.player.rocketFlying && document.querySelector(".mr-panel.show"), undefined, {
      timeout: 15_000
    });
    check("boarding-enters-dedicated-rocket-flight", boarded.consumed && boarded.state.active, boarded);
    check("boarding-fetches-no-additional-assets", requests.slice(beforeBoarding).filter((url) => OPTIONAL_CODE.test(url)).length === 0, requests.slice(beforeBoarding));

    await page.evaluate(() => {
      const sf = window.__sf;
      sf.input.suspended = false;
      sf.input.setDriver({ update: (_dt, controls) => { controls.hold("KeyW"); controls.hold("ShiftLeft"); } });
      window.__sfManual(true);
    });
    const climb = await page.evaluate(() => {
      const sf = window.__sf;
      const startY = sf.player.position.y;
      for (let i = 0; i < 60 * 16; i++) sf.tick(1 / 60);
      return {
        gained: sf.player.position.y - startY,
        speed: sf.player.rocketTelemetry.speed,
        verticalSpeed: sf.player.rocketTelemetry.verticalSpeed,
        mode: sf.player.mode,
        rocketFlying: sf.player.rocketFlying,
        craftAttached: sf.scene.getObjectByName("marin_starjet")?.parent === sf.player.meshes.plane
      };
    });
    check("powered-flight-climbs-under-player-control", climb.gained > 1_000 && climb.speed > 200 && climb.verticalSpeed > 100, climb);
    check("starjet-replaces-stock-plane-in-flight", climb.mode === "plane" && climb.rocketFlying && climb.craftAttached, climb);

    const orbit = await page.evaluate(() => {
      const sf = window.__sf;
      const body = sf.physics.world.getBodyTransform(sf.player.body);
      sf.physics.world.setBodyTransform(
        sf.player.body,
          [body.position[0], 25_000, body.position[2]],
        body.rotation
      );
      for (let i = 0; i < 8; i++) sf.tick(1 / 60);
      return { telemetry: { ...sf.player.rocketTelemetry }, debug: sf.marinRocket.debugState };
    });
    check("orbit-stage-and-space-transition", orbit.telemetry.stage === "orbit" && orbit.telemetry.spaceFactor > 0.95, orbit);
    await frame(page, 2);
    await page.locator("canvas").first().screenshot({ path: path.join(OUT, "orbit.png") });

    const deep = await page.evaluate(() => {
      const sf = window.__sf;
      const body = sf.physics.world.getBodyTransform(sf.player.body);
      sf.physics.world.setBodyTransform(
        sf.player.body,
        [body.position[0], 52_000, body.position[2]],
        body.rotation
      );
      for (let i = 0; i < 8; i++) sf.tick(1 / 60);
      const panel = document.querySelector(".mr-panel");
      const rect = panel?.getBoundingClientRect();
      return {
        telemetry: { ...sf.player.rocketTelemetry },
        panelVisible: panel?.classList.contains("show"),
        panelInside: !!rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        cameraFar: sf.camera.far
      };
    });
    check("deep-space-is-reachable", deep.telemetry.stage === "deep-space" && deep.telemetry.altitude > 48_000, deep);
    check("space-hud-visible-and-camera-range-sufficient", deep.panelVisible && deep.panelInside && deep.cameraFar >= 100_000, deep);
    await frame(page, 2);
    await page.locator("canvas").first().screenshot({ path: path.join(OUT, "deep-space.png") });

    const returned = await page.evaluate(() => {
      const sf = window.__sf;
      sf.input.setDriver(null);
      const consumed = sf.marinRocket.tryInteract(sf.player, sf.hud, sf.input, sf.chase);
      for (let i = 0; i < 3; i++) sf.tick(1 / 60);
      return {
        consumed,
        mode: sf.player.mode,
        rocketFlying: sf.player.rocketFlying,
        state: sf.marinRocket.debugState,
        position: { x: sf.player.position.x, y: sf.player.position.y, z: sf.player.position.z }
      };
    });
    check("return-control-reparks-craft-in-marin", returned.consumed && returned.mode === "walk" && !returned.rocketFlying && returned.state.craftParked, returned);

    await page.setViewportSize({ width: 390, height: 780 });
    await frame(page, 2);
    const promptFit = await page.evaluate(() => {
      const node = document.querySelector(".mr-prompt");
      const rect = node?.getBoundingClientRect();
      return { visible: node?.classList.contains("show"), rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null };
    });
    check("boarding-prompt-fits-narrow-screen", !promptFit.visible || (promptFit.rect.x >= -1 && promptFit.rect.x + promptFit.rect.width <= 391), promptFit);

    const failed = checks.filter((item) => !item.pass);
    const result = { checks, errors, failed: failed.map((item) => item.id) };
    await writeFile(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    if (failed.length || errors.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
