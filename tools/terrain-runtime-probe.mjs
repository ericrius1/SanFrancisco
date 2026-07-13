// End-to-end terrain streaming + collision QA in the real headless WebGPU app.
//
// Reuses a running preview when SF_PROBE_URL is set. The probe keeps the normal
// app boot/streaming loop alive long enough to audit terrain requests, then
// switches to deterministic stepping for a repeatable car drive over Marin.

// Usage:
//   SF_PROBE_URL=http://127.0.0.1:5240 npm run test:terrain-runtime

// Artifacts:
//   .data/terrain-runtime/result.json
//   .data/terrain-runtime/terrain-runtime.png


import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_TERRAIN_PROBE_OUT ?? ".data/terrain-runtime");
const URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const VIEWPORT = { width: 1440, height: 900 };
const DRIVE = { x: -4200, z: -5200, facing: -Math.PI / 2, steps: 900 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
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
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error("Chrome/Chromium not found; set CHROME_BIN");
}

async function waitHttp(url, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const terrainName = (url) => {
  try {
    const name = new URL(url).pathname.split("/").at(-1) ?? "";
    return /^terrain_\d+_\d+\.glb$/.test(name) ? name : null;
  } catch {
    return null;
  }
};

async function settleFrames(page, maxBatches = 16) {
  let state = null;
  for (let batch = 0; batch < maxBatches; batch++) {
    await page.evaluate(() => {
      for (let i = 0; i < 15; i++) window.__sf.tick(1 / 60);
    });
    await page.evaluate(() => window.__sf.renderer.backend.device.queue.onSubmittedWorkDone());
    await sleep(200);
    state = await page.evaluate(() => ({
      idle: window.__sf.renderIdle?.() === true,
      loadedTerrain: window.__sf.tiles.terrain.size
    }));
    if (state.idle && state.loadedTerrain > 0) break;
  }
  return state;
}

async function mergePerformanceTerrain(page, terrainRequests, started) {
  const urls = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name)
  );
  const known = new Set(terrainRequests.map(({ name }) => name));
  for (const url of urls) {
    const name = terrainName(url);
    if (name && !known.has(name)) {
      known.add(name);
      terrainRequests.push({ name, atMs: Math.round(performance.now() - started), source: "resource-timing" });
    }
  }
}

