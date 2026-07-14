// Ocean Beach purple-kite acceptance probe.
//
// Starts at Corona Heights in a fresh headless Chrome/WebGPU context, audits
// the feature's split boundary, then activates it from Ocean Beach and advances
// its simulation with deterministic manual frames. A leave/revisit verifies
// that the same encounter is reused without another request or scene root.
//
// Usage:
//   SF_PROBE_URL=http://127.0.0.1:5240 npm run test:ocean-beach-kite

// Artifacts default to .data/ocean-beach-kite-probe/.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/ocean-beach-kite-probe");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const VIEWPORT = { width: 1280, height: 800 };
const CORONA = { x: 398, z: 2752, facing: -2.1 };
const DT = 0.1;
const ROOT_NAME = "ocean_beach_kite_encounter";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`No preview responded at ${url}; set SF_PROBE_URL to a running worktree server`);
}

function requestPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function pathClassification(pathname) {
  const normalized = decodeURIComponent(pathname).replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  const source = lower.includes("/src/world/oceanbeachkite/");
  const namedChunk = /\/oceanbeachkite(?:-[a-z0-9_-]+)?\.js$/i.test(normalized);
  return {
    kiteRuntime: source || namedChunk,
    kiteEntry: /\/src\/world\/oceanbeachkite\/index\.ts$/i.test(normalized) || namedChunk
  };
}

function publicRequest(record) {
  return {
    phase: record.phase,
    url: record.url,
    pathname: record.pathname,
    status: record.status ?? null,
    failed: record.failed ?? null,
    kiteEntry: record.kiteEntry,
    detectedBy: [...record.detectedBy]
  };
}

function finiteDebugState(value, pathName = "debugState", failures = []) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) failures.push(pathName);
    return failures;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => finiteDebugState(item, `${pathName}[${index}]`, failures));
    return failures;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      finiteDebugState(item, `${pathName}.${key}`, failures);
    }
  }
  return failures;
}

