// Headless WebGPU visual + runtime contract for the Marin tunnel terrain.
//
// Usage:
//   SF_PROBE_URL=http://127.0.0.1:5253 node tools/marin-headlands-probe.mjs
//
// Artifacts:
//   .data/marin-headlands-probe/{overview,baker-west,robin-south,baker-interior}.png
//   .data/marin-headlands-probe/result.json

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_MARIN_PROBE_OUT ?? ".data/marin-headlands-probe");
const URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5253").replace(/\/$/, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  for (const file of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (await exists(file)) return file;
  }
  throw new Error("Chrome/Chromium not found; set CHROME_BIN");
}

async function waitHttp(url, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function tick(page, frames = 30) {
  await page.evaluate((count) => {
    for (let i = 0; i < count; i++) window.__sf.tick(1 / 60);
  }, frames);
  await page.evaluate(() => window.__sf.renderer.backend.device.queue.onSubmittedWorkDone());
  await sleep(120);
}

async function camera(page, eye, target, file) {
  await page.evaluate(({ eye: e, target: t }) => {
    window.__sfFreeCam(e, t);
  }, { eye, target });
  await tick(page, 3);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__sf.renderer.backend.device.queue.onSubmittedWorkDone());
  await page.locator("canvas").first().screenshot({ path: path.join(OUT, file) });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await waitHttp(URL);
  const executablePath = await findChrome();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      `--use-angle=${process.platform === "darwin" ? "metal" : "swiftshader"}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--mute-audio"
    ]
  });

  const errors = [];
  const requests = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1536, height: 960 },
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("request", (request) => requests.push(request.url()));

    await page.goto(`${URL}/?autostart=1&profile=1&fullfps=1&spawn=transamerica`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    });
    await page.waitForFunction(
      () => Boolean(window.__sf?.player && window.__sf?.renderer?.backend?.device),
      null,
      { timeout: 180_000 }
    );
    const bootMarinRequests = requests.filter((url) => url.includes("/world/marinHeadlands/"));
    assert(bootMarinRequests.length === 0, `clean boot requested Marin chunk ${bootMarinRequests.length} time(s)`);

    const bootPose = await page.evaluate(() => {
      const sf = window.__sf;
      const pose = {
        x: sf.player.position.x,
        y: sf.player.position.y,
        z: sf.player.position.z,
        facing: sf.player.heading
      };
      sf.sky.cycleEnabled = false;
      sf.sky.setTimeOfDay(14.25);
      const x = -3976;
      const z = -5810;
      sf.player.teleportTo({
        x,
        y: sf.map.groundTop(x, z) + 1.5,
        z,
        facing: 1.15,
        mode: "walk"
      });
      return pose;
    });

    await page.waitForFunction(
      () => window.__sf.optionalWorldSites?.some(
        (site) => site.id === "marin-headlands" && site.state === "ready"
      ),
      null,
      { timeout: 120_000 }
    );
    await tick(page, 60);
    await page.evaluate(() => {
      window.__sfManual(false);
      window.__sf.hud?.setHidden?.(true);
    });

    const state = await page.evaluate(() => {
      const sf = window.__sf;
      const root = sf.scene.getObjectByName("marin_headlands_tunnels");
      const debug = root?.userData.sfDebug?.() ?? null;
      const baker = debug?.tunnels.find((t) => t.id === "baker-barry");
      const bakerCenterX = (-4332.4256 + -3685.7965) * 0.5;
      const bakerCenterZ = (-5734.4008 + -5419.7736) * 0.5;
      let meshes = 0;
      let triangles = 0;
      root?.traverse((object) => {
        if (!object.isMesh) return;
        meshes++;
        const geometry = object.geometry;
        triangles += (geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0) / 3;
      });
      return {
        debug,
        cutouts: sf.tiles.terrainCutoutDebug,
        meshCount: meshes,
        triangles: Math.round(triangles),
        bakerBase: sf.map.baseGroundTop(bakerCenterX, bakerCenterZ),
        bakerRoad: sf.map.groundTop(bakerCenterX, bakerCenterZ),
        bakerLength: baker?.length ?? 0
      };
    });

    assert(state.debug?.active === true, "Marin tunnel runtime did not activate");
    assert(state.cutouts.active.includes("marin:baker-barry"), "Baker–Barry terrain cutout missing");
    assert(state.cutouts.active.includes("marin:robin-williams"), "Robin Williams terrain cutout missing");
    assert(Math.abs(state.bakerLength - 719.1) < 2, `Baker tunnel length ${state.bakerLength} m is implausible`);
    assert(state.bakerBase - state.bakerRoad > 30, "Baker tunnel floor was not lowered beneath the DEM");
    assert(state.meshCount >= 20, `only ${state.meshCount} Marin meshes attached`);
    assert(errors.length === 0, `runtime errors: ${errors.join(" | ")}`);

    await camera(
      page,
      [-2330, 710, -3840],
      [-3790, 115, -5550],
      "overview.png"
    );
    await camera(
      page,
      [-4381.9, 110.1, -5758.6],
      [-4309.9, 109.1, -5723.5],
      "baker-west.png"
    );
    await camera(
      page,
      [-3656, 154, -5828],
      [-3674, 154, -5892],
      "robin-south.png"
    );
    await camera(
      page,
      [-4098.6, 98.2, -5620.6],
      [-4026.7, 94.8, -5585.6],
      "baker-interior.png"
    );

    const marinRequests = [...new Set(requests.filter((url) => url.includes("/world/marinHeadlands/")))];
    assert(marinRequests.length >= 1, "first approach did not request the Marin chunk");
    await page.evaluate((pose) => {
      window.__sfFreeCam(null);
      window.__sf.player.teleportTo({ ...pose, mode: "walk" });
    }, bootPose);
    await page.waitForFunction(
      () => window.__sf.optionalWorldSites?.some(
        (site) => site.id === "marin-headlands" && site.state === "dormant"
      ),
      null,
      { timeout: 60_000 }
    );
    await tick(page, 6);
    const unloadCutouts = await page.evaluate(() => window.__sf.tiles.terrainCutoutDebug);
    assert(
      !unloadCutouts.active.some((id) => id.startsWith("marin:")),
      "Marin cutouts survived optional-site unload"
    );
    const result = {
      ...state,
      bootMarinRequests,
      activationRequests: marinRequests,
      unloadCutouts,
      errors
    };
    await writeFile(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
