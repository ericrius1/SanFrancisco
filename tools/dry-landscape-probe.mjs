// Headless WebGPU regression probe for the interactive dry landscape.
// Verifies the real lazy request boundary, terrain fit, grass clearance,
// physical keyboard pickup, conservative GPU dispatches, grounded two-hand
// contact, late Tweakpane registration, and a nonblank active-raking view.
//
// Run against an existing Vite server:
//   SF_PROBE_URL=http://127.0.0.1:5262 node tools/dry-landscape-probe.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import sharp from "sharp";

const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5262";
const OUT = ".data/dry-landscape-probe";
const CENTER = { x: -2344, z: 2166.5 };
const RADII = { x: 10.8, z: 6.4 };
const RACK = { x: -2354.45, z: 2169.15 };

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

  await page.goto(`${SERVER_URL}/?autostart=1&fullfps=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(() => window.__sf?.player && window.__sf?.map, undefined, { timeout: 150_000 });
  await page.waitForTimeout(1200);

  // layout.ts is boot-fundamental: main uses its entrance and baked-building
  // suppression identities. The render/activity modules remain proximity-only.
  const teaRequest = (url) =>
    url.includes("/src/world/japaneseTeaGarden/") && !url.endsWith("/japaneseTeaGarden/layout.ts");
  const bootRequests = requests.filter(teaRequest);
  assert.deepEqual(bootRequests, [], `clean boot eagerly requested the Tea Garden: ${bootRequests.join(", ")}`);

  const activationStart = requests.length;
  await page.evaluate(({ x, z }) => {
    const sf = window.__sf;
    const y = sf.map.effectiveGround(x, z) + 1.5;
    sf.player.teleportTo({ x, y, z, facing: Math.PI * 0.5, mode: "walk" });
  }, RACK);
  await page.waitForFunction(
    () => window.__sf?.japaneseTeaGarden?.debugState?.().awake,
    undefined,
    { timeout: 150_000 }
  );
  await page.waitForFunction(
    () => window.__sf.scene.getObjectByName("japanese_tea_garden_dry_landscape"),
    undefined,
    // The deferred path exposes the site object before its first WebGPU
    // compileAsync finishes and the group is added to the scene.
    { timeout: 150_000 }
  );
  await page.waitForFunction(() => window.__sf.renderIdle?.(), undefined, { timeout: 150_000 });

  const activationRequests = requests.slice(activationStart).filter(teaRequest);
  assert.ok(activationRequests.some((url) => url.includes("/japaneseTeaGarden/index.ts")), "first approach did not request the Tea Garden chunk");
  assert.ok(activationRequests.some((url) => url.includes("/japaneseTeaGarden/dryLandscape.ts")), "first approach did not request the dry-landscape module");
  assert.ok(activationRequests.some((url) => url.includes("/japaneseTeaGarden/sandSimulation.ts")), "first approach did not request the GPU sand module");

  const geometryAudit = await page.evaluate(({ center, radii }) => {
    const sf = window.__sf;
    const sand = sf.scene.getObjectByName("dry_landscape_gpu_granular_sand");
    const grass = sf.scene.getObjectByName("tea_garden_moss_grass");
    const rim = sf.scene.getObjectByName("dry_landscape_hand_set_stone_rim");
    const rake = sf.scene.getObjectByName("dry_landscape_little_rake");
    const position = sand.geometry.getAttribute("position");
    let maxTerrainError = 0;
    for (let i = 0; i < position.count; i += 17) {
      const x = position.getX(i) + sand.position.x;
      const y = position.getY(i);
      const z = position.getZ(i) + sand.position.z;
      maxTerrainError = Math.max(maxTerrainError, Math.abs(y - (sf.map.groundTop(x, z) + 0.12)));
    }
    const matrix = grass.instanceMatrix.array;
    let grassViolations = 0;
    for (let i = 0; i < grass.count; i++) {
      const x = matrix[i * 16 + 12];
      const z = matrix[i * 16 + 14];
      const nx = (x - center.x) / (radii.x + 1.2);
      const nz = (z - center.z) / (radii.z + 1.2);
      if (nx * nx + nz * nz <= 1) grassViolations++;
    }
    return {
      sandVertices: position.count,
      maxTerrainError,
      grassCount: grass.count,
      grassViolations,
      rimInstances: rim.count,
      rakeParent: rake.parent?.name ?? null,
      indexCount: sand.geometry.index?.count ?? 0,
      simulation: { ...sand.userData.sandSimulation },
      oldFakeMeshes: [
        sf.scene.getObjectByName("dry_garden_player_rake_trails"),
        sf.scene.getObjectByName("dry_garden_quiet_current_grooves")
      ].filter(Boolean).length
    };
  }, { center: CENTER, radii: RADII });
  assert.ok(geometryAudit.sandVertices > 20_000, "GPU sand surface lost its dense heightfield");
  assert.ok(geometryAudit.indexCount > 50_000, "ellipse-clipped sand surface lost most triangles");
  assert.ok(geometryAudit.maxTerrainError < 0.002, `sand floats away from terrain by ${geometryAudit.maxTerrainError}`);
  assert.equal(geometryAudit.grassViolations, 0, "authored grass clips inside the dry-garden clearance mask");
  assert.equal(geometryAudit.rimInstances, 96, "stone rim lost its fixed instanced count");
  assert.equal(geometryAudit.rakeParent, "dry_landscape_rake_rack", "rake did not begin on its stand");
  assert.equal(geometryAudit.oldFakeMeshes, 0, "legacy box-line trails are still in the scene");
  assert.equal(geometryAudit.simulation.gridWidth, 192, "unexpected sand grid width");
  assert.equal(geometryAudit.simulation.gridHeight, 112, "unexpected sand grid height");
  assert.ok(geometryAudit.simulation.activeCells > 13_000, "too few active granular cells");

  const prePickup = await page.evaluate(({ rack }) => {
    const sf = window.__sf;
    const p = sf.player.renderPosition;
    return {
      mode: sf.player.mode,
      suspended: sf.input.suspended,
      renderIdle: sf.renderIdle?.() ?? null,
      player: [p.x, p.y, p.z],
      rackDistance: Math.hypot(p.x - rack.x, p.z - rack.z),
      dry: sf.japaneseTeaGarden.debugState().dryLandscape
    };
  }, { rack: RACK });
  console.log("[dry-landscape] pre-pickup", JSON.stringify(prePickup));
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press("e");
    await page.waitForTimeout(650);
    if (await page.evaluate(() => window.__sf.japaneseTeaGarden.debugState().dryLandscape.held)) break;
  }
  await page.waitForFunction(() => window.__sf.japaneseTeaGarden.debugState().dryLandscape.held, undefined, { timeout: 5000 });
  const pickupAudit = await page.evaluate(() => {
    const dry = window.__sf.japaneseTeaGarden.debugState().dryLandscape;
    const rake = window.__sf.scene.getObjectByName("dry_landscape_little_rake");
    return { dry, rakeParent: rake?.parent?.name ?? null };
  });
  assert.equal(pickupAudit.dry.held, true, "keyboard E did not pick up the rake");
  assert.notEqual(pickupAudit.rakeParent, "hand-R", "contact-constrained rake regressed to a floating hand attachment");

  // Phase three of the lazy-loading contract: the activity is already loaded;
  // one real rake action must dispatch compute without fetching another asset.
  const actionStart = requests.length;
  // Feed a smooth S-curve through the same Player + public garden update paths
  // as the live loop. A second sync applies the exact contact packet this frame
  // so the pose audit is deterministic in a throttled headless tab.
  await page.evaluate(async ({ center }) => {
    const sf = window.__sf;
    for (let i = 0; i <= 72; i++) {
      const t = i / 72;
      const x = center.x - 8.1 + t * 15.7;
      const z = center.z + Math.sin(t * Math.PI * 2) * 2.15;
      const y = sf.map.groundTop(x, z) + 1.5;
      sf.player.teleportTo({ x, y, z, facing: Math.PI * 0.5, mode: "walk" });
      sf.player.syncMesh(1 / 30);
      sf.japaneseTeaGarden.update(1 / 30, i / 30, sf.player.renderPosition, sf.camera, "walk");
      sf.player.syncMesh(1 / 30);
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { center: CENTER });
  // Repeated deterministic teleports momentarily clear WalkController.grounded;
  // let the real fixed-step loop settle the capsule before judging the pose.
  await page.waitForTimeout(900);

  const simulationAudit = await page.evaluate(() => {
    const sf = window.__sf;
    const dry = window.__sf.japaneseTeaGarden.debugState().dryLandscape;
    const rake = sf.scene.getObjectByName("dry_landscape_little_rake");
    const contact = rake.getObjectByName("garden_rake_tine_contact");
    const rightGrip = rake.getObjectByName("garden_rake_grip_right");
    const leftGrip = rake.getObjectByName("garden_rake_grip_left");
    const playerRoot = rake.parent;
    const handR = playerRoot.getObjectByName("hand-R");
    const handL = playerRoot.getObjectByName("hand-L");
    const THREE = sf.THREE;
    const world = (object) => object.getWorldPosition(new THREE.Vector3());
    const pocket = (hand) => {
      const result = new THREE.Vector3(0, -0.05, -0.038).multiplyScalar(hand.scale.x);
      result.applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()));
      return result.add(world(hand));
    };
    const contactWorld = world(contact);
    const expected = new THREE.Vector3(dry.contact.x, dry.contact.y, dry.contact.z);
    return {
      dry,
      rakeParent: playerRoot?.name ?? null,
      contactError: contactWorld.distanceTo(expected),
      groundError: Math.abs(contactWorld.y - (sf.map.groundTop(contactWorld.x, contactWorld.z) + 0.126)),
      rightGripError: world(rightGrip).distanceTo(pocket(handR)),
      leftGripError: world(leftGrip).distanceTo(pocket(handL)),
      renderer: {
        calls: sf.renderer.info.render.calls,
        triangles: sf.renderer.info.render.triangles,
        geometries: sf.renderer.info.memory.geometries,
        textures: sf.renderer.info.memory.textures
      }
    };
  });
  console.log("[dry-landscape] simulation", JSON.stringify(simulationAudit));
  assert.ok(simulationAudit.dry.simulation.totalDispatches > 40, "raking did not execute the granular GPU pipeline");
  assert.ok(simulationAudit.dry.simulation.revision > 10, "sand state did not advance while raking");
  assert.ok(simulationAudit.dry.simulation.queuedStamps <= 18, "bounded stamp queue overflowed");
  assert.ok(simulationAudit.contactError < 0.015, `visible tine contact diverged from GPU brush by ${simulationAudit.contactError}m`);
  assert.ok(simulationAudit.groundError < 0.015, `tines are not grounded (${simulationAudit.groundError}m error)`);
  assert.ok(simulationAudit.rightGripError < 0.025, `right hand missed rake grip by ${simulationAudit.rightGripError}m`);
  assert.ok(simulationAudit.leftGripError < 0.025, `left hand missed rake grip by ${simulationAudit.leftGripError}m`);

  const actionRequests = requests.slice(actionStart).filter(teaRequest);
  assert.deepEqual(actionRequests, [], `raking fetched more Tea Garden code/assets: ${actionRequests.join(", ")}`);

  // Controls register only after the lazy activity exists, and remain part of
  // the shared slash diagnostics surface rather than an always-on activity UI.
  await page.evaluate(() => window.__sf.debugPanel.toggle());
  await page.waitForTimeout(250);
  const tuningAudit = await page.evaluate(() => ({
    hasRepose: document.body.textContent.includes("angle of repose"),
    hasRakeDepth: document.body.textContent.includes("rake depth"),
    hasReset: document.body.textContent.includes("reset authored rake pattern")
  }));
  assert.deepEqual(tuningAudit, { hasRepose: true, hasRakeDepth: true, hasReset: true });
  await page.evaluate(() => window.__sf.debugPanel.toggle());

  await page.evaluate(({ center }) => {
    const sf = window.__sf;
    const playerZ = center.z + 4.4;
    sf.player.teleportTo({
      x: center.x,
      y: sf.map.effectiveGround(center.x, playerZ) + 1.5,
      z: playerZ,
      facing: 0,
      mode: "walk"
    });
    const eyeX = center.x - 1;
    const eyeZ = center.z + 16.5;
    const eyeY = sf.map.groundTop(eyeX, eyeZ) + 12.5;
    const targetY = sf.map.groundTop(center.x, center.z) + 0.8;
    window.__sfFreeCam([eyeX, eyeY, eyeZ], [center.x, targetY, center.z]);
    sf.hud?.setHidden?.(true);
  }, { center: CENTER });
  await page.waitForTimeout(500);
  const screenshot = await page.screenshot({ path: `${OUT}/raked-garden.png`, fullPage: false });
  const screenshotStats = await sharp(screenshot).stats();
  assert.ok(screenshotStats.entropy > 2, `dry-garden screenshot appears blank (${screenshotStats.entropy})`);

  const gpuErrors = pageErrors.filter((message) => /WebGPU|GPUValidation|WGSL|storage|compute|render pipeline|bind group|vertex buffer|TypeError/i.test(message));
  assert.deepEqual(gpuErrors, [], `WebGPU errors: ${gpuErrors.join("\n")}`);

  console.log(JSON.stringify({
    ok: true,
    lazy: { bootRequests: bootRequests.length, activationRequests: activationRequests.length },
    geometry: geometryAudit,
    pickup: pickupAudit,
    simulation: simulationAudit,
    tuning: tuningAudit,
    screenshotEntropy: screenshotStats.entropy,
    pageErrors: pageErrors.length
  }, null, 2));
} finally {
  await browser.close();
}
