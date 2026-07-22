// Headless WebGPU + lazy-loading verification for the restored Sutro Baths.
//
// The probe uses isolated browser contexts so its three loading phases are
// unambiguous:
//   1. clean boot at the normal saved/default spawn: the cheap layout contract
//      may be in main, but no optional Sutro module/chunk may be requested;
//   2. a cold `spawn=sutroBaths` visit: the hall and its prewarmed static
//      WebGPU water must become visible atomically, then the close steam boundary
//      must cross and produce a nonblank rendered scene;
//   3. movement into the great plunge: the existing GPU field must continue to
//      animate without compute work or another Sutro request.
//
// Run against an existing dev or production server:
//   SF_PROBE_URL=http://127.0.0.1:5240 node tools/sutro-baths-probe.mjs

// Evidence is written under .data/sutro-baths-probe by default.

// This project intentionally requires WebGPU. The probe enables Chrome's native
// WebGPU path and fails clearly instead of attempting any WebGL fallback.

import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/sutro-baths-probe");
const VIEWPORT = { width: 1600, height: 1000 };
const SITE = { x: -6125, z: 1117, yaw: -0.077, waterY: 5.18 };
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

function localPoint(x, y, z) {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
}

/**
 * Production's site-level dynamic import is named index-[hash].js. Discover
 * its identity from the local build instead of guessing from a generic name.
 * The source-path classifier below remains the authority for Vite dev.
 */
async function discoverBuiltChunks() {
  const directory = path.join(ROOT, "dist", "assets");
  const result = { site: new Set(), water: new Set(), steam: new Set(), legacyFluid: new Set() };
  if (!(await exists(directory))) return result;
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".js")) continue;
    const source = await readFile(path.join(directory, name), "utf8");
    if (source.includes("sutro_baths_restored_1896")) result.site.add(name);
    if (source.includes("sutro_baths_static_water_surface")) result.water.add(name);
    if (
      source.includes("sutro_baths_seven_pool_webgpu_water") ||
      source.includes("sutro_baths_shared_water_field") ||
      source.includes("Sutro Baths water simulation requires")
    ) {
      result.legacyFluid.add(name);
    }
    if (source.includes("sutro_baths_thermal_steam")) result.steam.add(name);
  }
  return result;
}

function createClassifier(built) {
  return (url) => {
    let pathname = url;
    try {
      pathname = new URL(url).pathname;
    } catch {}
    const base = pathname.split("/").at(-1) ?? "";
    const sourceRoot = pathname.includes("/src/world/sutroBaths/");
    const eagerLayout = sourceRoot && /\/layout\.ts$/.test(pathname);
    const sourceWater = sourceRoot && /\/staticWater\.ts$/.test(pathname);
    const sourceLegacyFluid = sourceRoot && /\/waterSimulation\.ts$/.test(pathname);
    const sourceSteam = sourceRoot && /\/steam\.ts$/.test(pathname);
    const sourceSite = sourceRoot && !eagerLayout && !sourceWater && !sourceSteam;
    const authoredRegion = pathname.endsWith("/regions/sutro-baths.glb");
    const destinationTile = pathname.endsWith("/tiles/tile_1_12.glb");
    const authoredColliders = pathname.endsWith("/data/colliders/tile_1_12.json");
    const worldTile = /\/tiles\/tile_\d+_\d+\.glb$/.test(pathname);
    const colliderTile = /\/data\/colliders\/tile_\d+_\d+\.json$/.test(pathname);
    const kinds = [];
    if (eagerLayout) kinds.push("eager-layout");
    if (authoredRegion) kinds.push("region-visual");
    if (destinationTile) kinds.push("destination-tile");
    if (authoredColliders) kinds.push("site-colliders");
    if (worldTile) kinds.push("world-tile");
    if (colliderTile) kinds.push("collider-tile");
    if (sourceSite || built.site.has(base)) kinds.push("site-runtime");
    if (sourceWater || built.water.has(base)) kinds.push("water-runtime");
    if (sourceLegacyFluid || built.legacyFluid.has(base)) kinds.push("legacy-fluid-runtime");
    if (sourceSteam || built.steam.has(base)) kinds.push("steam-runtime");
    if (["region-visual", "site-runtime", "water-runtime", "steam-runtime", "legacy-fluid-runtime"].some((kind) => kinds.includes(kind))) {
      kinds.push("optional-sutro");
    }
    return { pathname, kinds: [...new Set(kinds)] };
  };
}

