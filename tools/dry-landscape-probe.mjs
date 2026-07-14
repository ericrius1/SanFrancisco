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
    const y = sf.map.effectiveGround(x, z) + 0.9;
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
    const grassTransform = grass.geometry.getAttribute("aGrassTransform");
    const grassCount = grass.geometry.instanceCount;
    let grassViolations = 0;
    for (let i = 0; i < grassCount; i++) {
      const x = grassTransform.getX(i);
      const z = grassTransform.getZ(i);
      const nx = (x - center.x) / (radii.x + 1.2);
      const nz = (z - center.z) / (radii.z + 1.2);
      if (nx * nx + nz * nz <= 1) grassViolations++;
    }
    return {
      sandVertices: position.count,
      maxTerrainError,
      grassCount,
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
  assert.ok(geometryAudit.sandVertices > 80_000, "GPU sand surface lost its 2× display reconstruction");
  assert.ok(geometryAudit.indexCount > 250_000, "ellipse-clipped display surface lost most triangles");
  assert.ok(geometryAudit.maxTerrainError < 0.002, `sand floats away from terrain by ${geometryAudit.maxTerrainError}`);
  assert.equal(geometryAudit.grassViolations, 0, "authored grass clips inside the dry-garden clearance mask");
  assert.equal(geometryAudit.rimInstances, 96, "stone rim lost its fixed instanced count");
  assert.equal(geometryAudit.rakeParent, "dry_landscape_rake_rack", "rake did not begin on its stand");
  assert.equal(geometryAudit.oldFakeMeshes, 0, "legacy box-line trails are still in the scene");
  assert.equal(geometryAudit.simulation.gridWidth, 192, "unexpected sand grid width");
  assert.equal(geometryAudit.simulation.gridHeight, 112, "unexpected sand grid height");
  assert.equal(geometryAudit.simulation.displayGrid, "383×223", "unexpected display reconstruction grid");
  assert.equal(geometryAudit.simulation.displayVertices, 85_409, "unexpected display vertex count");
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
    await page.evaluate(() => window.__sf.tick(1 / 30));
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
  await page.evaluate(({ center }) => {
    const sf = window.__sf;
    const z = center.z + 2.8;
    sf.player.teleportTo({
      x: center.x,
      y: sf.map.effectiveGround(center.x, z) + 1.5,
      z,
      facing: 0,
      mode: "walk"
    });
  }, { center: CENTER });
  await page.waitForTimeout(700);
  const realInputBefore = await page.evaluate(() => ({
    x: window.__sf.player.renderPosition.x,
    z: window.__sf.player.renderPosition.z,
    dispatches: window.__sf.japaneseTeaGarden.debugState().dryLandscape.simulation.totalDispatches
  }));
  await page.keyboard.down("w");
  await page.waitForFunction(() => window.__sf.japaneseTeaGarden.debugState().dryLandscape.raking, undefined, { timeout: 5000 });
  await page.waitForTimeout(650);
  await page.keyboard.up("w");
  const realInputAfter = await page.evaluate(() => ({
    x: window.__sf.player.renderPosition.x,
    z: window.__sf.player.renderPosition.z,
    dispatches: window.__sf.japaneseTeaGarden.debugState().dryLandscape.simulation.totalDispatches
  }));
  assert.ok(
    Math.hypot(realInputAfter.x - realInputBefore.x, realInputAfter.z - realInputBefore.z) > 0.15,
    "real W input did not move the held-rake player"
  );
  assert.ok(realInputAfter.dispatches > realInputBefore.dispatches, "real W input did not rake the GPU sand");

  // Feed a smooth S-curve through the same Player + public garden update paths
  // as the live loop. A second sync applies the exact contact packet this frame
  // so the pose audit is deterministic in a throttled headless tab.
  await page.evaluate(async ({ center }) => {
    const sf = window.__sf;
    let finalFacing = 0;
    for (let i = 0; i <= 72; i++) {
      const t = i / 72;
      const x = center.x - 8.1 + t * 15.7;
      const z = center.z + Math.sin(t * Math.PI * 2) * 2.15;
      const y = sf.map.groundTop(x, z) + 1.5;
      const tangentX = 15.7;
      const tangentZ = Math.cos(t * Math.PI * 2) * 2.15 * Math.PI * 2;
      // Raw yaw whose local -Z axis follows the analytic S-curve tangent.
      const facing = Math.atan2(-tangentX, -tangentZ);
      finalFacing = facing;
      sf.player.teleportTo({ x, y, z, facing, mode: "walk" });
      sf.player.syncMesh(1 / 30);
      sf.japaneseTeaGarden.update(1 / 30, i / 30, sf.player.renderPosition, sf.camera, "walk");
      sf.player.syncMesh(1 / 30);
    }
    // teleportTo intentionally arrives 2 m above its destination. Pin the last
    // sample to standing hip height, then run real fixed steps so the walk
    // controller reports grounded before its rake overlay is audited.
    const x = center.x + 7.6;
    const z = center.z;
    const y = sf.map.effectiveGround(x, z) + 0.9;
    sf.physics.world.setBodyTransform(
      sf.player.body,
      [x, y, z],
      [0, Math.sin(finalFacing * 0.5), 0, Math.cos(finalFacing * 0.5)]
    );
    sf.physics.world.setBodyVelocity(sf.player.body, [0, 0, 0], [0, 0, 0]);
    sf.player.snapRenderPose();
    for (let i = 0; i < 30; i++) sf.tick(1 / 60);
    sf.player.syncMesh(1 / 60);
    sf.japaneseTeaGarden.update(1 / 60, 0, sf.player.renderPosition, sf.camera, "walk");
    sf.player.syncMesh(1 / 60);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { center: CENTER });

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
    const playerWorld = world(playerRoot);
    const avatarForward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(playerRoot.getWorldQuaternion(new THREE.Quaternion()))
      .setY(0)
      .normalize();
    const forwardOfPlayer = (point) => point.clone().sub(playerWorld).setY(0).dot(avatarForward);
    const rakeTopWorld = world(rake);
    const rightGripWorld = world(rightGrip);
    const leftGripWorld = world(leftGrip);
    return {
      dry,
      rakeParent: playerRoot?.name ?? null,
      contactError: contactWorld.distanceTo(expected),
      groundError: Math.abs(contactWorld.y - (sf.map.groundTop(contactWorld.x, contactWorld.z) + 0.126)),
      rightGripError: rightGripWorld.distanceTo(pocket(handR)),
      leftGripError: leftGripWorld.distanceTo(pocket(handL)),
      forwardClearance: {
        contact: forwardOfPlayer(contactWorld),
        rakeTop: forwardOfPlayer(rakeTopWorld),
        rightGrip: forwardOfPlayer(rightGripWorld),
        leftGrip: forwardOfPlayer(leftGripWorld),
        pullDotForward: dry.pull.x * avatarForward.x + dry.pull.z * avatarForward.z
      },
      points: {
        player: playerWorld.toArray(),
        contact: contactWorld.toArray(),
        rakeTop: rakeTopWorld.toArray(),
        rightGrip: rightGripWorld.toArray(),
        leftGrip: leftGripWorld.toArray(),
        rightHand: world(handR).toArray(),
        leftHand: world(handL).toArray()
      },
      renderer: {
        backend: sf.renderer.backend?.constructor?.name ?? null,
        webgpu: sf.renderer.backend?.isWebGPUBackend === true,
        calls: sf.renderer.info.render.calls,
        triangles: sf.renderer.info.render.triangles,
        geometries: sf.renderer.info.memory.geometries,
        textures: sf.renderer.info.memory.textures
      }
    };
  });
  console.log("[dry-landscape] simulation", JSON.stringify(simulationAudit));
  assert.equal(simulationAudit.renderer.webgpu, true, "garden did not run on the required WebGPU backend");
  assert.ok(simulationAudit.dry.simulation.totalDispatches > 40, "raking did not execute the granular GPU pipeline");
  assert.ok(simulationAudit.dry.simulation.revision > 10, "sand state did not advance while raking");
  assert.ok(simulationAudit.dry.simulation.queuedStamps <= 18, "bounded stamp queue overflowed");

  const actionRequests = requests.slice(actionStart).filter(teaRequest);
  assert.deepEqual(actionRequests, [], `raking fetched more Tea Garden code/assets: ${actionRequests.join(", ")}`);

  // Controls register only after the lazy activity exists, and remain part of
  // the shared slash diagnostics surface rather than an always-on activity UI.
  await page.evaluate(() => window.__sf.debugPanel.toggle());
  await page.waitForTimeout(250);
  const tuningAudit = await page.evaluate(() => ({
    hasRepose: document.body.textContent.includes("angle of repose"),
    hasRakeDepth: document.body.textContent.includes("rake depth"),
    hasSurfaceSmoothing: document.body.textContent.includes("surface smoothing"),
    hasRakeMarkContrast: document.body.textContent.includes("rake mark contrast"),
    hasReset: document.body.textContent.includes("reset authored rake pattern")
  }));
  assert.deepEqual(tuningAudit, {
    hasRepose: true,
    hasRakeDepth: true,
    hasSurfaceSmoothing: true,
    hasRakeMarkContrast: true,
    hasReset: true
  });
  await page.evaluate(() => window.__sf.debugPanel.toggle());

  await page.evaluate(({ center }) => {
    const sf = window.__sf;
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
  await page.evaluate(({ player, contact, pull }) => {
    const sf = window.__sf;
    const targetX = (player[0] + contact[0]) * 0.5;
    const targetZ = (player[2] + contact[2]) * 0.5;
    const travelX = -pull.x;
    const travelZ = -pull.z;
    const sideX = pull.z;
    const sideZ = -pull.x;
    // Stay inside the dry garden and look across the avatar's working side;
    // the old exterior camera was regularly hidden by the perimeter pine.
    const eyeX = targetX - travelX * 2.6 - sideX * 2;
    const eyeZ = targetZ - travelZ * 2.6 - sideZ * 2;
    const eyeY = sf.map.groundTop(eyeX, eyeZ) + 2.25;
    const targetY = sf.map.groundTop(targetX, targetZ) + 0.92;
    window.__sfFreeCam([eyeX, eyeY, eyeZ], [targetX, targetY, targetZ]);
  }, {
    player: simulationAudit.points.player,
    contact: simulationAudit.points.contact,
    pull: simulationAudit.dry.pull
  });
  await page.waitForTimeout(250);
  const closeScreenshot = await page.screenshot({ path: `${OUT}/raked-garden-close.png`, fullPage: false });
  const closeStats = await sharp(closeScreenshot).stats();
  assert.ok(closeStats.entropy > 2, `close dry-garden screenshot appears blank (${closeStats.entropy})`);

  const gpuErrors = pageErrors.filter((message) => /WebGPU|GPUValidation|WGSL|storage|compute|render pipeline|bind group|vertex buffer|TypeError/i.test(message));
  assert.deepEqual(gpuErrors, [], `WebGPU errors: ${gpuErrors.join("\n")}`);
  assert.ok(simulationAudit.contactError < 0.015, `visible tine contact diverged from GPU brush by ${simulationAudit.contactError}m`);
  assert.ok(simulationAudit.groundError < 0.015, `tines are not grounded (${simulationAudit.groundError}m error)`);
  assert.ok(simulationAudit.rightGripError < 0.025, `right hand missed rake grip by ${simulationAudit.rightGripError}m`);
  assert.ok(simulationAudit.leftGripError < 0.025, `left hand missed rake grip by ${simulationAudit.leftGripError}m`);
  assert.ok(simulationAudit.forwardClearance.contact > 1.34, "rake head is not being pushed ahead of the avatar");
  assert.ok(simulationAudit.forwardClearance.rakeTop > 0.24, "rake handle top crosses behind the avatar");
  assert.ok(simulationAudit.forwardClearance.rightGrip > 0.44, "dominant rake grip is not in front of the torso");
  assert.ok(simulationAudit.forwardClearance.leftGrip > 0.32, "upper rake grip is not in front of the torso");
  assert.ok(simulationAudit.forwardClearance.pullDotForward < -0.9, "head-to-player rake axis no longer opposes travel");

  console.log(JSON.stringify({
    ok: true,
    lazy: { bootRequests: bootRequests.length, activationRequests: activationRequests.length },
    geometry: geometryAudit,
    pickup: pickupAudit,
    simulation: simulationAudit,
    realInput: { before: realInputBefore, after: realInputAfter },
    tuning: tuningAudit,
    screenshotEntropy: screenshotStats.entropy,
    closeScreenshotEntropy: closeStats.entropy,
    pageErrors
  }, null, 2));
} finally {
  await browser.close();
}
