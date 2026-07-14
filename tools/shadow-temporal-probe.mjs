// Deterministic close-shadow temporal QA for the real WebGPU app.
//
// The probe removes material/fog/post noise with a neutral override material,
// captures a ground/player ROI in two scenarios, then fails on:
//   1. change while the camera and subject are locked, or
//   2. every-2/every-4 update impulses during a smooth camera truck.
//
// Usage:
//   npm run test:shadows:temporal
//
// Useful environment controls:
//   SF_PROBE_URL=http://127.0.0.1:5173  (reuse a running dev server)
//   SF_SHADOW_PROBE_OUT=.data/shadow-temporal
//   SF_SHADOW_ROI=280,300,720,360       (x,y,width,height)
//   SF_SHADOW_X=900 SF_SHADOW_Z=2400    (world location)
//   SF_SHADOW_MOTION_STEP=0.03           (metres per captured frame)
//   CHROME_BIN=/path/to/Chrome

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { evaluateShadowTemporalProbe } from "./lib/shadow-temporal-analysis.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_SHADOW_PROBE_OUT ?? ".data/shadow-temporal");
const VIEWPORT = {
  width: Number(process.env.SF_W ?? 1280),
  height: Number(process.env.SF_H ?? 720)
};
const WORLD = {
  x: Number(process.env.SF_SHADOW_X ?? 900),
  z: Number(process.env.SF_SHADOW_Z ?? 2400),
  facing: Number(process.env.SF_SHADOW_FACING ?? 0.4)
};
const STATIC_FRAMES = Math.max(6, Number(process.env.SF_SHADOW_STATIC_FRAMES ?? 10));
const MOTION_FRAMES = Math.max(12, Number(process.env.SF_SHADOW_MOTION_FRAMES ?? 17));
const MOTION_STEP = Number(process.env.SF_SHADOW_MOTION_STEP ?? 0.03);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRoi() {
  const fallback = [280, 300, 720, 360];
  const values = (process.env.SF_SHADOW_ROI ?? fallback.join(",")).split(",").map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("SF_SHADOW_ROI must be x,y,width,height");
  }
  const [x, y, width, height] = values.map(Math.round);
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > VIEWPORT.width || y + height > VIEWPORT.height) {
    throw new Error(`ROI ${values.join(",")} is outside ${VIEWPORT.width}x${VIEWPORT.height}`);
  }
  return { x, y, width, height };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a probe port"));
      server.close(() => resolve(address.port));
    });
  });
}

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

async function waitHttp(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startServer() {
  if (process.env.SF_PROBE_URL) {
    const url = process.env.SF_PROBE_URL.replace(/\/$/, "");
    await waitHttp(url, 15_000);
    return { url, process: null };
  }
  const port = await freePort();
  const relayPort = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    "npm",
    ["run", "dev:play", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: ROOT,
      env: { ...process.env, SF_RELAY_PORT: String(relayPort) },
      stdio: "ignore",
      detached: process.platform !== "win32"
    }
  );
  await waitHttp(url, 90_000);
  return { url, process: child };
}

function stopServer(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function renderFrame(page, dt = 1 / 60) {
  await page.evaluate(async (frameDt) => {
    const sf = window.__sf;
    // Three r185 normally advances NodeFrame from its RAF-owned Animation
    // wrapper, not from renderer.render(). Manual probe mode stops that RAF;
    // advance it explicitly so ShadowNode's per-frame de-duplication cannot
    // mistake every capture for the same frame and retain a stale map.
    const nodeFrame = sf.renderer._nodes?.nodeFrame;
    if (!nodeFrame) throw new Error("shadow probe cannot access renderer NodeFrame");
    nodeFrame.update();
    sf.renderer.info.frame = nodeFrame.frameId;
    sf.tick(frameDt);
    await sf.renderer.backend.device.queue.onSubmittedWorkDone();
  }, dt);
}

async function setCamera(page, setup, offset = 0) {
  await page.evaluate(
    ({ eye, target, right, amount }) => {
      const movedEye = [eye[0] + right[0] * amount, eye[1], eye[2] + right[1] * amount];
      const movedTarget = [target[0] + right[0] * amount, target[1], target[2] + right[1] * amount];
      window.__sfFreeCam(movedEye, movedTarget);
    },
    { ...setup, amount: offset }
  );
}

async function setCasterOffset(page, offset = 0) {
  await page.evaluate((amount) => {
    const state = window.__shadowTemporalProbe;
    state.caster.position.set(state.base[0] + amount, state.base[1], state.base[2]);
    state.caster.updateMatrixWorld();
  }, offset);
}

async function captureSequence(page, roi, prefix, count, cameraOffset) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    await cameraOffset(i);
    await renderFrame(page);
    const pngBytes = await page.screenshot({ type: "png", clip: roi, animations: "disabled" });
    await writeFile(path.join(OUT, `${prefix}-${String(i).padStart(2, "0")}.png`), pngBytes);
    const decoded = PNG.sync.read(pngBytes);
    if (decoded.width !== roi.width || decoded.height !== roi.height) {
      throw new Error(`Captured ${decoded.width}x${decoded.height}; expected ${roi.width}x${roi.height}`);
    }
    frames.push(decoded.data);
  }
  return frames;
}

