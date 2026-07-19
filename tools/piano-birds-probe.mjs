// Headless WebGPU probe for the Beach Pianist grove birds.
// Spawns at the beachPianist arrival, waits for the site, then verifies the
// one-draw instanced bird layer actually animates: screenshots the sky at two
// times and diffs them, and dumps the site/bird debug state.
//
//   SF_PROBE_URL=http://127.0.0.1:5241 node tools/piano-birds-probe.mjs

import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5241";
const OUT = ".data/piano-birds-probe";

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
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") pageErrors.push(message.text());
  });

  await page.goto(`${SERVER_URL}/?autostart=1&spawn=beachPianist&fullfps=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(() => window.__sf?.player && window.__sf?.map, undefined, {
    timeout: 150_000
  });
  await page.waitForFunction(() => !!window.__sf?.beachPianist, undefined, { timeout: 150_000 });
  await page.waitForFunction(
    () => !!window.__sf.scene.getObjectByName("beachPianist.birds.oneDraw"),
    undefined,
    { timeout: 150_000 }
  );
  await page.waitForFunction(() => window.__sf.renderIdle?.(), undefined, { timeout: 180_000 });
  await page.waitForTimeout(12_000);

  const state = await page.evaluate(() => {
    const sf = window.__sf;
    const site = sf.beachPianist;
    const mesh = sf.scene.getObjectByName("beachPianist.birds.oneDraw");
    let visibleChain = true;
    for (let o = mesh; o; o = o.parent) visibleChain &&= o.visible;
    const geo = mesh.geometry;
    const mat = mesh.material;
    return {
      siteDebug: site?.debugState?.birds ?? site?.debugState ?? null,
      meshCount: mesh.count,
      visibleChain,
      frustumCulled: mesh.frustumCulled,
      geoAttribs: Object.keys(geo.attributes),
      geoIndex: !!geo.index,
      posCount: geo.attributes.position?.count ?? 0,
      matType: mat.type,
      hasPositionNode: !!mat.positionNode,
      groupWorldPos: (() => {
        mesh.parent.updateWorldMatrix(true, false);
        const e = mesh.parent.matrixWorld.elements;
        return { x: e[12], y: e[13], z: e[14] };
      })()
    };
  }).catch(async (e) => ({ evalError: String(e) }));
  console.log("STATE", JSON.stringify(state, null, 2));

  // Two viewpoints: A — beach 30 m out looking gently up at the grove;
  // B — beside the pianist looking steeply up into the canopy (the user shot).
  const look = async (dist, pitch) => {
    await page.evaluate(({ dist, pitch }) => {
      const sf = window.__sf;
      const site = { x: -3340, z: -870 };
      const aim = { x: -2947, z: -2289 };
      const ax = aim.x - site.x;
      const az = aim.z - site.z;
      const len = Math.hypot(ax, az);
      const x = site.x - (ax / len) * dist;
      const z = site.z - (az / len) * dist;
      const y = sf.map.effectiveGround(x, z) + 0.9;
      const facing = Math.atan2(-ax, -az);
      sf.player.teleportTo({ x, y, z, facing, mode: "walk" });
      sf.chase.yaw = facing;
      sf.chase.pitch = pitch;
    }, { dist, pitch });
  };
  await page.keyboard.press("Tab"); // hide HUD so sky diffs are clean
  await look(30, -0.3);
  await page.waitForTimeout(2500);
  for (let i = 0; i < 4; i++) {
    await page.evaluate((pitch) => { window.__sf.chase.pitch = pitch; }, -0.3);
    await page.screenshot({ path: `${OUT}/beach${i}.png` });
    await page.waitForTimeout(1800);
  }
  await look(9, -0.55);
  await page.waitForTimeout(2000);
  for (let i = 0; i < 4; i++) {
    await page.evaluate((pitch) => { window.__sf.chase.pitch = pitch; }, -0.55);
    await page.screenshot({ path: `${OUT}/grove${i}.png` });
    await page.waitForTimeout(1800);
  }

  if (pageErrors.length) {
    console.log("PAGE ERRORS (first 20):");
    for (const err of pageErrors.slice(0, 20)) console.log("  ", err.slice(0, 300));
  } else {
    console.log("no page errors");
  }
} finally {
  await browser.close();
}