async function settleResponseInspection(tasks) {
  let count = -1;
  while (count !== tasks.length) {
    count = tasks.length;
    await Promise.all(tasks.slice());
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await waitHttp(BASE_URL);
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

  let phase = "boot";
  const checks = [];
  const pageErrors = [];
  const consoleErrors = [];
  const records = [];
  const recordsByRequest = new Map();
  const responseTasks = [];
  const expect = (id, pass, detail) => checks.push({ id, pass, detail });
  const kiteRecords = (name) => records.filter((record) => record.phase === name && record.kiteRuntime);
  let context;

  try {
    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push({ phase, message: String(error) }));
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push({ phase, text: message.text(), location: message.location() });
      }
    });
    page.on("request", (request) => {
      if (request.resourceType() !== "script") return;
      const pathname = requestPath(request.url());
      const classified = pathClassification(pathname);
      const record = {
        phase,
        url: request.url(),
        pathname,
        status: null,
        failed: null,
        kiteRuntime: classified.kiteRuntime,
        kiteEntry: classified.kiteEntry,
        detectedBy: new Set(classified.kiteRuntime ? ["path"] : [])
      };
      records.push(record);
      recordsByRequest.set(request, record);
    });
    page.on("response", (response) => {
      const record = recordsByRequest.get(response.request());
      if (!record) return;
      record.status = response.status();
      // Dev source paths identify themselves without reading every transformed
      // module. Built chunks need content inspection because Vite may call the
      // dynamic entry `index-<hash>.js`.
      const inspectBody = record.kiteRuntime ||
        (/\/assets\/.*\.js$/i.test(record.pathname) && response.status() < 400);
      if (!inspectBody) return;
      const task = response.text().then((body) => {
        // The preserved scene-root string identifies the entry even when Vite
        // names a production dynamic chunk `index-<hash>.js`.
        if (body.includes(ROOT_NAME)) {
          record.kiteRuntime = true;
          record.kiteEntry = true;
          record.detectedBy.add("entry-signature");
        } else if (
          body.includes("ocean_beach_purple_kite_gpu_cloth") ||
          body.includes("Ocean Beach · purple kite")
        ) {
          record.kiteRuntime = true;
          record.detectedBy.add("feature-signature");
        }
      }).catch(() => {});
      responseTasks.push(task);
    });
    page.on("requestfailed", (request) => {
      const record = recordsByRequest.get(request);
      if (record) record.failed = request.failure()?.errorText ?? "request failed";
    });

    const bootUrl = `${BASE_URL}/?autostart=1&fullfps=1&profile=1&spawn=coronaHeights`;
    await page.goto(bootUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForFunction(
      () => Boolean(window.__sf?.renderer?.backend?.device && window.__sf?.player && window.__sf?.tick),
      null,
      { timeout: 180_000 }
    );
    await page.waitForFunction(() => window.__sf.renderIdle?.() === true, null, { timeout: 180_000 });
    await sleep(800);
    await settleResponseInspection(responseTasks);

    const bootState = await page.evaluate((rootName) => {
      const sf = window.__sf;
      let rootCount = 0;
      sf.scene.traverse((object) => { if (object.name === rootName) rootCount++; });
      return {
        webgpu: sf.renderer.backend?.isWebGPUBackend === true,
        backend: sf.renderer.backend?.constructor?.name ?? null,
        hasDevice: Boolean(sf.renderer.backend?.device),
        manualHook: typeof window.__sfManual === "function",
        exposedEncounter: Boolean(sf.oceanBeachKite),
        rootCount,
        player: [sf.player.position.x, sf.player.position.y, sf.player.position.z],
        site: sf.oceanKiteSite,
        siteDistance: Math.hypot(
          sf.player.position.x - sf.oceanKiteSite.x,
          sf.player.position.z - sf.oceanKiteSite.z
        )
      };
    }, ROOT_NAME);
    const bootKite = kiteRecords("boot");
    expect("boot-starts-at-corona", bootState.siteDistance > 650, bootState);
    expect("boot-webgpu-backend", bootState.webgpu && bootState.hasDevice, bootState);
    expect("boot-manual-frame-hook", bootState.manualHook, bootState);
    expect("boot-no-kite-runtime-request", bootKite.length === 0, bootKite.map(publicRequest));
    expect("boot-no-kite-instance-or-root", !bootState.exposedEncounter && bootState.rootCount === 0, bootState);

    await page.evaluate(() => {
      window.__sfManual(true);
      const device = window.__sf.renderer.backend.device;
      window.__oceanKiteProbeGpuErrors = [];
      device.addEventListener("uncapturederror", (event) => {
        window.__oceanKiteProbeGpuErrors.push(event.error?.message ?? String(event.error));
      });
      device.lost.then((info) => {
        window.__oceanKiteProbeGpuErrors.push(`device lost: ${info.reason}: ${info.message}`);
      });
      device.pushErrorScope("validation");
    });

    phase = "activation";
    const activationSetup = await page.evaluate(async () => {
      const sf = window.__sf;
      const site = sf.oceanKiteSite;
      const ground = sf.map.groundTop(site.x, site.z);
      sf.player.teleportTo({ x: site.x, y: ground + 1.5, z: site.z, facing: Math.PI / 2, mode: "walk" });
      sf.chase.yaw = Math.PI / 2;
      await Promise.race([
        sf.ensureOceanBeachKite(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("kite activation timed out")), 90_000))
      ]);
      if (!sf.oceanBeachKite) throw new Error("kite encounter was not exposed after activation");
      sf.oceanBeachKite.update(0, 0, site, 0.5);
      return { site, uuid: sf.oceanBeachKite.group.uuid, state: sf.oceanBeachKite.debugState() };
    });
    await settleResponseInspection(responseTasks);

    const activationScene = await page.evaluate((rootName) => {
      const sf = window.__sf;
      let rootCount = 0;
      sf.scene.traverse((object) => { if (object.name === rootName) rootCount++; });
      return {
        rootCount,
        attached: sf.oceanBeachKite?.group.parent === sf.scene,
        visible: sf.oceanBeachKite?.group.visible === true,
        uuid: sf.oceanBeachKite?.group.uuid ?? null
      };
    }, ROOT_NAME);
    const activationKite = kiteRecords("activation");
    const activationEntries = activationKite.filter((record) => record.kiteEntry);
    const activationUris = activationKite.map((record) => record.url);
    expect("activation-loads-entry-exactly-once", activationEntries.length === 1,
      activationEntries.map(publicRequest));
    expect("activation-no-duplicate-runtime-fetch", new Set(activationUris).size === activationUris.length,
      activationKite.map(publicRequest));
    expect("activation-requests-succeed", activationKite.length > 0 && activationKite.every((record) =>
      !record.failed && record.status >= 200 && record.status < 400), activationKite.map(publicRequest));
    expect("activation-single-attached-root", activationScene.rootCount === 1 && activationScene.attached && activationScene.visible,
      activationScene);
    expect("activation-debug-state-finite", finiteDebugState(activationSetup.state).length === 0,
      { state: activationSetup.state, invalid: finiteDebugState(activationSetup.state) });
    expect("activation-webgpu-cloth", activationSetup.state.webgpuCloth === true, activationSetup.state);
    expect("activation-begins-with-launch", activationSetup.state.action === "launch", activationSetup.state);

    const behavior = await page.evaluate(({ dt, site }) => {
      const kite = window.__sf.oceanBeachKite;
      const targets = new Set(["launch", "reel out", "slow down", "reel in", "sprint"]);
      const stats = {};
      const invalid = [];
      const finite = (value, path = "debugState") => {
        if (typeof value === "number") {
          if (!Number.isFinite(value)) invalid.push(path);
          return;
        }
        if (Array.isArray(value)) return value.forEach((item, index) => finite(item, `${path}[${index}]`));
        if (value && typeof value === "object") {
          for (const [key, item] of Object.entries(value)) finite(item, `${path}.${key}`);
        }
      };
      let elapsed = 0;
      let frames = 0;
      let sawSprintThenCruise = false;
      let previousAction = null;
      let launchEntries = 0;
      let nonReelMaxLineStep = 0;
      let minTailClearance = Infinity;
      for (; frames < 500; frames++) {
        const state = kite.debugState();
        minTailClearance = Math.min(minTailClearance, state.kiteHeight - 2.125 - state.tailLength);
        if (state.action !== previousAction) {
          if (state.action === "launch") launchEntries++;
          previousAction = state.action;
        }
        finite(state, `frame[${frames}]`);
        const sample = {
          runnerSpeed: state.runnerSpeed,
          lineLength: state.lineLength,
          kiteHeight: state.kiteHeight,
          tension: state.tension
        };
        const stat = stats[state.action] ??= {
          frames: 0,
          first: sample,
          last: sample,
          minRunnerSpeed: Infinity,
          maxRunnerSpeed: -Infinity,
          minLineLength: Infinity,
          maxLineLength: -Infinity,
          minKiteHeight: Infinity,
          maxKiteHeight: -Infinity
        };
        stat.frames++;
        stat.last = sample;
        stat.minRunnerSpeed = Math.min(stat.minRunnerSpeed, state.runnerSpeed);
        stat.maxRunnerSpeed = Math.max(stat.maxRunnerSpeed, state.runnerSpeed);
        stat.minLineLength = Math.min(stat.minLineLength, state.lineLength);
        stat.maxLineLength = Math.max(stat.maxLineLength, state.lineLength);
        stat.minKiteHeight = Math.min(stat.minKiteHeight, state.kiteHeight);
        stat.maxKiteHeight = Math.max(stat.maxKiteHeight, state.kiteHeight);
        if (state.action === "cruise" && stats.sprint) sawSprintThenCruise = true;
        if ([...targets].every((name) => stats[name]) && sawSprintThenCruise && frames >= 420) break;
        const actionBeforeUpdate = state.action;
        const lineBeforeUpdate = state.lineLength;
        elapsed += dt;
        kite.update(dt, elapsed, site, 0.55);
        const after = kite.debugState();
        if (
          after.action === actionBeforeUpdate &&
          (actionBeforeUpdate === "cruise" || actionBeforeUpdate === "slow down" || actionBeforeUpdate === "sprint")
        ) {
          nonReelMaxLineStep = Math.max(nonReelMaxLineStep, Math.abs(after.lineLength - lineBeforeUpdate));
        }
      }
      return {
        frames,
        simulatedSeconds: elapsed,
        stats,
        invalid,
        launchEntries,
        nonReelMaxLineStep,
        minTailClearance,
        final: kite.debugState()
      };
    }, { dt: DT, site: activationSetup.site });

    const actionNames = ["launch", "reel out", "slow down", "reel in", "sprint"];
    expect("manual-frames-observe-required-actions",
      actionNames.every((name) => behavior.stats[name]?.frames > 0),
      { frames: behavior.frames, actions: Object.keys(behavior.stats) });
    expect("manual-frames-remain-finite", behavior.invalid.length === 0,
      { invalid: behavior.invalid.slice(0, 20), final: behavior.final });
    expect("launch-lifts-kite",
      behavior.stats.launch?.maxKiteHeight > behavior.stats.launch?.first.kiteHeight + 2,
      behavior.stats.launch);
    expect("reel-out-lengthens-line",
      behavior.stats["reel out"]?.last.lineLength > behavior.stats["reel out"]?.first.lineLength + 5,
      behavior.stats["reel out"]);
    expect("reel-in-shortens-line",
      behavior.stats["reel in"]?.last.lineLength < behavior.stats["reel in"]?.first.lineLength - 5,
      behavior.stats["reel in"]);
    expect("runner-slows-and-speeds-up",
      behavior.stats.sprint?.maxRunnerSpeed > behavior.stats["slow down"]?.minRunnerSpeed + 1.5,
      { slower: behavior.stats["slow down"], faster: behavior.stats.sprint });
    expect("launch-is-a-one-shot-arrival-vignette", behavior.launchEntries === 1,
      { launchEntries: behavior.launchEntries, simulatedSeconds: behavior.simulatedSeconds });
    expect("non-reel-actions-hold-line-length", behavior.nonReelMaxLineStep < 1e-5,
      { nonReelMaxLineStep: behavior.nonReelMaxLineStep });
    expect("tail-stays-clear-of-sand-during-launch", behavior.minTailClearance >= 0.19,
      { minTailClearance: behavior.minTailClearance });

    phase = "away";
    const awayState = await page.evaluate(({ corona, rootName }) => {
      const sf = window.__sf;
      const y = sf.map.groundTop(corona.x, corona.z);
      sf.player.teleportTo({ x: corona.x, y: y + 1.5, z: corona.z, facing: corona.facing, mode: "walk" });
      sf.oceanBeachKite.update(0, 100, corona, 0.5);
      let rootCount = 0;
      sf.scene.traverse((object) => { if (object.name === rootName) rootCount++; });
      return { rootCount, uuid: sf.oceanBeachKite.group.uuid, state: sf.oceanBeachKite.debugState() };
    }, { corona: CORONA, rootName: ROOT_NAME });
    expect("away-sleeps-but-retains-root",
      !awayState.state.awake && awayState.rootCount === 1 && awayState.uuid === activationSetup.uuid,
      awayState);

    phase = "revisit";
    const revisit = await page.evaluate(async ({ site, rootName }) => {
      const sf = window.__sf;
      const y = sf.map.groundTop(site.x, site.z);
      sf.player.teleportTo({ x: site.x, y: y + 1.5, z: site.z, facing: Math.PI / 2, mode: "walk" });
      await sf.ensureOceanBeachKite();
      sf.oceanBeachKite.update(0, 101, site, 0.5);
      let rootCount = 0;
      sf.scene.traverse((object) => { if (object.name === rootName) rootCount++; });
      return {
        rootCount,
        uuid: sf.oceanBeachKite.group.uuid,
        state: sf.oceanBeachKite.debugState()
      };
    }, { site: activationSetup.site, rootName: ROOT_NAME });
    await sleep(400);
    await settleResponseInspection(responseTasks);
    const revisitKite = kiteRecords("revisit");
    expect("revisit-reuses-root", revisit.rootCount === 1 && revisit.uuid === activationSetup.uuid && revisit.state.awake,
      revisit);
    expect("revisit-does-not-refetch", revisitKite.length === 0, revisitKite.map(publicRequest));

    // Frame the flyer, line and kite together, then submit an explicit current
    // WebGPU frame before reading screenshot pixels.
    const canvasState = await page.evaluate(async () => {
      const sf = window.__sf;
      const state = sf.oceanBeachKite.debugState();
      const runner = state.runner;
      const kite = state.kite;
      const dx = kite[0] - runner[0];
      const dz = kite[2] - runner[2];
      const length = Math.max(1, Math.hypot(dx, dz));
      const sideX = -dz / length;
      const sideZ = dx / length;
      const target = [
        (runner[0] + kite[0]) * 0.5,
        (runner[1] + kite[1]) * 0.5,
        (runner[2] + kite[2]) * 0.5
      ];
      const eye = [target[0] + sideX * 38, target[1] + 7, target[2] + sideZ * 38];
      window.__sfFreeCam(eye, target);
      for (let i = 0; i < 4; i++) sf.tick(0);
      await sf.renderer.backend.device.queue.onSubmittedWorkDone();
      const rect = sf.renderer.domElement.getBoundingClientRect();
      const size = sf.renderer.getDrawingBufferSize(new sf.THREE.Vector2());
      return {
        css: [rect.width, rect.height],
        buffer: [size.x, size.y],
        drawCalls: sf.renderer.info.render.drawCalls ?? sf.renderer.info.render.calls ?? 0,
        triangles: sf.renderer.info.render.triangles ?? 0,
        webgpu: sf.renderer.backend.isWebGPUBackend === true,
        device: Boolean(sf.renderer.backend.device),
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };
    });
    await sleep(200);
    const clipX = Math.max(0, Math.round(canvasState.clip.x));
    const clipY = Math.max(0, Math.round(canvasState.clip.y));
    const clip = {
      x: clipX,
      y: clipY,
      width: Math.max(1, Math.min(VIEWPORT.width - clipX, Math.round(canvasState.clip.width))),
      height: Math.max(1, Math.min(VIEWPORT.height - clipY, Math.round(canvasState.clip.height)))
    };
    const screenshotPath = path.join(OUT, "ocean-beach-kite.png");
    const screenshot = await page.screenshot({ path: screenshotPath, clip });
    const screenshotStats = await sharp(screenshot).stats();
    const maxDeviation = Math.max(...screenshotStats.channels.slice(0, 3).map((channel) => channel.stdev));
    expect("canvas-remains-live",
      canvasState.webgpu && canvasState.device && canvasState.css.every((n) => n > 0) &&
        canvasState.buffer.every((n) => n > 0),
      canvasState);
    expect("screenshot-is-nonblank", screenshotStats.entropy > 2 && maxDeviation > 8,
      { entropy: screenshotStats.entropy, maxDeviation, screenshotPath });

    const gpuScopeError = await page.evaluate(async () => {
      const device = window.__sf.renderer.backend.device;
      await device.queue.onSubmittedWorkDone();
      const scoped = await device.popErrorScope();
      return {
        scoped: scoped?.message ?? null,
        uncaptured: window.__oceanKiteProbeGpuErrors.slice()
      };
    });
    expect("webgpu-no-validation-or-device-errors",
      !gpuScopeError.scoped && gpuScopeError.uncaptured.length === 0, gpuScopeError);
    expect("runtime-no-page-errors", pageErrors.length === 0, pageErrors);
    expect("runtime-no-console-errors", consoleErrors.length === 0, consoleErrors);

    const report = {
      url: bootUrl,
      checks,
      phases: {
        boot: bootKite.map(publicRequest),
        activation: activationKite.map(publicRequest),
        revisit: revisitKite.map(publicRequest)
      },
      bootState,
      activation: { setup: activationSetup, scene: activationScene },
      behavior,
      awayState,
      revisit,
      canvas: canvasState,
      screenshot: {
        path: screenshotPath,
        entropy: screenshotStats.entropy,
        maxDeviation
      },
      gpu: gpuScopeError,
      pageErrors,
      consoleErrors
    };
    await writeFile(path.join(OUT, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);

    const failed = checks.filter((check) => !check.pass);
    for (const check of checks) {
      console.log(`[ocean-kite] ${check.pass ? "PASS" : "FAIL"} ${check.id}`);
    }
    console.log(`[ocean-kite] screenshot ${screenshotPath}`);
    console.log(`[ocean-kite] summary ${path.join(OUT, "summary.json")}`);
    if (failed.length > 0) {
      throw new Error(`${failed.length} check(s) failed: ${failed.map((check) => check.id).join(", ")}`);
    }
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[ocean-kite] FAIL", error);
  process.exitCode = 1;
});