async function configureScene(page) {
  return page.evaluate(async ({ world, viewport }) => {
    const sf = window.__sf;
    window.__sfManual(true);
    sf.sky.cycleEnabled = false;
    sf.sky.setTimeOfDay(10.5);
    sf.input.keys.clear();
    sf.POSTFX_TUNING.values.ink = false;
    sf.POSTFX_TUNING.values.dream = false;
    sf.POSTFX_TUNING.values.retro = false;
    sf.pipeline.applyPostFx();
    sf.WORLD_TUNING.values.fogEnabled = false;
    sf.WORLD_TUNING.values.fog = 0;
    sf.WORLD_TUNING.values.fogBank = 0;
    sf.WORLD_TUNING.values.fogNoise = 0;
    sf.sky.applyFogParams();
    sf.dynRes.sample = () => {};
    sf.renderer.setPixelRatio(1);
    sf.renderer.setSize(viewport.width, viewport.height);

    const groundY = sf.map.groundHeight(world.x, world.z);
    sf.player.teleportTo({ x: world.x, y: groundY + 1.6, z: world.z, facing: world.facing, mode: "walk" });

    // Material textures, animated alpha/hash and post effects can dominate tiny
    // shadow changes. A neutral receiver/caster material keeps this a
    // shadow-dominant image while retaining the real geometry and light graph.
    const neutral = new sf.THREE.MeshStandardNodeMaterial();
    neutral.name = "shadow-temporal-probe-neutral";
    neutral.color.set(0xd8d8d8);
    neutral.roughness = 1;
    neutral.metalness = 0;
    sf.scene.overrideMaterial = neutral;
    sf.scene.background = new sf.THREE.Color(0xb8c0c8);

    // Put a caster on a layer seen by the full-rate hero camera but not the
    // beauty camera. Static domains must remain uncontaminated by this moving
    // probe or their intentional cache would create a second stale silhouette.
    // Moving it therefore changes only the ground shadow; visible geometry and
    // camera pixels remain locked. This directly catches stale dynamic maps.
    const probeLayer = 29;
    const caster = new sf.THREE.Mesh(new sf.THREE.BoxGeometry(0.9, 1.8, 0.9), neutral);
    caster.name = "shadow-temporal-probe-caster";
    caster.castShadow = true;
    caster.receiveShadow = false;
    caster.frustumCulled = false;
    caster.layers.set(probeLayer);
    const casterBase = [world.x, groundY + 0.9, world.z];
    caster.position.set(...casterBase);
    sf.scene.add(caster);
    const csm = sf.sky.sun.shadow.shadowNode;
    const heroLight = csm.lights?.[0];
    if (!heroLight?.shadow?.camera) throw new Error("shadow probe requires a hero shadow domain");
    heroLight.shadow.camera.layers.enable(probeLayer);
    for (const mesh of Object.values(sf.player.meshes)) mesh.visible = false;
    window.__shadowTemporalProbe = { caster, base: casterBase };

    // Remove application chrome from the ROI without touching the canvas or
    // any ancestor that determines its size.
    const canvas = sf.renderer.domElement;
    for (const element of document.body.querySelectorAll("*")) {
      if (element === canvas || element.contains(canvas)) continue;
      element.style.visibility = "hidden";
    }

    const eye = [world.x - 5.8, groundY + 3.5, world.z - 7.2];
    const target = [world.x, groundY + 0.55, world.z];
    const dx = target[0] - eye[0];
    const dz = target[2] - eye[2];
    const length = Math.hypot(dx, dz) || 1;
    const right = [-dz / length, dx / length];
    window.__sfFreeCam(eye, target);

    // Compile the probe material once rather than measuring a shader warmup.
    await sf.renderer.compileAsync(sf.scene, sf.camera);
    await sf.renderer.backend.device.queue.onSubmittedWorkDone();
    return { eye, target, right, groundY };
  }, { world: WORLD, viewport: VIEWPORT });
}

