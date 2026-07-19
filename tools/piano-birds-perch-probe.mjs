// Headless verification that Beach Pianist perch-cycler birds actually LAND:
// projects every crown landing point to screen from a fixed beach viewpoint,
// captures a frame series spanning a full perch cycle, and reports per-perch
// dark-silhouette hits (a seated bird = stationary dark blob just above the
// crown for several consecutive frames).
//
//   SF_PROBE_URL=http://127.0.0.1:5241 node tools/piano-birds-perch-probe.mjs

import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import sharp from "sharp";

const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5241";
const OUT = ".data/piano-birds-perch-probe";
const FRAMES = 14;
const FRAME_GAP_MS = 3000;

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${SERVER_URL}/?autostart=1&spawn=beachPianist&fullfps=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(() => window.__sf?.player && window.__sf?.beachPianist, undefined, {
    timeout: 150_000
  });
  await page.waitForFunction(() => window.__sf.renderIdle?.(), undefined, { timeout: 180_000 });
  await page.waitForTimeout(8000);

  await page.keyboard.press("Tab");
  const view = async () => {
    await page.evaluate(() => {
      const sf = window.__sf;
      const site = { x: -3340, z: -870 };
      const aim = { x: -2947, z: -2289 };
      const ax = aim.x - site.x;
      const az = aim.z - site.z;
      const len = Math.hypot(ax, az);
      const x = site.x - (ax / len) * 34;
      const z = site.z - (az / len) * 34;
      const y = sf.map.effectiveGround(x, z) + 0.9;
      const facing = Math.atan2(-ax, -az);
      sf.player.teleportTo({ x, y, z, facing, mode: "walk" });
      sf.chase.yaw = facing;
      sf.chase.pitch = -0.24;
    });
  };
  await view();
  await page.waitForTimeout(2500);

  const captureAndProject = async (index) => {
    await page.evaluate(() => { window.__sf.chase.pitch = -0.24; });
    const projected = await page.evaluate(() => {
      const sf = window.__sf;
      const camera = sf.camera;
      camera.updateMatrixWorld();
      return sf.beachPianist.birdPerchesWorld().map((p) => {
        const v = p.clone().project(camera);
        return {
          x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
          y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
          inFront: v.z < 1 && v.z > -1
        };
      });
    });
    await page.screenshot({ path: `${OUT}/f${String(index).padStart(2, "0")}.png` });
    return projected;
  };

  let projections = null;
  for (let i = 0; i < FRAMES; i++) {
    projections = await captureAndProject(i);
    if (i < FRAMES - 1) await page.waitForTimeout(FRAME_GAP_MS);
  }

  // A seated bird reads as dark pixels in a small patch centred slightly above
  // the crown point. Foliage is also dark, so require DARKER-than-foliage
  // (< 62/255 luma) and report per-frame counts for human judgement.
  const PATCH = 13;
  const hits = projections.map(() => []);
  for (let f = 0; f < FRAMES; f++) {
    const file = `${OUT}/f${String(f).padStart(2, "0")}.png`;
    const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
    projections.forEach((p, i) => {
      if (!p.inFront) { hits[i].push(-1); return; }
      let dark = 0;
      for (let dy = -PATCH; dy <= PATCH; dy++) {
        for (let dx = -PATCH; dx <= PATCH; dx++) {
          const x = p.x + dx;
          const y = p.y - 4 + dy;
          if (x < 0 || y < 0 || x >= info.width || y >= info.height) continue;
          if (data[y * info.width + x] < 62) dark++;
        }
      }
      hits[i].push(dark);
    });
  }
  projections.forEach((p, i) => {
    console.log(
      `perch${String(i).padStart(2, "0")} @(${p.x},${p.y}) inFront=${p.inFront} dark/frame: ${hits[i].join(" ")}`
    );
  });
} finally {
  await browser.close();
}