function mergeObservedTerrain(urls, terrainRequests, started) {
  const known = new Set(terrainRequests.map(({ name }) => name));
  for (const url of urls) {
    const name = terrainName(url);
    if (name && !known.has(name)) {
      known.add(name);
      terrainRequests.push({ name, atMs: Math.round(performance.now() - started), source: "playwright-request" });
    }
  }
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
      `--use-angle=${process.env.SF_ANGLE ?? (process.platform === "darwin" ? "metal" : "swiftshader")}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--mute-audio"
    ]
  });

  const pageErrors = [];
  const terrainRequests = [];
  const observedTileRequests = [];
  let page;
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    page = await context.newPage();
    const started = performance.now();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    // Count dispatches, not only completed responses: GLTFLoader can still be
    // decoding a large meshopt response when the boot systems report idle.
    page.on("request", (request) => {
      if (request.url().includes("/tiles/")) observedTileRequests.push(request.url());
    });

    await page.goto(`${URL}/?autostart=1&fullfps=1&profile=1`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    });
    await page.waitForFunction(
      () => Boolean(window.__sf?.player && window.__sf?.physics?.terrainPatchDebug?.active && window.__sf?.renderer?.backend?.device),
      null,
      { timeout: 180_000 }
    );
    // Terrain scans are intentionally cadence-limited. Drive enough deterministic
    // boot frames to cross the first scan boundary even on a slow headless GPU.
    await page.evaluate(() => {
      window.__sfManual(true);
      for (let i = 0; i < 75; i++) window.__sf.tick(1 / 60);
    });
    await page.evaluate(() => window.__sf.renderer.backend.device.queue.onSubmittedWorkDone());
    const bootSettle = await settleFrames(page);
    mergeObservedTerrain(observedTileRequests, terrainRequests, started);
    await mergePerformanceTerrain(page, terrainRequests, started);
    console.log(`[terrain-probe] boot: ${terrainRequests.length} terrain request(s), ${bootSettle?.loadedTerrain ?? 0} loaded`);
    if (terrainRequests.length === 0) {
      const timingTiles = await page.evaluate(() =>
        performance.getEntriesByType("resource").map((entry) => entry.name).filter((url) => url.includes("/tiles/"))
      );
      const loadedNames = await page.evaluate(() => [...window.__sf.tiles.terrain.keys()]);
      console.log("[terrain-probe] request diagnostics", JSON.stringify({ observedTileRequests, timingTiles, loadedNames }));
    }

    const bootPatch = await page.evaluate(() => window.__sf.physics.terrainPatchDebug);
    const bootTerrain = [...new Set(terrainRequests.map((entry) => entry.name))];
    assert(bootPatch.step === 8, `runtime collision step is ${bootPatch.step}, expected 8 m`);
    assert(bootPatch.vertices === 1681, `runtime patch has ${bootPatch.vertices} vertices, expected 1681`);
    assert(bootPatch.triangles <= 3200, `runtime patch has ${bootPatch.triangles} triangles, expected at most 3200`);
    assert(bootTerrain.length > 0 && bootTerrain.length < 25, `clean boot requested ${bootTerrain.length}/25 terrain chunks`);
    const terrainBeforeMarin = new Set(terrainRequests.map((entry) => entry.name));

    await page.evaluate((drive) => {
      const sf = window.__sf;
      sf.sky.cycleEnabled = false;
      sf.sky.setTimeOfDay(13.5);
      const y = sf.map.groundTop(drive.x, drive.z);
      sf.player.teleportTo({ x: drive.x, y, z: drive.z, facing: drive.facing, mode: "drive" });
      sf.chase.yaw = drive.facing;
    }, DRIVE);
    await page.waitForFunction(
      (drive) => {
        const sf = window.__sf;
        const patch = sf.physics.terrainPatchDebug;
        return sf.player.mode === "drive" && patch.active && Math.hypot(patch.centerX - drive.x, patch.centerZ - drive.z) < 100;
      },
      DRIVE,
      { timeout: 30_000 }
    );
    const marinSettle = await settleFrames(page);
    mergeObservedTerrain(observedTileRequests, terrainRequests, started);
    await mergePerformanceTerrain(page, terrainRequests, started);
    console.log(`[terrain-probe] Marin: ${terrainRequests.length} total terrain request(s), ${marinSettle?.loadedTerrain ?? 0} loaded`);

    await page.evaluate(() => window.__sfManual(true));
    const driveResult = await page.evaluate((drive) => {
      const sf = window.__sf;
      const player = sf.player;
      const physics = sf.physics;
      const input = sf.input;
      const aim = new sf.THREE.Vector3(1, 0, 0);
      const samples = [];
      const carpet = [];
      const dt = physics.world.fixedTimeStep;
      input.keys.add("KeyW");

      for (let i = 0; i < drive.steps; i++) {
        player.update(dt, input, sf.chase.yaw, aim);
        // This synthetic loop treats each iteration as one rendered frame.
        physics.maintainStreaming(player.position);
        physics.step(dt);
        player.afterSteps(1, 0);
        if (i % 30 === 0) {
          const body = physics.world.getBodyTransform(player.body);
          const [x, y, z] = body.position;
          samples.push({
            step: i,
            x,
            y,
            z,
            speed: player.speed,
            clearance: y - sf.map.groundTop(x, z),
            patch: { ...physics.terrainPatchDebug }
          });
        }
      }
      input.keys.delete("KeyW");
      player.update(dt, input, sf.chase.yaw, aim);
      player.afterSteps(1, 0);
      player.syncMesh(dt);
      const body = physics.world.getBodyTransform(player.body);
      const [x, y, z] = body.position;
      physics.debugCarpet(carpet, x, z, 60);
      return {
        start: samples[0],
        end: { x, y, z, speed: player.speed, clearance: y - sf.map.groundTop(x, z) },
        samples,
        carpet: carpet.map(({ kind, x: cx, y: cy, z: cz }) => ({ kind, x: cx, y: cy, z: cz }))
      };
    }, DRIVE);
    console.log("[terrain-probe] deterministic drive complete");

    const displacement = Math.hypot(
      driveResult.end.x - driveResult.start.x,
      driveResult.end.z - driveResult.start.z
    );
    const patchCenters = [
      ...new Set(driveResult.samples.map(({ patch }) => `${patch.centerX},${patch.centerZ}`))
    ];
    const clearances = driveResult.samples.map((sample) => sample.clearance);
    const minClearance = Math.min(...clearances);
    const maxClearance = Math.max(...clearances);
    assert(displacement > 180, `car advanced only ${displacement.toFixed(1)} m over the terrain drive`);
    assert(patchCenters.length >= 3, `drive crossed only ${patchCenters.length} collision patch anchors`);
    assert(minClearance > -1, `car penetrated ${(-minClearance).toFixed(2)} m below terrain`);
    assert(maxClearance < 12, `car rose ${maxClearance.toFixed(2)} m above terrain unexpectedly`);
    assert(driveResult.carpet.length === 0, `${driveResult.carpet.length} fallback slabs remained active on ordinary Marin terrain`);

    await page.evaluate(({ end, start }) => {
      const sf = window.__sf;
      const tx = end.x;
      const tz = end.z;
      const targetY = sf.map.groundTop(tx, tz) + 1.2;
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      const length = Math.hypot(dx, dz) || 1;
      const fx = dx / length;
      const fz = dz / length;
      const eye = [tx - fx * 32 - fz * 16, targetY + 13, tz - fz * 32 + fx * 16];
      window.__sfFreeCam(eye, [tx + fx * 18, targetY + 1.5, tz + fz * 18]);
      for (const selector of ["#hud", "#debug", ".tp-dfwv"]) {
        const element = document.querySelector(selector);
        if (element) element.style.display = "none";
      }
      sf.pipeline.render();
    }, { end: driveResult.end, start: driveResult.start });
    await page.evaluate(() => window.__sf.renderer.backend.device.queue.onSubmittedWorkDone());
    await page.screenshot({ path: path.join(OUT, "terrain-runtime.png"), type: "png" });

    mergeObservedTerrain(observedTileRequests, terrainRequests, started);
    await mergePerformanceTerrain(page, terrainRequests, started);
    const allTerrain = [...new Set(terrainRequests.map((entry) => entry.name))];
    const newTerrain = allTerrain.filter((name) => !terrainBeforeMarin.has(name));
    assert(allTerrain.length < 25, `runtime requested every terrain chunk (${allTerrain.length}/25)`);
    assert(newTerrain.length > 0, "Marin move did not stream any newly nearby terrain chunk");
    assert(pageErrors.length === 0, `${pageErrors.length} uncaught page error(s): ${pageErrors.join(" | ")}`);

    const result = {
      ok: true,
      boot: { terrainChunks: bootTerrain.length, names: bootTerrain, patch: bootPatch },
      stream: { totalTerrainChunks: allTerrain.length, newNearMarin: newTerrain },
      drive: {
        displacement: Number(displacement.toFixed(2)),
        patchHandoffs: patchCenters.length - 1,
        patchCenters,
        minClearance: Number(minClearance.toFixed(3)),
        maxClearance: Number(maxClearance.toFixed(3)),
        finalSpeed: Number(driveResult.end.speed.toFixed(2)),
        activeFallbackSlabs: driveResult.carpet.length
      },
      pageErrors,
      terrainRequests
    };
    await writeFile(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

await main();
