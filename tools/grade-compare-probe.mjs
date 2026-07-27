/**
 * Grade A/B harness. Boots the world ONCE, then sweeps looks × times of day and
 * writes one clean plate per combination. Because a look change is only a LUT
 * re-upload, every shot in a sweep comes from the same compiled pipeline and the
 * same settled world — so differences between plates are the grade and nothing
 * else. That is the whole reason the shots are trustworthy.
 *
 *   SF_PROBE_URL=http://localhost:5245 node tools/grade-compare-probe.mjs
 *
 * Env:
 *   SF_LOOKS   comma list of look ids   (default: goldenState,aces)
 *   SF_TIMES   comma list of hours      (default: 18.6)
 *   SF_SPAWN   spawn key                (default: oceanBeach)
 *   SF_FACE    sun | none               (default: sun — aim the camera at the sunset)
 *   SF_PITCH   chase pitch in radians   (default: 0.02)
 *   SF_LUTSIZE re-bake the LUT at this edge length before shooting (fidelity check)
 *   SF_TAG     filename prefix
 *   SF_SHOT_OUT output dir              (default: .data/grade-shots)
 */

import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const OUT = process.env.SF_SHOT_OUT ?? ".data/grade-shots";
const BASE = process.env.SF_PROBE_URL?.trim() || "http://localhost:5245";
const LOOKS = (process.env.SF_LOOKS ?? "goldenState,aces").split(",").map((s) => s.trim()).filter(Boolean);
const TIMES = (process.env.SF_TIMES ?? "18.6").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const SPAWN = process.env.SF_SPAWN ?? "oceanBeach";
const FACE = process.env.SF_FACE ?? "sun";
const PITCH = Number(process.env.SF_PITCH ?? 0.02);
const LUTSIZE = process.env.SF_LUTSIZE ? Number(process.env.SF_LUTSIZE) : null;
const TAG = process.env.SF_TAG ?? "";

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

const written = [];
try {
  const res = await page.goto(`${BASE}/?autostart=1&fullfps=1&spawn=${encodeURIComponent(SPAWN)}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000
  });
  if (res?.status() !== 200) throw new Error(`expected 200, got ${res?.status()}`);

  await page.waitForFunction(
    () => Boolean(window.__sf?.renderer && window.__sf?.pipeline && window.__sfManual),
    undefined,
    { timeout: 180_000 }
  );
  // renderIdle() alone goes true while the arrival materialize front is still
  // scanning; gate on the arrival and ring coordinator too or the plate comes
  // back as particles on black.
  await page.waitForFunction(
    () => window.__sf.renderIdle() === true
      && window.__sf.worldArrival?.active === false
      && window.__sf.rings?.state() === "settled",
    undefined,
    { timeout: 180_000 }
  );
  console.log("[cmp] world settled");

  await page.evaluate(() => {
    window.__sfManual(true);
    window.__sf.sky.cycleEnabled = false;
    window.__sf.sky.realTime = false;
  });

  // Clean plate: Tab fades the HUD. It is read via input.pressed("Tab") inside
  // the frame body, so in manual mode the press lands on the NEXT tick.
  await page.keyboard.press("Tab");
  await page.evaluate(() => { for (let i = 0; i < 40; i++) window.__sf.tick(1 / 30); });
  await page.waitForTimeout(1_200);

  if (LUTSIZE) {
    await page.evaluate((n) => window.__sf.pipeline.grade.setLutSize(n), LUTSIZE);
    console.log("[cmp] LUT re-baked at", LUTSIZE);
  }

  /**
   * Tick in batches separated by REAL awaits.
   *
   * This is not padding. The renderer holds frames while a compile is in flight
   * (pipeline.ts, exclusiveCompileDepth), and a compile resolves on a promise.
   * A tight tick loop inside one page.evaluate() is synchronous JS, so no
   * microtask ever runs, the gate never clears, every tick no-ops, and the
   * canvas keeps the PREVIOUS frame — while the probe's own state read-back
   * cheerfully reports the new sun elevation and camera heading. That is how a
   * plate can be a midday inland shot whose log line says sunset, and why the
   * failure came and went depending on whether a compile happened to be pending.
   */
  /**
   * chase.yaw is the DESTINATION heading; the rendered boom eases toward it over
   * a second or so. Re-asserting it every round lets it converge without
   * chase.cutTo(), which is the documented hard-cut but teleports the camera and
   * kicks off a streaming/compile burst that holds frames well past any
   * reasonable settle window — plates come back stale while every read-back
   * still reports success.
   */
  const aim = () => page.evaluate(({ face, pitch }) => {
    if (face !== "sun") return;
    const sf = window.__sf;
    sf.chase.yaw = -sf.sky.sunAzimuth * Math.PI / 180;
    sf.chase.pitch = pitch;
  }, { face: FACE, pitch: PITCH });

  const settle = async (rounds = 14) => {
    for (let r = 0; r < rounds; r++) {
      await aim();
      await page.evaluate(() => { for (let i = 0; i < 8; i++) window.__sf.tick(1 / 30); });
      await page.waitForTimeout(120);
    }
  };

  for (const time of TIMES) {
    for (const look of LOOKS) {
      await page.evaluate(({ tod, lookId }) => {
        const sf = window.__sf;
        sf.pipeline.grade.setLook(lookId);
        sf.sky.setTimeOfDay(tod);
      }, { tod: time, lookId: look });
      await settle();

      const info = await page.evaluate(() => {
        const sf = window.__sf;
        // Measure the RENDERED camera, not the requested yaw — the requested
        // value is trivially correct and tells you nothing about the plate.
        const fwd = sf.camera.position.clone();
        sf.camera.getWorldDirection(fwd);
        const sunAz = sf.sky.sunAzimuth * Math.PI / 180;
        const sunX = Math.sin(sunAz);
        const sunZ = -Math.cos(sunAz);
        const dYaw = Math.atan2(
          fwd.x * sunZ - fwd.z * sunX,
          fwd.x * sunX + fwd.z * sunZ
        );
        return {
          look: sf.pipeline.grade.activeLookId(),
          timeOfDay: Number(sf.sky.timeOfDay.toFixed(2)),
          sunElevation: Number(sf.sky.sunElevation.toFixed(2)),
          sunAzimuth: Number(sf.sky.sunAzimuth.toFixed(1)),
          offSunDeg: Number((dYaw * 180 / Math.PI).toFixed(1))
        };
      });

      const name = `${TAG}${look}_t${String(time).replace(".", "-")}.png`;
      const file = path.join(OUT, name);
      await page.screenshot({ path: file });
      written.push(file);
      console.log(`[cmp] ${name}  ${JSON.stringify(info)}`);
    }
  }
  if (pageErrors.length) console.log("[cmp] pageErrors:\n" + pageErrors.join("\n"));
} finally {
  await browser.close();
}
console.log(`[cmp] wrote ${written.length} plates to ${OUT}`);