async function settleWorld(page) {
  // Give streamed geometry both simulation frames and wall time to arrive.
  for (let batch = 0; batch < 6; batch++) {
    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) window.__sf.tick(1 / 60);
    });
    await page.evaluate(() => window.__sf.renderer.backend.device.queue.onSubmittedWorkDone());
    await sleep(250);
  }
  await page.waitForFunction(() => window.__sf.renderIdle?.() === true, null, { timeout: 120_000 });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const roi = parseRoi();
  const server = await startServer();
  const pageErrors = [];
  let browser;
  let result;

  try {
    const executablePath = await findChrome();
    const angle = process.env.SF_ANGLE ?? (process.platform === "darwin" ? "metal" : "swiftshader");
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--enable-unsafe-webgpu",
        "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
        `--use-angle=${angle}`,
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--mute-audio"
      ]
    });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${server.url}/?autostart=1&fullfps=1&profile=1`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForFunction(
      () => Boolean(window.__sf?.player && window.__sf?.renderer?.backend?.device && window.__sf?.sky && window.__sfFreeCam),
      null,
      { timeout: 180_000 }
    );
    await page.waitForFunction(() => window.__sf.renderIdle?.() === true, null, { timeout: 180_000 });
    await page.evaluate(() => window.__sfManual(true));

    // Stream/settle at the chosen world location before replacing the material.
    await page.evaluate((world) => {
      const sf = window.__sf;
      const y = sf.map.groundHeight(world.x, world.z);
      sf.player.teleportTo({ x: world.x, y: y + 1.6, z: world.z, facing: world.facing, mode: "walk" });
    }, WORLD);
    await settleWorld(page);
    const cameraSetup = await configureScene(page);

    // Freeze subject animation/pose. Camera motion below remains deliberately
    // smooth so stale-map update impulses remain observable.
    await page.evaluate(() => {
      window.__sf.player.update = () => {};
    });
    await setCamera(page, cameraSetup, 0);
    for (let i = 0; i < 6; i++) await renderFrame(page);

    console.log(`[shadow-probe] static ${STATIC_FRAMES} frames, ROI ${roi.x},${roi.y} ${roi.width}x${roi.height}`);
    const staticFrames = await captureSequence(page, roi, "static", STATIC_FRAMES, () => setCamera(page, cameraSetup, 0));

    await setCamera(page, cameraSetup, 0);
    for (let i = 0; i < 4; i++) await renderFrame(page);
    console.log(`[shadow-probe] smooth truck ${MOTION_FRAMES} frames, ${MOTION_STEP}m/frame`);
    const motionFrames = await captureSequence(
      page,
      roi,
      "motion",
      MOTION_FRAMES,
      async (frame) => {
        await setCamera(page, cameraSetup, 0);
        await setCasterOffset(page, frame * MOTION_STEP);
      }
    );

    const limits = {
      pixelThreshold: Number(process.env.SF_SHADOW_PIXEL_THRESHOLD ?? 4),
      maxStaticMae: Number(process.env.SF_SHADOW_MAX_STATIC_MAE ?? 0.35),
      maxStaticChangedFraction: Number(process.env.SF_SHADOW_MAX_STATIC_CHANGED ?? 0.003),
      maxPeriodScore: Number(process.env.SF_SHADOW_MAX_PERIOD_SCORE ?? 0.62),
      minMotionMae: Number(process.env.SF_SHADOW_MIN_MOTION_MAE ?? 0.02)
    };
    result = evaluateShadowTemporalProbe({ staticFrames, motionFrames, limits });
    if (pageErrors.length > 0) {
      result.pass = false;
      result.failures.push(`${pageErrors.length} page/console error(s)`);
    }
    const artifact = {
      ...result,
      scenario: { viewport: VIEWPORT, roi, world: WORLD, motionStepMeters: MOTION_STEP, camera: cameraSetup },
      pageErrors
    };
    await writeFile(path.join(OUT, "result.json"), `${JSON.stringify(artifact, null, 2)}\n`);

    console.log(
      `[shadow-probe] static max MAE=${result.static.adjacentMaxMae.toFixed(4)}, changed=${(result.static.adjacentMaxChangedFraction * 100).toFixed(3)}%`
    );
    console.log(
      `[shadow-probe] motion mean MAE=${result.motion.adjacentMeanMae.toFixed(4)}, period-2=${result.motion.period2Score.toFixed(3)}, period-4=${result.motion.period4Score.toFixed(3)}`
    );
    console.log(`[shadow-probe] ${result.pass ? "PASS" : "FAIL"}: ${result.pass ? "no visible 2/4-frame cadence" : result.failures.join("; ")}`);
    console.log(`[shadow-probe] artifacts: ${OUT}`);
  } finally {
    await browser?.close();
    stopServer(server.process);
  }

  if (!result?.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[shadow-probe] ERROR", error);
  process.exitCode = 1;
});
