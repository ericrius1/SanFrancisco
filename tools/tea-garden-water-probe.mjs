// Headless WebGPU regression probe for the Japanese Tea Garden's connected
// Drum Bridge stream and south pond.
//
// Verifies the real lazy waterfall, direct WebGPU backend, one unified dense
// shallow-water surface, green shoreline replacement, eddy rocks, live compute
// counters, shared-context procedural audio, late Tweakpane controls, and two
// nonblank water-focused views.
//
// Run against an existing Vite server:
//   SF_PROBE_URL=http://127.0.0.1:5240 node tools/tea-garden-water-probe.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import sharp from "sharp";

const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
const OUT = ".data/tea-garden-water-probe";
const BRIDGE = { x: -2274.2, z: 2193.2 };
const POND_ENTRY = { x: -2290.4, z: 2202.4 };
const POND_CENTER = { x: -2288.7, z: 2219.2 };

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

async function temporalPixelDelta(before, after, crop, intervalMs = 550) {
  const [left, right] = await Promise.all([
    sharp(before).extract(crop).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(after).extract(crop).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  ]);
  assert.deepEqual(left.info, right.info, "temporal water frames changed dimensions");
  const channels = left.info.channels;
  const pixels = left.info.width * left.info.height;
  let channelDelta = 0;
  let changedPixels = 0;
  for (let offset = 0; offset < left.data.length; offset += channels) {
    let pixelDelta = 0;
    for (let channel = 0; channel < channels; channel++) {
      const delta = Math.abs(left.data[offset + channel] - right.data[offset + channel]);
      channelDelta += delta;
      pixelDelta = Math.max(pixelDelta, delta);
    }
    if (pixelDelta >= 3) changedPixels++;
  }
  return {
    intervalMs,
    crop,
    meanChannelDelta: channelDelta / (left.data.length * 255),
    changedPixelRatio: changedPixels / pixels
  };
}

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--hide-scrollbars",
    "--mute-audio"
  ]
});

