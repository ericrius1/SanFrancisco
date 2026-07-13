// Headless WebGPU regression probe for the interactive dry landscape.
// Verifies the real lazy request boundary, terrain fit, grass clearance,
// physical keyboard pickup, bounded trail writing, and a nonblank hero view.
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

  const geometryAudit = await page.evaluate(({ center, radii }) => {
    const sf = window.__sf;
    const sand = sf.scene.getObjectByName("dry_garden_terrain_conforming_sand");
    const grass = sf.scene.getObjectByName("tea_garden_moss_grass");
    const rim = sf.scene.getObjectByName("dry_landscape_hand_set_stone_rim");
    const rake = sf.scene.getObjectByName("dry_landscape_little_rake");
    const position = sand.geometry.getAttribute("position");
    let maxTerrainError = 0;
    for (let i = 0; i < position.count; i += 17) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
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
      rakeParent: rake.parent?.name ?? null
    };
  }, { center: CENTER, radii: RADII });
  assert.ok(geometryAudit.sandVertices > 1000, "sand surface is not sufficiently tessellated for terrain fit");
  assert.ok(geometryAudit.maxTerrainError < 0.002, `sand floats away from terrain by ${geometryAudit.maxTerrainError}`);
  assert.equal(geometryAudit.grassViolations, 0, "authored grass clips inside the dry-garden clearance mask");
  assert.equal(geometryAudit.rimInstances, 96, "stone rim lost its fixed instanced count");
  assert.equal(geometryAudit.rakeParent, "dry_landscape_rake_rack", "rake did not begin on its stand");

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
  assert.equal(pickupAudit.rakeParent, "hand-R", "picked-up rake is not attached to the avatar's hand");

  // Feed a smooth S-curve through the same public update path used by the live
  // loop. This is deterministic and exercises five-groove interpolation rather
  // than relying on real-time keyboard timing in a throttled headless tab.
  await page.evaluate(async ({ center }) => {
    const sf = window.__sf;
    for (let i = 0; i <= 90; i++) {
      const t = i / 90;
      const x = center.x - 8.3 + t * 16.2;
      const z = center.z + Math.sin(t * Math.PI * 2) * 2.25;
      const y = sf.map.groundTop(x, z) + 1.5;
      sf.japaneseTeaGarden.update(1 / 30, i / 30, { x, y, z }, sf.camera, "walk");
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { center: CENTER });

  const trailAudit = await page.evaluate(() => {
    const dry = window.__sf.japaneseTeaGarden.debugState().dryLandscape;
    const trails = window.__sf.scene.getObjectByName("dry_garden_player_rake_trails");
    return { ...dry, meshCount: trails.count, capacity: trails.instanceMatrix.count };
  });
  assert.ok(trailAudit.trailSegments >= 300, `raking wrote too few groove segments: ${trailAudit.trailSegments}`);
  assert.equal(trailAudit.meshCount, trailAudit.trailSegments, "trail draw count diverged from debug state");
  assert.equal(trailAudit.capacity, 2400, "trail buffer is not bounded to 2400 instances");
  assert.ok(trailAudit.trailSegments <= trailAudit.capacity, "trail writes exceeded fixed GPU capacity");

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

  const gpuErrors = pageErrors.filter((message) => /WebGPU|GPUValidation|render pipeline|vertex buffer/i.test(message));
  assert.deepEqual(gpuErrors, [], `WebGPU errors: ${gpuErrors.join("\n")}`);

  console.log(JSON.stringify({
    ok: true,
    lazy: { bootRequests: bootRequests.length, activationRequests: activationRequests.length },
    geometry: geometryAudit,
    pickup: pickupAudit,
    trails: trailAudit,
    screenshotEntropy: screenshotStats.entropy,
    pageErrors: pageErrors.length
  }, null, 2));
} finally {
  await browser.close();
}