function publicRecord(record) {
  return {
    phase: record.phase,
    atMs: record.atMs,
    method: record.method,
    resourceType: record.resourceType,
    pathname: record.pathname,
    kinds: record.kinds,
    status: record.status ?? null,
    encodedBodySize: record.encodedBodySize ?? null,
    failure: record.failure ?? null
  };
}

function summarize(records, phase) {
  const rows = records.filter((record) => record.phase === phase);
  const byKind = {};
  let encodedBodySize = 0;
  for (const row of rows) {
    encodedBodySize += row.encodedBodySize ?? 0;
    for (const kind of row.kinds) byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return { requests: rows.length, encodedBodySize, byKind };
}

async function imageAudit(file) {
  const metadata = await sharp(file).metadata();
  const stats = await sharp(file).stats();
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    entropy: stats.entropy,
    channelStdDev: stats.channels.slice(0, 3).map((channel) => channel.stdev)
  };
}

async function temporalDelta(beforeFile, afterFile) {
  const [before, after] = await Promise.all([
    sharp(beforeFile).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(afterFile).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  ]);
  if (
    before.info.width !== after.info.width ||
    before.info.height !== after.info.height ||
    before.info.channels !== after.info.channels
  ) {
    throw new Error("Temporal Sutro screenshots changed dimensions");
  }
  let absolute = 0;
  let changed = 0;
  const channels = before.info.channels;
  const pixels = before.info.width * before.info.height;
  for (let offset = 0; offset < before.data.length; offset += channels) {
    let pixelDelta = 0;
    for (let channel = 0; channel < channels; channel++) {
      const delta = Math.abs(before.data[offset + channel] - after.data[offset + channel]);
      absolute += delta;
      pixelDelta = Math.max(pixelDelta, delta);
    }
    if (pixelDelta >= 3) changed++;
  }
  return {
    meanChannelDelta: absolute / (before.data.length * 255),
    changedPixelRatio: changed / pixels
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await waitHttp(BASE_URL);
  const builtChunks = await discoverBuiltChunks();
  const classify = createClassifier(builtChunks);
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
      "--hide-scrollbars",
      "--mute-audio"
    ]
  });

  const startedAt = performance.now();
  const records = [];
  const allRequests = { boot: 0, activation: 0, subsequent: 0 };
  const checks = [];
  const pageErrors = [];
  const consoleMessages = [];
  let phase = "boot";
  let mode = "unknown";

  const nowMs = () => Math.round(performance.now() - startedAt);
  const expect = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), detail });
  const hasKind = (record, kind) => record.kinds.includes(kind);
  const phaseRows = (name) => records.filter((record) => record.phase === name);

  const createContext = () => browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    serviceWorkers: "block"
  });

  const instrument = (page) => {
    const requestRows = new Map();
    page.on("pageerror", (error) => pageErrors.push({ phase, atMs: nowMs(), message: String(error) }));
    page.on("console", (message) => {
      if (!["warning", "error"].includes(message.type()) || consoleMessages.length >= 250) return;
      consoleMessages.push({
        phase,
        atMs: nowMs(),
        type: message.type(),
        text: message.text(),
        location: message.location()
      });
    });
    page.on("request", (request) => {
      allRequests[phase]++;
      if (request.url().includes("/@vite/client")) mode = "vite-dev";
      const { pathname, kinds } = classify(request.url());
      if (kinds.length === 0) return;
      const row = {
        phase,
        atMs: nowMs(),
        method: request.method(),
        resourceType: request.resourceType(),
        pathname,
        kinds
      };
      records.push(row);
      requestRows.set(request, row);
    });
    page.on("response", (response) => {
      const row = requestRows.get(response.request());
      if (!row) return;
      row.status = response.status();
      const bytes = Number(response.headers()["content-length"] ?? 0);
      if (Number.isFinite(bytes)) row.encodedBodySize = bytes;
    });
    page.on("requestfailed", (request) => {
      const row = requestRows.get(request);
      if (!row) return;
      row.failure = request.failure()?.errorText ?? "request failed";
    });
  };

  try {
    // Phase one: exact requested clean boot, in a context that cannot inherit a
    // cache or service worker from any previous QA pass.
    phase = "boot";
    const bootContext = await createContext();
    const bootPage = await bootContext.newPage();
    instrument(bootPage);
    const bootUrl = `${BASE_URL}/?autostart=1&fullfps=1&profile=1&spawn=missionDolores`;
    await bootPage.goto(bootUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await bootPage.waitForFunction(
      () => Boolean(
        window.__sf?.renderer?.backend?.device &&
        window.__sf?.player &&
        document.body.classList.contains("started")
      ),
      null,
      { timeout: 180_000 }
    );
    await bootPage.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 180_000 });
    await bootPage.waitForTimeout(1800);
    const bootState = await bootPage.evaluate(() => ({
      backend: window.__sf.renderer.backend?.constructor?.name ?? null,
      webgpu: window.__sf.renderer.backend?.isWebGPUBackend === true,
      player: {
        x: Number(window.__sf.player.position.x.toFixed(1)),
        z: Number(window.__sf.player.position.z.toFixed(1))
      },
      site: Boolean(window.__sf.sutroBaths),
      siteRoot: Boolean(window.__sf.scene.getObjectByName("sutro_baths_restored_1896")),
      authoredRegion: window.__sf.authoredRegions.debugSnapshot(),
      renderIdle: window.__sf.renderIdle?.() === true
    }));
    const bootOptional = phaseRows("boot").filter((record) => hasKind(record, "optional-sutro"));
    expect("boot-direct-webgpu", bootState.webgpu, bootState);
    expect("boot-zero-sutro-optional-requests", bootOptional.length === 0, bootOptional.map(publicRecord));
    expect(
      "boot-site-remains-unconstructed",
      !bootState.site && !bootState.siteRoot &&
        bootState.authoredRegion.every((region) => region.status === "dormant"),
      bootState
    );
    await bootContext.close();

    // Phase two: a new context is a real cold visitor. The authored spawn should
    // cross both the hall boundary and its second, close-range effects boundary.
    phase = "activation";
    const context = await createContext();
    const page = await context.newPage();
    instrument(page);
    await page.addInitScript(() => {
      const audit = {
        visibleSiteFrames: 0,
        missingWaterFrames: 0,
        firstMissingAtMs: null
      };
      window.__sutroWaterResidencyAudit = audit;
      const sample = () => {
        const scene = window.__sf?.scene;
        const site = scene?.getObjectByName("sutro_baths_restored_1896");
        if (site?.visible) {
          audit.visibleSiteFrames++;
          const water = scene.getObjectByName("sutro_baths_static_water_surface");
          let waterVisible = Boolean(water);
          for (let object = water; waterVisible && object && object !== scene; object = object.parent) {
            waterVisible = object.visible;
          }
          if (!waterVisible) {
            audit.missingWaterFrames++;
            audit.firstMissingAtMs ??= Math.round(performance.now());
          }
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const activationUrl = `${BASE_URL}/?autostart=1&fullfps=1&profile=1&spawn=sutroBaths`;
    await page.goto(activationUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(
      () => Boolean(
        window.__sf?.renderer?.backend?.device &&
        window.__sf?.sutroBaths?.debugState?.().nearEffectsLoaded &&
        window.__sf.sutroBaths.debugState().water?.staticSurface === true &&
        window.__sf.sutroBaths.debugState().water?.stats?.revision > 0 &&
        document.body.classList.contains("started")
      ),
      null,
      { timeout: 240_000 }
    );
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 180_000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => Promise.race([
      window.__sf.renderer.backend.device.queue.onSubmittedWorkDone(),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]));

    const activationState = await page.evaluate(() => {
      const sf = window.__sf;
      const site = sf.sutroBaths;
      const debug = site.debugState();
      const canvas = sf.renderer.domElement.getBoundingClientRect();
      const buffer = sf.renderer.getDrawingBufferSize(new sf.THREE.Vector2());
      const names = [
        "sutro_baths_restored_1896",
        "sutro_baths_restored_architecture",
        "sutro_baths_player_entrances_v5",
        "sutro_baths_beach_gate_v4",
        "sutro_baths_glass_barrel_roof",
        "sutro_baths_ocean_window_seating_gallery",
        "sutro_baths_unified_foliage",
        "sutro_baths_static_water_surface",
        "sutro_baths_thermal_steam"
      ];
      const siteLocalPoint = (x, y, z) => {
        const c = Math.cos(-0.077);
        const s = Math.sin(-0.077);
        return new sf.THREE.Vector3(-6125 + c * x + s * z, y, 1117 - s * x + c * z);
      };
      // Player-height ray through the centre of the road doorway. The retained
      // full-hall Mesh_13.016 crossrail used to hit this segment at local
      // x=35.614; the split side runs must leave the whole 5 m route clear.
      const doorwayOrigin = siteLocalPoint(40.5, 31.78, 63.1);
      const doorwayTarget = siteLocalPoint(33.0, 31.78, 63.1);
      const doorwayDirection = doorwayTarget.clone().sub(doorwayOrigin);
      const doorwayDistance = doorwayDirection.length();
      const architectureRoot = sf.scene.getObjectByName("sutro_baths_restored_architecture");
      const doorwayHits = (architectureRoot ? new sf.THREE.Raycaster(
        doorwayOrigin,
        doorwayDirection.normalize(),
        0.02,
        doorwayDistance
      ).intersectObject(architectureRoot, true) : []).filter((hit) => {
        let object = hit.object;
        while (object && object !== sf.scene) {
          if (!object.visible) return false;
          object = object.parent;
        }
        const materials = Array.isArray(hit.object.material)
          ? hit.object.material
          : hit.object.material
            ? [hit.object.material]
            : [];
        const materialIndex = hit.face?.materialIndex ?? 0;
        const material = materials[materialIndex] ?? materials[0];
        return !material || (material.visible !== false && !material.transparent && material.opacity >= 0.8);
      }).map((hit) => ({
        name: hit.object.name,
        material: Array.isArray(hit.object.material)
          ? hit.object.material[hit.face?.materialIndex ?? 0]?.name ?? null
          : hit.object.material?.name ?? null,
        distance: Number(hit.distance.toFixed(3)),
        instanceId: hit.instanceId ?? null
      }));
      return {
        backend: sf.renderer.backend?.constructor?.name ?? null,
        webgpu: sf.renderer.backend?.isWebGPUBackend === true,
        player: {
          x: Number(sf.player.position.x.toFixed(2)),
          y: Number(sf.player.position.y.toFixed(2)),
          z: Number(sf.player.position.z.toFixed(2))
        },
        debug,
        waterResidency: window.__sutroWaterResidencyAudit,
        waveAudio: sf.waveAudio.debugState,
        authoredRegion: sf.authoredRegions.debugSnapshot(),
        backgroundStreaming: sf.tiles.backgroundStreamingDebug,
        stats: site.stats,
        namedObjects: Object.fromEntries(names.map((name) => [name, Boolean(sf.scene.getObjectByName(name))])),
        doorwayClearance: {
          clear: doorwayHits.length === 0,
          distance: doorwayDistance,
          hits: doorwayHits
        },
        renderer: {
          calls: sf.renderer.info.render.drawCalls ?? sf.renderer.info.render.calls ?? 0,
          triangles: sf.renderer.info.render.triangles ?? 0,
          geometries: sf.renderer.info.memory?.geometries ?? null,
          textures: sf.renderer.info.memory?.textures ?? null
        },
        canvas: {
          cssWidth: Math.round(canvas.width),
          cssHeight: Math.round(canvas.height),
          bufferWidth: buffer.x,
          bufferHeight: buffer.y,
          dpr: devicePixelRatio
        }
      };
    });

    const activationRows = phaseRows("activation");
    const activationFailures = activationRows.filter((row) => row.failure || (row.status != null && row.status >= 400));
    const activationStartedAt = Math.min(...activationRows.map((row) => row.atMs));
    const firstSecondRows = activationRows.filter((row) => row.atMs - activationStartedAt <= 1000);
    const firstSecondWorldTiles = firstSecondRows.filter((row) => hasKind(row, "world-tile"));
    const regionRequest = activationRows.find((row) => hasKind(row, "region-visual"));
    expect(
      "activation-authored-region-requested-once",
      activationRows.filter((row) => hasKind(row, "region-visual")).length === 1,
      activationRows.map(publicRecord)
    );
    expect(
      "activation-destination-tile-requested-once",
      activationRows.filter((row) => hasKind(row, "destination-tile")).length === 1,
      activationRows.map(publicRecord)
    );
    expect(
      "activation-landmark-priority-window",
      Boolean(regionRequest) && regionRequest.atMs - activationStartedAt <= 100 &&
        firstSecondWorldTiles.length > 0 && firstSecondWorldTiles.length <= 4,
      firstSecondRows.map(publicRecord)
    );
    expect(
      "activation-authored-colliders-requested",
      activationRows.filter((row) => hasKind(row, "site-colliders")).length >= 1 &&
        activationRows.filter((row) => hasKind(row, "site-colliders")).length <= 2,
      activationRows.map(publicRecord)
    );
    expect("activation-site-runtime-requested", activationRows.some((row) => hasKind(row, "site-runtime")), activationRows.map(publicRecord));
    expect("activation-water-runtime-requested", activationRows.some((row) => hasKind(row, "water-runtime")), activationRows.map(publicRecord));
    expect("activation-steam-runtime-requested", activationRows.some((row) => hasKind(row, "steam-runtime")), activationRows.map(publicRecord));
    expect(
      "activation-no-fluid-simulation-runtime",
      !activationRows.some((row) => hasKind(row, "legacy-fluid-runtime")) && builtChunks.legacyFluid.size === 0,
      { requests: activationRows.map(publicRecord), built: [...builtChunks.legacyFluid] }
    );
    expect("activation-sutro-requests-succeeded", activationFailures.length === 0, activationFailures.map(publicRecord));
    expect("activation-direct-webgpu", activationState.webgpu, activationState.backend);
    expect(
      "activation-authored-region-atomic-ready",
      activationState.authoredRegion.some((region) =>
        region.id === "sutro-baths" && region.status === "ready" && region.terrainActive
      ),
      activationState.authoredRegion
    );
    expect("activation-site-awake", activationState.debug.awake && !activationState.debug.disposed, activationState.debug);
    expect(
      "activation-all-signature-groups-present",
      Object.values(activationState.namedObjects).every(Boolean),
      activationState.namedObjects
    );
    expect(
      "activation-road-doorway-player-height-clear",
      activationState.doorwayClearance.clear,
      activationState.doorwayClearance
    );
    expect(
      "activation-restoration-detail-present",
      activationState.stats.roofRibs >= 16 &&
        activationState.stats.glassPanels >= 100 &&
        activationState.stats.lamps >= 8 &&
        activationState.stats.planters >= 1,
      activationState.stats
    );
    expect(
      "activation-static-water-no-compute",
      activationState.debug.water?.webgpu === true &&
        activationState.debug.water?.staticSurface === true &&
        activationState.debug.water?.stats?.backend === "WebGPU analytical surface" &&
        activationState.debug.water?.stats?.simulated === false &&
        activationState.debug.water?.stats?.computeDispatches === 0 &&
        activationState.debug.water?.stats?.vertices > 1000 &&
        activationState.debug.water?.stats?.triangles > 1000 &&
        activationState.debug.water?.stats?.animated === true,
      activationState.debug.water
    );
    expect(
      "activation-visible-pools-never-miss-water",
      activationState.waterResidency.visibleSiteFrames > 0 &&
        activationState.waterResidency.missingWaterFrames === 0,
      activationState.waterResidency
    );
    expect(
      "activation-steam-awake",
      activationState.debug.steam?.puffs === 4 &&
        activationState.debug.steam?.awake === true &&
        activationState.debug.steam?.visible > 0,
      activationState.debug.steam
    );
    expect(
      "activation-sutro-wave-bed-silent",
      activationState.waveAudio.level <= 0.002 && activationState.waveAudio.washGain <= 0.002,
      activationState.waveAudio
    );
    expect(
      "activation-canvas-has-display-and-buffer",
      activationState.canvas.cssWidth > 0 &&
        activationState.canvas.cssHeight > 0 &&
        activationState.canvas.bufferWidth > 0 &&
        activationState.canvas.bufferHeight > 0,
      activationState.canvas
    );

    // Exercise the streamed-floor recovery at both elevations. These forced
    // under-floor poses model the bad handoff/tunnelling case directly: deck
    // corridors must recover to the deck, while pool footprints must recover
    // only to the basin so entering the water remains possible.
    const forceBelowFloor = async (point) => {
      await page.evaluate(([x, y, z]) => {
        const sf = window.__sf;
        // Recreate the walk body through Player so its interpolation history
        // cannot overwrite the forced pose on the next frame. Writing only
        // the physics transform made sequential recovery checks race the walk
        // controller and occasionally continue falling from the prior check.
        sf.player.restoreState({ x, y, z, heading: sf.player.heading, mode: "walk" });
        sf.physics.world.setBodyVelocity(sf.player.body, [0, -8, 0], [0, 0, 0]);
        sf.physics.world.setBodyAwake(sf.player.body, true);
      }, point);
      await page.waitForTimeout(450);
      return page.evaluate(() => ({
        x: window.__sf.player.position.x,
        y: window.__sf.player.position.y,
        z: window.__sf.player.position.z
      }));
    };
    const roadRecovery = await forceBelowFloor(localPoint(44.25, 29.58, 63.1));
    const foyerRecovery = await forceBelowFloor(localPoint(36.0, 29.58, 63.1));
    const switchbackRecovery = await forceBelowFloor(localPoint(29.5, 19.995, 59.2));
    const beachRecovery = await forceBelowFloor(localPoint(-48, 2.58, 33.29));
    const deckRecovery = await forceBelowFloor(localPoint(-7, 4.12, 0));
    const basinRecovery = await forceBelowFloor(localPoint(-20, 1.12, 8));
    const collisionRecovery = {
      road: roadRecovery,
      foyer: foyerRecovery,
      switchback: switchbackRecovery,
      beach: beachRecovery,
      deck: deckRecovery,
      basin: basinRecovery
    };
    expect(
      "activation-road-entrance-fallthrough-recovers",
      Math.abs(roadRecovery.y - (31.18 + 0.92)) < 0.12,
      collisionRecovery
    );
    expect(
      "activation-road-foyer-fallthrough-recovers",
      Math.abs(foyerRecovery.y - (31.18 + 0.92)) < 0.12,
      collisionRecovery
    );
    expect(
      "activation-switchback-fallthrough-recovers",
      Math.abs(switchbackRecovery.y - (21.495 + 0.92)) < 0.12,
      collisionRecovery
    );
    expect(
      "activation-beach-stair-fallthrough-recovers",
      Math.abs(beachRecovery.y - (4.23 + 0.92)) < 0.12,
      collisionRecovery
    );
    expect(
      "activation-deck-fallthrough-recovers",
      Math.abs(deckRecovery.y - (5.62 + 0.92)) < 0.12,
      collisionRecovery
    );
    expect(
      "activation-pool-fallthrough-recovers-to-basin",
      Math.abs(basinRecovery.y - (2.62 + 0.92)) < 0.12,
      collisionRecovery
    );

    // Canvas-only captures deliberately exclude DOM HUD/debug overlays.
    const canvas = page.locator("#app > canvas").first();
    await page.evaluate(() => window.__sf.hud?.setHidden?.(true));
    const screenshotEvidence = {};
    const arrivalFile = path.join(OUT, "arrival-exterior.png");
    await canvas.screenshot({ path: arrivalFile });
    screenshotEvidence["arrival-exterior.png"] = {
      file: arrivalFile,
      ...(await imageAudit(arrivalFile))
    };
    expect(
      "visual-arrival-exterior-nonblank",
      screenshotEvidence["arrival-exterior.png"].entropy > 3 &&
        screenshotEvidence["arrival-exterior.png"].channelStdDev.some((value) => value > 20),
      screenshotEvidence["arrival-exterior.png"]
    );
    const shots = [
      {
        name: "road-main-entrance.png",
        eye: localPoint(60.5, 34.4, 63.1),
        target: localPoint(35.5, 33.6, 63.1)
      },
      {
        name: "road-foyer-switchback.png",
        eye: localPoint(42.5, 35.0, 63.1),
        target: localPoint(29.5, 22.5, 59)
      },
      {
        name: "beach-gate-approach.png",
        eye: localPoint(-62, 5.4, 33.29),
        target: localPoint(-36, 7.2, 33.29)
      },
      {
        name: "hall-from-south.png",
        eye: localPoint(27, 17.5, 56),
        target: localPoint(-7, 8, -17)
      },
      {
        name: "ocean-window-gallery.png",
        eye: localPoint(16, 13.5, -4),
        target: localPoint(-39, 10.8, -4)
      },
      {
        name: "thermal-pools-close.png",
        eye: localPoint(4, 10.5, 12),
        target: localPoint(-17, SITE.waterY + 0.15, 2)
      }
    ];
    for (const shot of shots) {
      await page.evaluate(({ eye, target }) => window.__sfFreeCam(eye, target), shot);
      await page.waitForTimeout(900);
      const file = path.join(OUT, shot.name);
      await canvas.screenshot({ path: file });
      screenshotEvidence[shot.name] = { file, ...(await imageAudit(file)) };
      expect(
        `visual-${shot.name}-nonblank`,
        screenshotEvidence[shot.name].entropy > 3 &&
          screenshotEvidence[shot.name].channelStdDev.some((value) => value > 20),
        screenshotEvidence[shot.name]
      );
    }

    // Phase three: move into the great plunge. The analytical water and steam
    // must keep animating without a simulation dispatch or a feature refetch.
    const beforeAction = await page.evaluate(() => {
      const debug = window.__sf.sutroBaths.debugState();
      return {
        computeDispatches: debug.water.stats.computeDispatches,
        revision: debug.water.stats.revision,
        steamVisible: debug.steam.visible
      };
    });
    phase = "subsequent";
    const plunge = localPoint(-20, SITE.waterY + 1.25, 8);
    await page.evaluate(([x, y, z]) => {
      const sf = window.__sf;
      sf.player.teleportTo({ x, y, z, facing: -0.15, mode: "walk" });
    }, plunge);
    await page.waitForTimeout(1500);
    await page.evaluate(() => Promise.race([
      window.__sf.renderer.backend.device.queue.onSubmittedWorkDone(),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]));
    const afterAction = await page.evaluate(() => {
      const debug = window.__sf.sutroBaths.debugState();
      return {
        distanceToBaths: debug.distanceToBaths,
        staticSurface: debug.water.staticSurface,
        playerDistance: debug.water.stats.playerDistance,
        simulated: debug.water.stats.simulated,
        computeDispatches: debug.water.stats.computeDispatches,
        revision: debug.water.stats.revision,
        steamVisible: debug.steam.visible
      };
    });
    const subsequentRows = phaseRows("subsequent").filter((row) => hasKind(row, "optional-sutro"));
    expect("subsequent-zero-sutro-refetch", subsequentRows.length === 0, subsequentRows.map(publicRecord));
    expect(
      "subsequent-water-animates-without-compute",
      afterAction.staticSurface &&
        afterAction.playerDistance < 1 &&
        afterAction.simulated === false &&
        beforeAction.computeDispatches === 0 &&
        afterAction.computeDispatches === 0 &&
        afterAction.revision > beforeAction.revision,
      { before: beforeAction, after: afterAction }
    );

    // Capture a second close frame after movement. The static-water revision and
    // zero-dispatch telemetry above are authoritative; pixel delta confirms the
    // analytical ripple and retained steam are not a frozen card.
    const closeFirst = path.join(OUT, "thermal-pools-close.png");
    const closeLater = path.join(OUT, "thermal-pools-close-later.png");
    const closeShot = shots.find((shot) => shot.name === "thermal-pools-close.png");
    if (!closeShot) throw new Error("Thermal-pool visual shot is missing");
    await page.evaluate(({ eye, target }) => window.__sfFreeCam(eye, target), closeShot);
    await page.waitForTimeout(250);
    await canvas.screenshot({ path: closeFirst });
    await page.waitForTimeout(550);
    await canvas.screenshot({ path: closeLater });
    screenshotEvidence["thermal-pools-close-later.png"] = {
      file: closeLater,
      ...(await imageAudit(closeLater))
    };
    const animation = await temporalDelta(closeFirst, closeLater);
    expect(
      "visual-close-effects-animate",
      animation.meanChannelDelta > 0.00005 &&
        animation.changedPixelRatio > 0.001 &&
        animation.meanChannelDelta < 0.2,
      animation
    );

    const frameTiming = await page.evaluate(() => new Promise((resolve) => {
      const samples = [];
      let last = performance.now();
      const frame = (now) => {
        const delta = now - last;
        last = now;
        if (delta < 250) samples.push(delta);
        if (samples.length < 180) {
          requestAnimationFrame(frame);
          return;
        }
        const sorted = [...samples].sort((a, b) => a - b);
        const meanMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
        resolve({
          samples: samples.length,
          meanMs,
          p50Ms: sorted[Math.floor(sorted.length * 0.5)],
          p95Ms: sorted[Math.floor(sorted.length * 0.95)],
          p99Ms: sorted[Math.floor(sorted.length * 0.99)],
          fps: 1000 / meanMs
        });
      };
      requestAnimationFrame(frame);
    }));
    expect(
      "runtime-interior-frame-pacing-bounded",
      frameTiming.samples === 180 && frameTiming.p95Ms < 80,
      frameTiming
    );

    const gpuPattern = /WebGPU|GPUValidation|WGSL|storage buffer|compute pipeline|bind group/i;
    const gpuErrors = [
      ...pageErrors.filter((error) => gpuPattern.test(error.message)),
      ...consoleMessages.filter((message) => message.type === "error" && gpuPattern.test(message.text))
    ];
    const unexpectedConsoleErrors = consoleMessages.filter((message) => {
      if (message.type !== "error") return false;
      if (mode !== "vite-dev") return true;
      // The bare Vite preview intentionally has neither the multiplayer relay
      // nor the weather API. Those 404s are preview infrastructure, not scene
      // runtime failures; production/server probes still treat them as errors.
      return !(
        /WebSocket connection .*\/ws.*404/i.test(message.text) ||
        (/404 \(Not Found\)/i.test(message.text) && message.location?.url?.includes("/api/weather/fog")) ||
        (/503 \(Service Unavailable\)/i.test(message.text) &&
          message.location?.url?.includes("/api/starlink"))
      );
    });
    expect("runtime-no-page-errors", pageErrors.length === 0, pageErrors);
    expect(
      "runtime-no-console-errors",
      unexpectedConsoleErrors.length === 0,
      unexpectedConsoleErrors
    );
    expect("runtime-no-webgpu-errors", gpuErrors.length === 0, gpuErrors);

    if (mode === "unknown") mode = "preview-or-production";
    const result = {
      generatedAt: new Date().toISOString(),
      pass: checks.every((check) => check.pass),
      target: {
        baseUrl: BASE_URL,
        bootUrl,
        activationUrl,
        browser: await browser.version(),
        executablePath,
        mode,
        viewport: VIEWPORT,
        dpr: 1,
        serviceWorkers: "blocked",
        requiredBackend: "WebGPU"
      },
      builtChunkDiscovery: Object.fromEntries(
        Object.entries(builtChunks).map(([key, value]) => [key, [...value].sort()])
      ),
      checks,
      phases: {
        boot: {
          state: bootState,
          allRequests: allRequests.boot,
          summary: summarize(records, "boot"),
          sutroRequests: phaseRows("boot").map(publicRecord)
        },
        activation: {
          state: activationState,
          collisionRecovery,
          allRequests: allRequests.activation,
          summary: summarize(records, "activation"),
          sutroRequests: activationRows.map(publicRecord)
        },
        subsequent: {
          state: { before: beforeAction, after: afterAction },
          allRequests: allRequests.subsequent,
          summary: summarize(records, "subsequent"),
          sutroRequests: phaseRows("subsequent").map(publicRecord)
        }
      },
      animation,
      frameTiming,
      renderer: activationState.renderer,
      screenshots: screenshotEvidence,
      pageErrors,
      consoleMessages
    };
    const resultFile = path.join(OUT, "result.json");
    await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);

    for (const check of checks) console.log(`[${check.pass ? "PASS" : "FAIL"}] ${check.id}`);
    console.log(`[sutro-baths] boot: ${summarize(records, "boot").requests} tracked Sutro request(s)`);
    console.log(`[sutro-baths] activation: ${summarize(records, "activation").requests} tracked Sutro request(s)`);
    console.log(`[sutro-baths] subsequent: ${summarize(records, "subsequent").requests} tracked Sutro request(s)`);
    console.log(`[sutro-baths] report: ${resultFile}`);
    console.log(`[sutro-baths] screenshots: ${OUT}`);
    if (!result.pass) process.exitCode = 1;
    await context.close();
  } catch (error) {
    const failure = {
      generatedAt: new Date().toISOString(),
      pass: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      checks,
      records: records.map(publicRecord),
      pageErrors,
      consoleMessages
    };
    await writeFile(path.join(OUT, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`);
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`[sutro-baths] ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
