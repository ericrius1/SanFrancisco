// Headless WebGPU regression probe for the Japanese Tea Garden Drum Bridge.
// Verifies authored texture lazy-loading, hero geometry, and a nonblank close
// view. Run against an existing Vite server:
//   SF_PROBE_URL=http://127.0.0.1:5240 node tools/drum-bridge-probe.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import sharp from "sharp";

const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
const OUT = ".data/drum-bridge-probe";
const CENTER = { x: -2273.96, z: 2193.03 };
const BRIDGE_ASSET_ROOT = "/japanese-tea-garden/drum-bridge/";

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

  await page.goto(`${SERVER_URL}/?autostart=1&fullfps=1&profile=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(() => window.__sf?.player && window.__sf?.map, undefined, { timeout: 150_000 });
  await page.waitForTimeout(1200);

  const isBridgeAsset = (url) => new URL(url).pathname.includes(BRIDGE_ASSET_ROOT);
  const bootAssets = requests.filter(isBridgeAsset);
  assert.deepEqual(bootAssets, [], `clean boot eagerly requested Drum Bridge media: ${bootAssets.join(", ")}`);

  const activationStart = requests.length;
  await page.evaluate(({ x, z }) => {
    const sf = window.__sf;
    const y = sf.map.effectiveGround(x, z) + 1.5;
    sf.player.teleportTo({ x, y, z, facing: Math.PI, mode: "walk" });
  }, CENTER);
  await page.waitForFunction(
    () => window.__sf?.scene?.getObjectByName("japanese_tea_garden_drum_bridge"),
    undefined,
    { timeout: 150_000 }
  );
  await page.waitForFunction(
    () => {
      const treads = window.__sf.scene.getObjectByName("drum_bridge_worn_stair_treads");
      const paint = window.__sf.scene.getObjectByName("drum_bridge_layered_outer_arch_fascias");
      return Boolean(treads?.material?.map && treads.material.normalMap && paint?.material?.map && paint.material.normalMap);
    },
    undefined,
    { timeout: 150_000 }
  );
  await page.waitForFunction(() => window.__sf.renderIdle?.(), undefined, { timeout: 150_000 });

  const activationAssets = requests.slice(activationStart).filter(isBridgeAsset);
  const assetNames = [...new Set(activationAssets.map((url) => new URL(url).pathname.split("/").at(-1)))];
  for (const stem of [
    "painted-timber-basecolor",
    "painted-timber-normal",
    "worn-timber-basecolor",
    "worn-timber-normal"
  ]) {
    assert.ok(assetNames.some((name) => name.startsWith(stem)), `activation did not request ${stem}`);
  }
  assert.ok(
    assetNames.every((name) => /^(painted|worn)-timber-(basecolor|normal)\.(ktx2|webp)$/.test(name)),
    `activation requested unexpected Drum Bridge media: ${assetNames.join(", ")}`
  );

  const audit = await page.evaluate(() => {
    const sf = window.__sf;
    const names = [
      "drum_bridge_worn_stair_treads",
      "drum_bridge_painted_stair_risers",
      "drum_bridge_rounded_stair_nosings",
      "drum_bridge_six_laminated_arch_ribs",
      "drum_bridge_layered_outer_arch_fascias",
      "drum_bridge_round_handrails",
      "drum_bridge_laminated_lower_rails",
      "drum_bridge_square_balustrade_posts",
      "drum_bridge_post_joinery_caps",
      "drum_bridge_visible_joinery_pegs",
      "drum_bridge_turned_landing_finials"
    ];
    const objects = Object.fromEntries(names.map((name) => {
      const object = sf.scene.getObjectByName(name);
      return [name, object ? {
        count: object.count ?? 1,
        map: object.material?.map?.name ?? null,
        normalMap: object.material?.normalMap?.name ?? null
      } : null];
    }));
    return {
      objects,
      renderer: {
        webgpu: sf.renderer.backend?.isWebGPUBackend === true,
        calls: sf.renderer.info.render.calls,
        triangles: sf.renderer.info.render.triangles,
        textures: sf.renderer.info.memory.textures
      }
    };
  });
  for (const [name, object] of Object.entries(audit.objects)) assert.ok(object, `missing hero bridge part ${name}`);
  assert.equal(audit.objects.drum_bridge_worn_stair_treads.count, 18);
  assert.equal(audit.objects.drum_bridge_painted_stair_risers.count, 18);
  assert.equal(audit.objects.drum_bridge_rounded_stair_nosings.count, 18);
  assert.equal(audit.objects.drum_bridge_six_laminated_arch_ribs.count, 6);
  assert.equal(audit.objects.drum_bridge_layered_outer_arch_fascias.count, 2);
  assert.equal(audit.objects.drum_bridge_round_handrails.count, 2);
  assert.equal(audit.objects.drum_bridge_square_balustrade_posts.count, 20);
  assert.equal(audit.objects.drum_bridge_visible_joinery_pegs.count, 40);
  assert.equal(audit.objects.drum_bridge_turned_landing_finials.count, 4);
  assert.equal(audit.renderer.webgpu, true, "Drum Bridge did not render on WebGPU");
  assert.match(audit.objects.drum_bridge_worn_stair_treads.map, /worn_timber_basecolor/);
  assert.match(audit.objects.drum_bridge_worn_stair_treads.normalMap, /worn_timber_normal/);
  assert.match(audit.objects.drum_bridge_layered_outer_arch_fascias.map, /painted_timber_basecolor/);

  // Phase three: orbiting and approaching the already active landmark must not
  // fetch another texture variant or duplicate the current four-map set.
  const revisitStart = requests.length;
  await page.evaluate(({ x, z }) => {
    const sf = window.__sf;
    const nextX = x - 5;
    const nextZ = z + 4;
    sf.player.teleportTo({
      x: nextX,
      y: sf.map.effectiveGround(nextX, nextZ) + 1.5,
      z: nextZ,
      facing: -0.5,
      mode: "walk"
    });
  }, CENTER);
  await page.waitForTimeout(1000);
  const revisitAssets = requests.slice(revisitStart).filter(isBridgeAsset);
  assert.deepEqual(revisitAssets, [], `revisiting the bridge fetched more media: ${revisitAssets.join(", ")}`);

  await page.evaluate(({ x, z }) => {
    const sf = window.__sf;
    const forward = { x: 0.263, z: -0.965 };
    const right = { x: -0.965, z: -0.263 };
    const eyeX = x - right.x * 6.6 + forward.x * 3.4;
    const eyeZ = z - right.z * 6.6 + forward.z * 3.4;
    const eyeY = sf.map.groundTop(eyeX, eyeZ) + 3.85;
    const targetY = sf.map.groundTop(x, z) + 1.75;
    window.__sfFreeCam([eyeX, eyeY, eyeZ], [x, targetY, z]);
    sf.hud?.setHidden?.(true);
  }, CENTER);
  await page.waitForTimeout(700);
  const screenshot = await page.screenshot({ path: `${OUT}/drum-bridge-hero.png`, fullPage: false });
  const screenshotStats = await sharp(screenshot).stats();
  assert.ok(screenshotStats.entropy > 2, `Drum Bridge screenshot appears blank (${screenshotStats.entropy})`);

  await page.evaluate(({ x, z }) => {
    const sf = window.__sf;
    const forward = { x: 0.263, z: -0.965 };
    const right = { x: -0.965, z: -0.263 };
    const eyeX = x - forward.x * 5.2 - right.x * 1.15;
    const eyeZ = z - forward.z * 5.2 - right.z * 1.15;
    const eyeY = sf.map.groundTop(eyeX, eyeZ) + 2.15;
    const targetY = sf.map.groundTop(x, z) + 1.45;
    window.__sfFreeCam([eyeX, eyeY, eyeZ], [x, targetY, z]);
  }, CENTER);
  await page.waitForTimeout(450);
  const closeScreenshot = await page.screenshot({ path: `${OUT}/drum-bridge-material-close.png`, fullPage: false });
  const closeStats = await sharp(closeScreenshot).stats();
  assert.ok(closeStats.entropy > 2, `Drum Bridge material close-up appears blank (${closeStats.entropy})`);

  const gpuErrors = pageErrors.filter((message) => /WebGPU|GPUValidation|WGSL|render pipeline|bind group|TypeError/i.test(message));
  assert.deepEqual(gpuErrors, [], `WebGPU errors: ${gpuErrors.join("\n")}`);

  console.log(JSON.stringify({
    ok: true,
    lazy: { boot: bootAssets.length, activation: assetNames, revisit: revisitAssets.length },
    audit,
    screenshot: `${OUT}/drum-bridge-hero.png`,
    screenshotEntropy: screenshotStats.entropy,
    closeScreenshot: `${OUT}/drum-bridge-material-close.png`,
    closeScreenshotEntropy: closeStats.entropy,
    pageErrors
  }, null, 2));
} finally {
  await browser.close();
}
