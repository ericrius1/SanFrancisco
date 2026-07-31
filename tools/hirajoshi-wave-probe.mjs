// Headless WebGPU/lazy-loading probe for the Hirajoshi Wave at the Wave Organ.
//
//   SF_PROBE_URL=http://127.0.0.1:5260 node tools/hirajoshi-wave-probe.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import sharp from "sharp";

const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5260";
const OUT = ".data/hirajoshi-wave-probe";
const CENTER = { x: 275, z: -2004 };
const ASSET_ROOT = "/art/hirajoshi-wave/";

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
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
    "--hide-scrollbars",
    "--mute-audio"
  ]
});

try {
  mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const requests = [];
  const pageErrors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  await page.goto(`${SERVER_URL}/?autostart=1&fullfps=1&profile=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(
    () => window.__sf?.player && window.__sf?.map && window.__sf?.renderIdle,
    undefined,
    { timeout: 150_000 }
  );
  await page.waitForFunction(() => window.__sf.renderIdle(), undefined, { timeout: 150_000 });

  const isAsset = (url) => new URL(url).pathname.includes(ASSET_ROOT);
  const bootAssets = requests.filter(isAsset);
  assert.deepEqual(bootAssets, [], `clean boot eagerly requested Hirajoshi media: ${bootAssets.join(", ")}`);

  const activationStart = requests.length;
  await page.evaluate(() => window.__sf.ensureOptionalWorldSite("wave-organ"));
  await page.waitForFunction(
    () => window.__sf?.waveOrgan?.hirajoshiDebugState?.().loadedTextures === 5,
    undefined,
    { timeout: 150_000 }
  );
  await page.evaluate(async ({ x, z }) => {
    const sf = window.__sf;
    const y = sf.map.groundTop(x, z) + 1.5;
    sf.player.teleportTo({ x: x - 11, y, z: z - 9, facing: -2.1, mode: "walk" });
    await sf.nature.unlock();
  }, CENTER);
  await page.waitForTimeout(800);

  const activationAssets = requests.slice(activationStart).filter(isAsset);
  const assetNames = [...new Set(activationAssets.map((url) => new URL(url).pathname.split("/").at(-1)))];
  assert.deepEqual(
    assetNames.sort(),
    [
      "pedestal-mosaic_albedo.png",
      "pedestal-mosaic_ao.png",
      "pedestal-mosaic_height.png",
      "pedestal-mosaic_normal.png",
      "pedestal-mosaic_roughness.png"
    ],
    `activation requested an unexpected Hirajoshi asset set: ${assetNames.join(", ")}`
  );

  const audit = await page.evaluate(() => {
    const sf = window.__sf;
    const wave = sf.waveOrgan;
    const object = (name) => sf.scene.getObjectByName(name);
    const mosaic = object("hirajoshiWave.dais.mosaic");
    wave.setHirajoshiTime(0);
    const aligned0 = wave.hirajoshiDebugState();
    wave.setHirajoshiTime(11.25);
    const dispersed = wave.hirajoshiDebugState();
    wave.setHirajoshiTime(48);
    const aligned48 = wave.hirajoshiDebugState();
    return {
      aligned0,
      dispersed,
      aligned48,
      objects: {
        root: Boolean(object("hirajoshiWave")),
        dais: Boolean(object("hirajoshiWave.dais")),
        portal: Boolean(object("hirajoshiWave.portal")),
        heart: Boolean(object("hirajoshiWave.heart")),
        rods: object("hirajoshiWave.rods")?.count ?? 0,
        orbs: object("hirajoshiWave.orbs")?.count ?? 0,
        trails: object("hirajoshiWave.phaseTrails")?.count ?? 0
      },
      material: {
        map: Boolean(mosaic?.material?.map),
        roughnessMap: Boolean(mosaic?.material?.roughnessMap),
        bumpMap: Boolean(mosaic?.material?.bumpMap),
        normalMap: Boolean(mosaic?.material?.normalMap),
        aoMap: Boolean(mosaic?.material?.aoMap)
      },
      renderer: {
        webgpu: sf.renderer.backend?.isWebGPUBackend === true,
        calls: sf.renderer.info.render.calls,
        triangles: sf.renderer.info.render.triangles,
        textures: sf.renderer.info.memory.textures
      }
    };
  });

  assert.equal(audit.renderer.webgpu, true, "Hirajoshi Wave did not render on WebGPU");
  assert.deepEqual(audit.aligned0.cycleCounts, Array.from({ length: 12 }, (_, i) => 18 + i));
  assert.equal(audit.aligned0.wandCount, 12);
  assert.equal(audit.aligned0.trailInstances, 216);
  assert.ok(audit.aligned0.alignmentError < 1e-6, `initial alignment error ${audit.aligned0.alignmentError}`);
  assert.ok(audit.dispersed.alignmentError > 2, `dispersed phase stayed aligned (${audit.dispersed.alignmentError})`);
  assert.ok(audit.aligned48.alignmentError < 1e-5, `48-second realignment error ${audit.aligned48.alignmentError}`);
  assert.deepEqual(audit.objects, {
    root: true,
    dais: true,
    portal: true,
    heart: true,
    rods: 12,
    orbs: 12,
    trails: 216
  });
  assert.deepEqual(audit.material, {
    map: true,
    roughnessMap: true,
    bumpMap: true,
    normalMap: true,
    aoMap: true
  });

  await page.evaluate(() => {
    window.__sfManual(true);
    window.__sf.waveOrgan.setHirajoshiTime(11.25);
    const sf = window.__sf;
    const centerY = sf.waveOrgan.hirajoshiDebugState().center.y;
    sf.sky.cycleEnabled = false;
    sf.sky.setTimeOfDay(18.5);
    sf.camera.fov = 54;
    sf.camera.updateProjectionMatrix();
    window.__sfFreeCam(
      [257, sf.map.groundTop(257, -2018) + 11.2, -2018],
      [275, centerY + 5.3, -2004]
    );
    sf.hud?.setHidden?.(true);
    sf.tick(1 / 60);
  });
  const heroAudit = await page.evaluate(() => {
    const sf = window.__sf;
    const root = sf.scene.getObjectByName("hirajoshiWave");
    const box = new sf.THREE.Box3().setFromObject(root);
    const center = box.getCenter(new sf.THREE.Vector3());
    const heart = sf.scene.getObjectByName("hirajoshiWave.heart")
      .getWorldPosition(new sf.THREE.Vector3());
    const projected = heart.clone().project(sf.camera);
    const visibility = [];
    for (let node = root; node; node = node.parent) {
      visibility.push({ name: node.name, visible: node.visible });
    }
    return {
      center: center.toArray(),
      heart: heart.toArray(),
      projected: projected.toArray(),
      camera: sf.camera.position.toArray(),
      visibility
    };
  });
  assert.ok(
    heroAudit.visibility.every(({ visible }) => visible),
    `hero object hidden in parent chain: ${JSON.stringify(heroAudit.visibility)}`
  );
  assert.ok(
    Math.abs(heroAudit.projected[0]) < 0.92 && Math.abs(heroAudit.projected[1]) < 0.92,
    `hero object outside camera frame: ${JSON.stringify(heroAudit)}`
  );
  const hero = await page.screenshot({ path: `${OUT}/hirajoshi-wave-hero.png`, fullPage: false });
  const heroStats = await sharp(hero).stats();
  assert.ok(heroStats.entropy > 2, `hero screenshot appears blank (${heroStats.entropy})`);

  await page.evaluate(() => {
    const sf = window.__sf;
    const centerY = sf.waveOrgan.hirajoshiDebugState().center.y;
    window.__sf.waveOrgan.setHirajoshiTime(48);
    window.__sfFreeCam(
      [257, sf.map.groundTop(257, -2018) + 10.2, -2018],
      [275, centerY + 5.0, -2004]
    );
    sf.tick(1 / 60);
  });
  const aligned = await page.screenshot({ path: `${OUT}/hirajoshi-wave-aligned.png`, fullPage: false });
  const alignedStats = await sharp(aligned).stats();
  assert.ok(alignedStats.entropy > 2, `alignment screenshot appears blank (${alignedStats.entropy})`);

  await page.evaluate(() => {
    const sf = window.__sf;
    const centerY = sf.waveOrgan.hirajoshiDebugState().center.y;
    window.__sfFreeCam(
      [262, sf.map.groundTop(262, -2014) + 2.7, -2014],
      [275, centerY + 0.55, -2004]
    );
    sf.tick(1 / 60);
  });
  const material = await page.screenshot({ path: `${OUT}/hirajoshi-wave-material.png`, fullPage: false });
  const materialStats = await sharp(material).stats();
  assert.ok(materialStats.entropy > 2, `material screenshot appears blank (${materialStats.entropy})`);

  const revisitStart = requests.length;
  await page.evaluate(() => window.__sf.ensureOptionalWorldSite("wave-organ"));
  await page.waitForTimeout(500);
  const revisitAssets = requests.slice(revisitStart).filter(isAsset);
  assert.deepEqual(revisitAssets, [], `revisiting the sculpture refetched media: ${revisitAssets.join(", ")}`);

  const gpuErrors = pageErrors.filter((message) =>
    /WebGPU|GPUValidation|WGSL|render pipeline|bind group|TypeError/i.test(message)
  );
  assert.deepEqual(gpuErrors, [], `WebGPU errors: ${gpuErrors.join("\n")}`);

  console.log(JSON.stringify({
    ok: true,
    lazy: { boot: bootAssets.length, activation: assetNames, revisit: revisitAssets.length },
    audit,
    heroAudit,
    screenshots: {
      hero: `${OUT}/hirajoshi-wave-hero.png`,
      heroEntropy: heroStats.entropy,
      aligned: `${OUT}/hirajoshi-wave-aligned.png`,
      alignedEntropy: alignedStats.entropy,
      material: `${OUT}/hirajoshi-wave-material.png`,
      materialEntropy: materialStats.entropy
    },
    pageErrors
  }, null, 2));
} finally {
  await browser.close();
}
