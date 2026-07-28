// Lazy-loading + cost contract for the Ocean Beach shorebreak
// (docs/LAZY_LOADING.md acceptance checklist).
//
//   SF_PROBE_URL=http://localhost:5240 node tools/shorebreak-lazy-probe.mjs
//
// Three phases, as the checklist requires:
//   boot        — spawn far inland; ZERO shorebreak requests
//   activation  — walk onto Ocean Beach; exactly one chunk request
//   after       — leave the beach entirely; the sheet is released
//
// It also samples GPU-bound frame time with the sheet on screen versus hidden,
// because a transparent sheet over a 3.5 km beach is the kind of thing that
// looks free until someone opens it on a fanless laptop.

import { access } from "node:fs/promises";
import { chromium } from "playwright-core";

const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const CHUNK_HINT = /oceanBeachShorebreak|shorebreak/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  throw new Error("No Chrome/Chromium found; set CHROME_BIN.");
}

/** Median frame interval over `frames` rAF ticks — the GPU is the bottleneck here. */
const FRAME_SAMPLER = (frames) =>
  new Promise((resolve) => {
    const times = [];
    let last = performance.now();
    let n = 0;
    const tick = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      if (++n < frames) requestAnimationFrame(tick);
      else {
        times.sort((a, b) => a - b);
        resolve(Number(times[Math.floor(times.length / 2)].toFixed(2)));
      }
    };
    requestAnimationFrame(tick);
  });

async function main() {
  const browser = await chromium.launch({
    executablePath: await findChrome(),
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
  const report = {};
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const requests = [];
    page.on("request", (r) => requests.push(r.url()));

    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
    await page.waitForFunction(() => Boolean(window.__sf), null, { timeout: 180_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 180_000 });
    await sleep(4000);

    report.bootRequests = requests.filter((u) => CHUNK_HINT.test(u));
    report.bootResident = await page.evaluate(() => Boolean(window.__sf?.getShorebreak?.()));

    // --- activation: walk onto the sand ---------------------------------
    const before = requests.length;
    await page.evaluate(() => {
      const sf = window.__sf;
      const z = 3370;
      let waterX = -6100;
      for (let x = -6250; x < -5700; x += 1) {
        if (sf.map.isWater(x, z)) waterX = x;
        else break;
      }
      const x = waterX + 26;
      sf.player.teleportTo({ x, y: sf.map.groundTop(x, z) + 1.1, z, facing: -Math.PI / 2, mode: "walk" });
      sf.WORLD_TUNING.fogMaster = 0.02;
      sf.sky.setTimeOfDay(14.5);
      sf.hud?.setHidden?.(true);
    });
    await page
      .waitForFunction(() => Boolean(window.__sf?.getShorebreak?.()), null, { timeout: 90_000 })
      .catch(() => {});
    await sleep(4000);
    report.activationRequests = requests.slice(before).filter((u) => CHUNK_HINT.test(u));
    report.activationResident = await page.evaluate(() => Boolean(window.__sf?.getShorebreak?.()));
    report.sheet = await page.evaluate(() => {
      const s = window.__sf?.getShorebreak?.()?.debugState?.() ?? null;
      return s && { chunks: s.chunks, visible: s.visible, rows: s.rows.length };
    });

    // --- cost: the same view with the sheet drawn and with it hidden ------
    // At 1600×1000 a 60 Hz cap swallows the whole measurement — both numbers
    // come back as one vsync interval and say nothing. Push the pixel count up
    // until the GPU, not the display clock, is what the timer is watching.
    await page.setViewportSize({ width: 2560, height: 1600 });
    await sleep(1500);
    await page.evaluate(() => {
      const sf = window.__sf;
      // Eye level on the sand, swash filling the lower half of frame — the
      // worst case for a transparent sheet is being close and edge-on to it.
      const p = sf.player.position;
      window.__sfFreeCam([p.x + 6, p.y + 0.6, p.z + 30], [p.x - 60, 0.3, p.z - 20]);
    });
    await sleep(2500);
    report.frameMsWithSheet = await page.evaluate(FRAME_SAMPLER, 260);
    await page.evaluate(() => {
      window.__sf.scene.getObjectByName("ocean_beach_shorebreak").visible = false;
    });
    await sleep(1500);
    report.frameMsWithout = await page.evaluate(FRAME_SAMPLER, 260);
    await page.evaluate(() => {
      window.__sf.scene.getObjectByName("ocean_beach_shorebreak").visible = true;
    });

    // --- release: leave the beach ----------------------------------------
    await page.evaluate(() => {
      const sf = window.__sf;
      sf.player.teleportTo({ x: -1200, y: sf.map.groundTop(-1200, 2400) + 1.1, z: 2400, facing: 0, mode: "walk" });
    });
    await sleep(5000);
    report.releasedAfterLeaving = await page.evaluate(() => !window.__sf?.getShorebreak?.());

    report.verdict = {
      bootClean: report.bootRequests.length === 0 && !report.bootResident,
      loadsOnApproach: report.activationResident,
      releases: report.releasedAfterLeaving,
      frameCostMs: Number((report.frameMsWithSheet - report.frameMsWithout).toFixed(2))
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
