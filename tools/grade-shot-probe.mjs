// Minimal tone-map/grade screenshot probe. Proves the whole harness path:
// headless Chrome + WebGPU -> __sf -> renderIdle -> __sfManual -> __sf.tick -> screenshot.
//
//   SF_PROBE_URL=http://localhost:5245 node tools/grade-shot-probe.mjs
//
// Env: SF_TIME (time of day, default 18.6), SF_SHOT_OUT, SF_SPAWN,
//      SF_HIDE_UI=0 to keep the HUD in frame.

import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const OUT = process.env.SF_SHOT_OUT ?? path.join(import.meta.dirname, "shots");
const BASE = process.env.SF_PROBE_URL?.trim() || "http://localhost:5245";
const TIME_OF_DAY = Number(process.env.SF_TIME ?? 18.6);

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}
async function findChrome() {
  for (const c of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (!c.includes("/") || await exists(c)) return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: await findChrome(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--enable-gpu",
    "--use-angle=metal",
    "--mute-audio",
    "--hide-scrollbars"
  ]
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  serviceWorkers: "block"
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.stack ?? e.message));

try {
  const spawn = process.env.SF_SPAWN ? `&spawn=${encodeURIComponent(process.env.SF_SPAWN)}` : "";
  const res = await page.goto(`${BASE}/?autostart=1&fullfps=1${spawn}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000
  });
  console.log("[grade] status", res?.status());
  if (res?.status() !== 200) throw new Error(`expected 200, got ${res?.status()}`);

  await page.waitForFunction(
    () => Boolean(window.__sf?.renderer && window.__sf?.pipeline && window.__sfManual),
    undefined,
    { timeout: 180_000 }
  );
  console.log("[grade] __sf up");

  // renderIdle() alone is NOT enough: it goes true while the void-arrival
  // materialize front is still scanning, and the shot comes back as cyan
  // particles on black. Gate on the arrival + ring coordinator too.
  await page.waitForFunction(
    () => window.__sf.renderIdle() === true
      && window.__sf.worldArrival?.active === false
      && window.__sf.rings?.state() === "settled",
    undefined,
    { timeout: 180_000 }
  );
  console.log("[grade] renderIdle + arrival settled");

  // Park the rAF loop, then drive frames by hand.
  const info = await page.evaluate((tod) => {
    window.__sfManual(true);
    const sf = window.__sf;
    sf.sky.cycleEnabled = false;
    sf.sky.setTimeOfDay(tod);
    for (let i = 0; i < 45; i++) sf.tick(1 / 30);
    return {
      backend: sf.renderer.backend?.isWebGPUBackend === true,
      toneMapping: sf.renderer.toneMapping,
      exposure: sf.renderer.toneMappingExposure,
      manual: sf.frameDriver.debugState.manual,
      ticks: sf.frameDriver.debugState.ticks,
      timeOfDay: sf.sky.timeOfDay,
      arrivalActive: sf.worldArrival?.active,
      rings: sf.rings?.state()
    };
  }, TIME_OF_DAY);
  console.log("[grade]", JSON.stringify(info));

  // Clean plate: Tab fades the HUD. It is read via input.pressed("Tab") inside
  // the frame body, so in manual mode the press only lands on the NEXT tick.
  if (process.env.SF_HIDE_UI !== "0") {
    await page.keyboard.press("Tab");
    await page.evaluate(() => {
      for (let i = 0; i < 40; i++) window.__sf.tick(1 / 30);
    });
    // The HUD fade is a CSS transition — 600 ms still catches it mid-fade.
    await page.waitForTimeout(1_500);
  }

  const shot = path.join(OUT, "grade.png");
  await page.screenshot({ path: shot });
  console.log("[grade] wrote", shot);
  if (pageErrors.length) console.log("[grade] pageErrors:\n" + pageErrors.join("\n"));
} finally {
  await browser.close();
}