try {
  mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const requests = [];
  const pageErrors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  const teaRequest = (url) => {
    if (url.includes("/src/world/japaneseTeaGarden/layout.ts")) return false;
    return url.includes("/src/world/japaneseTeaGarden/") || url.includes("/art/tea-house/");
  };

  await page.goto(`${SERVER_URL}/?autostart=1&fullfps=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(
    () => window.__sf?.player && window.__sf?.map && document.body.classList.contains("started"),
    undefined,
    { timeout: 150_000 }
  );
  await page.waitForTimeout(1200);

  const backendAtBoot = await page.evaluate(() => ({
    name: window.__sf.renderer.backend?.constructor?.name ?? null,
    webgpu: window.__sf.renderer.backend?.isWebGPUBackend === true
  }));
  assert.equal(backendAtBoot.webgpu, true, `required WebGPU backend missing (${backendAtBoot.name})`);
  const bootRequests = requests.filter(teaRequest);
  assert.deepEqual(bootRequests, [], `clean boot eagerly requested the Tea Garden: ${bootRequests.join(", ")}`);

  const activationStart = requests.length;
  await page.evaluate(({ x, z }) => {
    const sf = window.__sf;
    sf.player.teleportTo({
      x,
      y: sf.map.effectiveGround(x, z) + 1.5,
      z,
      facing: Math.PI * 0.75,
      mode: "walk"
    });
  }, BRIDGE);
  await page.waitForFunction(
    () => window.__sf?.japaneseTeaGarden?.debugState?.().awake,
    undefined,
    { timeout: 150_000 }
  );
  await page.waitForFunction(
    () => window.__sf.scene.getObjectByName("tea_garden_unified_webgpu_shallow_water_surface"),
    undefined,
    { timeout: 150_000 }
  );
  await page.waitForFunction(() => window.__sf.renderIdle?.(), undefined, { timeout: 150_000 });
  await page.waitForTimeout(900);

  const activationRequests = requests.slice(activationStart).filter(teaRequest);
  assert.ok(
    activationRequests.some((url) => url.includes("/japaneseTeaGarden/index.ts")),
    "first approach did not request the Tea Garden chunk"
  );
  assert.ok(
    activationRequests.some((url) => url.includes("/japaneseTeaGarden/waterSimulation.ts")),
    "first approach did not request the WebGPU water solver"
  );
  assert.ok(
    activationRequests.some((url) => url.includes("/japaneseTeaGarden/streamAudio.ts")),
    "first approach did not request the procedural stream audio"
  );

  const geometryAudit = await page.evaluate(() => {
    const sf = window.__sf;
    const site = sf.japaneseTeaGarden;
    const group = sf.scene.getObjectByName("japanese_tea_garden_unified_flowing_water");
    const surface = sf.scene.getObjectByName("tea_garden_unified_webgpu_shallow_water_surface");
    const bank = sf.scene.getObjectByName("tea_garden_narrow_green_shoreline_bank");
    const rocks = sf.scene.getObjectByName("tea_garden_stream_eddy_obstacle_rocks");
    const oldNames = [
      "south_pond_stone_bank",
      "drum_bridge_stream_stone_bank",
      "south_pond_water",
      "drum_bridge_stream_water"
    ].filter((name) => sf.scene.getObjectByName(name));
    const namedSurfaces = [];
    site.group.traverse((object) => {
      if (object.name === "tea_garden_unified_webgpu_shallow_water_surface") namedSurfaces.push(object);
    });

    surface.updateWorldMatrix(true, false);
    const position = surface.geometry.getAttribute("position");
    const index = surface.geometry.index;
    const a = new sf.THREE.Vector3();
    const b = new sf.THREE.Vector3();
    const c = new sf.THREE.Vector3();
    const ab = new sf.THREE.Vector3();
    const ac = new sf.THREE.Vector3();
    let maxTriangleArea = 0;
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(position, index.getX(i)).applyMatrix4(surface.matrixWorld);
      b.fromBufferAttribute(position, index.getX(i + 1)).applyMatrix4(surface.matrixWorld);
      c.fromBufferAttribute(position, index.getX(i + 2)).applyMatrix4(surface.matrixWorld);
      maxTriangleArea = Math.max(
        maxTriangleArea,
        ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() * 0.5
      );
    }
    const bounds = new sf.THREE.Box3().setFromObject(surface);
    const size = bounds.getSize(new sf.THREE.Vector3());
    const terrainRows = [];
    const usedVertices = new Set();
    for (let i = 0; i < index.count; i++) usedVertices.add(index.getX(i));
    const pondSurfaceY = site.debugState().water.pondSurfaceY;
    for (const vertex of usedVertices) {
      a.fromBufferAttribute(position, vertex).applyMatrix4(surface.matrixWorld);
      terrainRows.push({
        clearance: a.y - sf.map.groundTop(a.x, a.z),
        pond: Math.abs(a.y - pondSurfaceY) < 0.0001
      });
    }
    const clearance = (rows) => {
      const values = rows.map((row) => row.clearance).sort((left, right) => left - right);
      const quantile = (p) => values[Math.floor((values.length - 1) * p)];
      return {
        vertices: values.length,
        min: values[0],
        p01: quantile(0.01),
        p05: quantile(0.05),
        median: quantile(0.5),
        max: values.at(-1),
        belowTerrain: values.filter((value) => value <= 0).length,
        under10cm: values.filter((value) => value < 0.1).length
      };
    };
    return {
      groupName: group?.name ?? null,
      unifiedSurfaces: namedSurfaces.length,
      vertices: position.count,
      indexCount: index?.count ?? 0,
      maxTriangleArea,
      bounds: { x: size.x, y: size.y, z: size.z },
      bank: {
        name: bank?.name ?? null,
        replacesAsphalt: bank?.userData.replacesAsphaltAtWater === true,
        vertexColors: bank?.material?.vertexColors === true,
        triangles: (bank?.geometry?.index?.count ?? 0) / 3
      },
      rocks: {
        name: rocks?.name ?? null,
        count: rocks?.count ?? 0,
        obstacles: rocks?.userData.obstacles?.length ?? 0
      },
      terrainClearance: {
        all: clearance(terrainRows),
        pond: clearance(terrainRows.filter((row) => row.pond)),
        stream: clearance(terrainRows.filter((row) => !row.pond)),
        // Default relief can lower a cell by MAX_SIM_HEIGHT * relief.
        defaultWorstDisplaced: Math.min(...terrainRows.map((row) => row.clearance)) - 0.14
      },
      oldNames,
      debug: site.debugState().water,
      interactions: site.debugState().waterInteractions,
      renderer: {
        name: sf.renderer.backend?.constructor?.name ?? null,
        webgpu: sf.renderer.backend?.isWebGPUBackend === true,
        calls: sf.renderer.info.render.calls,
        triangles: sf.renderer.info.render.triangles,
        geometries: sf.renderer.info.memory.geometries,
        textures: sf.renderer.info.memory.textures
      }
    };
  });
  assert.equal(geometryAudit.renderer.webgpu, true, "Tea Garden water did not run on WebGPU");
  assert.equal(geometryAudit.groupName, "japanese_tea_garden_unified_flowing_water");
  assert.equal(geometryAudit.unifiedSurfaces, 1, "stream and pond are no longer one unified surface");
  assert.ok(geometryAudit.vertices > 50_000, "water lost its dense spatial grid");
  assert.ok(geometryAudit.indexCount > 30_000, "water surface lost most active triangles");
  assert.ok(geometryAudit.maxTriangleArea < 0.2, `water contains a clipping-prone ${geometryAudit.maxTriangleArea}m² triangle`);
  assert.ok(geometryAudit.bounds.x > 30 && geometryAudit.bounds.z > 30, "unified surface no longer spans stream and pond");
  assert.equal(geometryAudit.bank.replacesAsphalt, true, "green shoreline no longer replaces the asphalt-looking bank");
  assert.equal(geometryAudit.bank.vertexColors, true, "green shoreline lost its moss/celadon color transition");
  assert.ok(geometryAudit.bank.triangles > 70, "green shoreline is unexpectedly sparse");
  assert.deepEqual(geometryAudit.rocks, {
    name: "tea_garden_stream_eddy_obstacle_rocks",
    count: 5,
    obstacles: 5
  });
  assert.deepEqual(geometryAudit.oldNames, [], `legacy static water/banks remain: ${geometryAudit.oldNames.join(", ")}`);
  assert.equal(geometryAudit.terrainClearance.all.belowTerrain, 0, "water base intersects the terrain");
  assert.equal(geometryAudit.terrainClearance.stream.belowTerrain, 0, "graded stream intersects the terrain");
  assert.ok(
    geometryAudit.terrainClearance.all.min >= 0.18,
    `water has only ${geometryAudit.terrainClearance.all.min}m terrain clearance`
  );
  assert.ok(
    geometryAudit.terrainClearance.defaultWorstDisplaced >= 0.03,
    `default simulated trough can clip terrain (${geometryAudit.terrainClearance.defaultWorstDisplaced}m)`
  );
  assert.equal(geometryAudit.debug.webgpu, true, "water debug state does not declare WebGPU");
  assert.equal(geometryAudit.debug.waterDrop, 0.8, "stream-to-pond grade changed");
  assert.ok(geometryAudit.debug.upstreamSurfaceY > geometryAudit.debug.pondSurfaceY, "water no longer descends into the pond");
  assert.equal(geometryAudit.debug.stats.backend, "WebGPU storage buffers");
  assert.equal(geometryAudit.debug.stats.gridWidth, 224);
  assert.equal(geometryAudit.debug.stats.gridHeight, 272);
  assert.ok(geometryAudit.debug.stats.activeCells > 8_000, "too few active shallow-water cells");
  assert.equal(geometryAudit.debug.stats.rocks, 5);
  assert.ok(
    geometryAudit.debug.stats.impulseCapacity >= 16 && geometryAudit.debug.stats.impulseCapacity <= 128,
    `unexpected bounded impulse capacity: ${geometryAudit.debug.stats.impulseCapacity}`
  );
  assert.ok(
    geometryAudit.debug.stats.cfl > 0 && geometryAudit.debug.stats.cfl < 1,
    `shallow-water CFL is outside the stable range: ${geometryAudit.debug.stats.cfl}`
  );
  assert.equal(typeof geometryAudit.interactions.playerInWater, "boolean", "wading state is not observable");
  assert.ok(geometryAudit.interactions.surfaceKoi > 0, "no koi are close enough to the simulated surface to make wakes");

  // Phase three of the loading contract: advancing the already-active field and
  // unlocking its shared procedural audio must not request more feature code or
  // media. The browser is muted, but the real AudioContext/node lifecycle runs.
  const actionStart = requests.length;
  const before = await page.evaluate(() => {
    const sf = window.__sf;
    const state = sf.japaneseTeaGarden.debugState();
    return {
      revision: state.water.stats.revision,
      ticks: state.water.stats.totalTicks,
      dispatches: state.water.stats.totalDispatches,
      impulses: state.water.stats.totalImpulses,
      interactions: state.waterInteractions,
      audio: state.streamAudio
    };
  });
  await page.evaluate(async () => {
    await window.__sf.nature.unlock();
  });
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => {
    const state = window.__sf.japaneseTeaGarden.debugState();
    return {
      revision: state.water.stats.revision,
      ticks: state.water.stats.totalTicks,
      dispatches: state.water.stats.totalDispatches,
      impulses: state.water.stats.totalImpulses,
      interactions: state.waterInteractions,
      running: state.water.stats.running,
      audio: state.streamAudio,
      nature: window.__sf.nature.debugState
    };
  });
  assert.ok(after.revision > before.revision, "water state revision did not advance");
  assert.ok(after.ticks > before.ticks, "fixed-step shallow-water field did not tick");
  assert.ok(after.dispatches > before.dispatches, "shallow-water compute passes did not dispatch");
  assert.ok(after.interactions.koi > before.interactions.koi, "near-surface koi did not inject any fluid wakes");
  assert.ok(after.impulses > before.impulses, "accepted koi wakes were not applied by the GPU impulse pass");
  assert.equal(after.audio.graph, true, "nearby stream audio did not build its lazy graph");
  assert.equal(after.audio.graphBuilds, 1, "stream audio stacked duplicate continuous graphs");
  assert.equal(after.audio.context, "running", "shared stream audio context did not unlock");
  assert.equal(after.nature.unlocked, true, "stream audio bypassed the nature unlock state");
  assert.ok(after.audio.distance < 1, "listener is not positioned at the bridge water anchor");
  assert.ok(after.audio.activeEddies <= 2, "procedural eddy voices exceeded their hard cap");

  // Exercise the real gameplay paths instead of calling the encapsulated water
  // queue. A short walk must leave alternating foot ripples; a deterministic
  // downward throw must cross the pond surface and produce a ball splash.
  await page.evaluate(({ x, z }) => {
    const sf = window.__sf;
    sf.player.teleportTo({
      x,
      y: sf.map.effectiveGround(x, z),
      z,
      facing: 0,
      mode: "walk"
    });
  }, POND_CENTER);
  await page.waitForFunction(
    () => window.__sf?.japaneseTeaGarden?.debugState?.().waterInteractions.playerInWater === true,
    undefined,
    { timeout: 30_000 }
  );
  const walkBefore = await page.evaluate(() =>
    window.__sf.japaneseTeaGarden.debugState().waterInteractions.player
  );
  await page.keyboard.down("w");
  await page.waitForTimeout(750);
  await page.keyboard.up("w");
  await page.waitForFunction(
    (count) => window.__sf.japaneseTeaGarden.debugState().waterInteractions.player > count,
    walkBefore,
    { timeout: 10_000 }
  );

  // Return to the middle of the pond so the authored throw cannot graze a bank,
  // then hold a close, fixed camera on the exact crossing for review evidence.
  await page.evaluate(({ x, z }) => {
    const sf = window.__sf;
    sf.player.teleportTo({
      x,
      y: sf.map.effectiveGround(x, z),
      z,
      facing: 0,
      mode: "walk"
    });
  }, POND_CENTER);
  await page.waitForFunction(
    () => window.__sf.japaneseTeaGarden.debugState().waterInteractions.playerInWater === true,
    undefined,
    { timeout: 30_000 }
  );
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const sf = window.__sf;
    const y = sf.japaneseTeaGarden.debugState().water.pondSurfaceY;
    const hand = sf.player.handWorldPos(new sf.THREE.Vector3());
    sf.player.setExternalEmbodimentHidden(true);
    window.__sfFreeCam(
      [hand.x + 2.25, y + 1.35, hand.z + 2.45],
      [hand.x, y - 0.015, hand.z]
    );
    sf.hud?.setHidden?.(true);
  });
  await page.waitForTimeout(250);
  const ballBeforeShot = await page.screenshot({ path: `${OUT}/ball-ripple-before.png`, fullPage: false });
  const ballBefore = await page.evaluate(() =>
    window.__sf.japaneseTeaGarden.debugState().waterInteractions.balls
  );
  const launched = await page.evaluate(() => {
    const sf = window.__sf;
    return sf.fetchBall.throwForCinematic(new sf.THREE.Vector3(0, -4, 0));
  });
  assert.equal(launched, true, "deterministic pond-crossing ball did not launch");
  const ballSamples = [];
  let ballImpactShot;
  let ballRippleShot;
  let impactSample = -1;
  let rippleSample = -1;
  for (let sample = 0; sample < 30; sample++) {
    await page.waitForTimeout(100);
    const snapshot = await page.evaluate(() => {
      const sf = window.__sf;
      const free = [];
      sf.fetchBall.visitFreeBalls((id, state, radius) => free.push({ id, ...state, radius }));
      const debug = sf.japaneseTeaGarden.debugState();
      return { free, interactions: debug.waterInteractions, totalImpulses: debug.water.stats.totalImpulses };
    });
    ballSamples.push(snapshot);
    if (impactSample < 0 && snapshot.interactions.balls > ballBefore) {
      impactSample = sample;
      ballImpactShot = await page.screenshot({ path: `${OUT}/ball-ripple-impact.png`, fullPage: false });
    } else if (impactSample >= 0 && sample === impactSample + 2) {
      rippleSample = sample;
      await page.evaluate(() => {
        const ball = window.__sf.scene.getObjectByName("player_tennis_ball");
        if (ball) ball.visible = false;
      });
      ballRippleShot = await page.screenshot({ path: `${OUT}/ball-ripple-decay.png`, fullPage: false });
      await page.evaluate(() => {
        const ball = window.__sf.scene.getObjectByName("player_tennis_ball");
        if (ball) ball.visible = true;
      });
    }
  }
  assert.ok(
    ballSamples.some((sample) => sample.interactions.balls > ballBefore),
    `the thrown ball emitted no surface-crossing ripple (${JSON.stringify(ballSamples)})`
  );
  assert.ok(ballImpactShot && ballRippleShot, "close-up ball-ripple evidence was not captured");
  const ballAnimation = await temporalPixelDelta(
    ballBeforeShot,
    ballRippleShot,
    { left: 180, top: 180, width: 1080, height: 650 },
    (rippleSample + 1) * 100
  );
  assert.ok(
    ballAnimation.meanChannelDelta > 0.0002 && ballAnimation.changedPixelRatio > 0.003,
    `forced pond interaction produced no visible temporal response (${JSON.stringify(ballAnimation)})`
  );
  assert.ok(
    ballAnimation.meanChannelDelta < 0.2 && ballAnimation.changedPixelRatio < 0.9,
    `forced pond interaction became visually unbounded (${JSON.stringify(ballAnimation)})`
  );
  await page.evaluate(() => window.__sf.player.setExternalEmbodimentHidden(false));
  const interactionAfter = await page.evaluate(() => {
    const state = window.__sf.japaneseTeaGarden.debugState();
    return {
      water: state.water.stats,
      interactions: state.waterInteractions
    };
  });
  assert.ok(interactionAfter.interactions.player > walkBefore, "walking in water emitted no foot ripples");
  assert.ok(interactionAfter.interactions.balls > ballBefore, "the thrown ball emitted no surface-crossing ripple");
  assert.ok(interactionAfter.interactions.koi > after.interactions.koi, "koi wakes stopped during gameplay interaction testing");
  assert.ok(interactionAfter.interactions.surfaceKoi > 0, "near-surface koi tracking went inactive");
  assert.ok(interactionAfter.interactions.trackedBalls >= 1, "the live free ball is not being sampled");
  assert.ok(interactionAfter.water.totalImpulses > after.impulses, "gameplay ripples never reached the GPU impulse pass");
  assert.ok(
    interactionAfter.water.queuedImpulses <= interactionAfter.water.impulseCapacity,
    "gameplay disturbances overflowed the bounded impulse queue"
  );
  const actionRequests = requests.slice(actionStart).filter(teaRequest);
  assert.deepEqual(actionRequests, [], `water/audio/gameplay fetched more Tea Garden resources: ${actionRequests.join(", ")}`);

  // These folders register only when the lazy garden exists and live inside the
  // shared slash diagnostics pane rather than an eager feature-specific UI.
  await page.evaluate(() => window.__sf.debugPanel.toggle());
  await page.waitForTimeout(300);
  const tuningAudit = await page.evaluate(() => {
    const text = document.body.textContent ?? "";
    return {
      waterFolder: text.includes("flowing water"),
      flow: text.includes("downstream flow"),
      interactionFolder: text.includes("interaction ripples"),
      interactionStrength: text.includes("interaction strength"),
      rippleRadius: text.includes("default ripple radius"),
      waveContrast: text.includes("simulated wave contrast"),
      foam: text.includes("foam / eddies"),
      normal: text.includes("field-gradient normal"),
      soundFolder: text.includes("stream sound"),
      soundVolume: text.includes("water volume")
    };
  });
  assert.deepEqual(tuningAudit, {
    waterFolder: true,
    flow: true,
    interactionFolder: true,
    interactionStrength: true,
    rippleRadius: true,
    waveContrast: true,
    foam: true,
    normal: true,
    soundFolder: true,
    soundVolume: true
  });
  await page.evaluate(() => window.__sf.debugPanel.toggle());

  await page.evaluate(({ bridge, pondEntry }) => {
    const sf = window.__sf;
    const eyeY = sf.map.groundTop(bridge.x, bridge.z) + 12.5;
    const targetY = sf.japaneseTeaGarden.debugState().water.pondSurfaceY + 0.2;
    window.__sfFreeCam(
      [bridge.x + 16.5, eyeY, bridge.z - 16],
      [(bridge.x + pondEntry.x) * 0.5, targetY, (bridge.z + pondEntry.z) * 0.5]
    );
    sf.hud?.setHidden?.(true);
  }, { bridge: BRIDGE, pondEntry: POND_ENTRY });
  await page.waitForTimeout(700);
  const bridgeShot = await page.screenshot({ path: `${OUT}/bridge-stream.png`, fullPage: false });
  const bridgeStats = await sharp(bridgeShot).stats();
  assert.ok(bridgeStats.entropy > 2, `bridge/stream screenshot appears blank (${bridgeStats.entropy})`);

  await page.evaluate(({ pondEntry }) => {
    const sf = window.__sf;
    const y = sf.japaneseTeaGarden.debugState().water.pondSurfaceY;
    window.__sfFreeCam(
      [pondEntry.x + 12.5, y + 8.5, pondEntry.z + 10.5],
      [pondEntry.x - 2.5, y + 0.1, pondEntry.z + 5]
    );
  }, { pondEntry: POND_ENTRY });
  await page.waitForTimeout(500);
  const pondShot = await page.screenshot({ path: `${OUT}/pond-entry.png`, fullPage: false });
  const pondStats = await sharp(pondShot).stats();
  assert.ok(pondStats.entropy > 2, `pond-entry screenshot appears blank (${pondStats.entropy})`);
  await page.waitForTimeout(550);
  const pondShotLater = await page.screenshot({ path: `${OUT}/pond-entry-later.png`, fullPage: false });
  const animation = await temporalPixelDelta(pondShot, pondShotLater, {
    left: 0,
    top: 440,
    width: 1080,
    height: 500
  });
  assert.ok(
    animation.meanChannelDelta > 0.0002 && animation.changedPixelRatio > 0.005,
    `water appears static (${JSON.stringify(animation)})`
  );
  assert.ok(
    animation.meanChannelDelta < 0.15 && animation.changedPixelRatio < 0.85,
    `water animation is unbounded/chaotic (${JSON.stringify(animation)})`
  );

  const gpuErrors = pageErrors.filter((message) =>
    /WebGPU|GPUValidation|WGSL|storage|compute|render pipeline|bind group|vertex buffer|TypeError/i.test(message)
  );
  assert.deepEqual(gpuErrors, [], `WebGPU errors: ${gpuErrors.join("\n")}`);
  assert.deepEqual(pageErrors, [], `browser errors: ${pageErrors.join("\n")}`);

  console.log(JSON.stringify({
    ok: true,
    backend: backendAtBoot,
    lazy: {
      bootRequests: bootRequests.length,
      activationRequests: activationRequests.length,
      actionRequests: actionRequests.length
    },
    geometry: geometryAudit,
    simulation: { before, after, interactionAfter },
    tuning: tuningAudit,
    screenshots: {
      bridge: { path: `${OUT}/bridge-stream.png`, entropy: bridgeStats.entropy },
      pondEntry: { path: `${OUT}/pond-entry.png`, entropy: pondStats.entropy },
      pondEntryLater: { path: `${OUT}/pond-entry-later.png` },
      ballRippleBefore: { path: `${OUT}/ball-ripple-before.png` },
      ballRippleImpact: { path: `${OUT}/ball-ripple-impact.png` },
      ballRippleDecay: { path: `${OUT}/ball-ripple-decay.png` }
    },
    animation: { ambient: animation, ball: ballAnimation },
    pageErrors
  }, null, 2));
} finally {
  await browser.close();
}
