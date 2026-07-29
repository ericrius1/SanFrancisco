/**
 * Frame cost at a fixed viewpoint, for A/B-ing a rendering change.
 *
 * READ THIS BEFORE TRUSTING A NUMBER FROM IT.
 *
 * Two runs of the SAME build here measured p50 49.7 ms and 23.4 ms. The noise
 * floor across sessions is roughly ±100%, so this cannot resolve anything
 * smaller than a gross regression, and comparing two separate invocations —
 * two branches, say — is meaningless no matter how many frames each averages.
 *
 * What it CAN do is SF_SWEEP_LUT: interleave several configurations inside one
 * session, round-robin, so per-session thermal and scheduling drift is common
 * to all of them and the paired medians are comparable to each other. Use that
 * shape for any comparison you actually intend to believe.
 *
 * renderer.trackTimestamp would be the right instrument and is not usable here:
 * it must be set before passes are recorded, so flipping it mid-session attaches
 * no queries and every resolve silently returns nothing — indistinguishable from
 * the frame not rendering.
 *
 * Everything that could confound a comparison is pinned: spawn, hour, camera
 * heading and pitch, viewport, and the adaptive-resolution governor, which
 * otherwise scales the drawing buffer to defend frame rate and makes frame time
 * self-normalising (it quietly dropped a requested pixel ratio of 2 to 0.7).
 *
 *   SF_PROBE_URL=http://localhost:5245 node --experimental-strip-types tools/grade-perf-probe.mjs
 *
 * Env: SF_TIME (20.35), SF_SPAWN (oceanBeach), SF_FRAMES (240), SF_LABEL,
 *      SF_LOOK (skip to leave the app default), SF_LUTSIZE, SF_W/SF_H, SF_RATIO (2),
 *      SF_SWEEP_LUT (within-session LUT-size A/B), SF_ROUNDS (5).
 */

import { access } from "node:fs/promises";
import { chromium } from "playwright-core";

const BASE = process.env.SF_PROBE_URL?.trim() || "http://localhost:5245";
const TIME = Number(process.env.SF_TIME ?? 20.35);
const SPAWN = process.env.SF_SPAWN ?? "oceanBeach";
const FRAMES = Number(process.env.SF_FRAMES ?? 240);
const LABEL = process.env.SF_LABEL ?? BASE;
const LOOK = process.env.SF_LOOK ?? null;
const LUTSIZE = process.env.SF_LUTSIZE ? Number(process.env.SF_LUTSIZE) : null;
const W = Number(process.env.SF_W ?? 1440);
const H = Number(process.env.SF_H ?? 900);
// Fragment-cost amplifier — see the note in the measurement block.
const RATIO = Number(process.env.SF_RATIO ?? 2);
// Within-session LUT-size A/B, e.g. SF_SWEEP_LUT=33,48,128
const SWEEP = (process.env.SF_SWEEP_LUT ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const ROUNDS = Number(process.env.SF_ROUNDS ?? 5);

async function exists(p) { try { await access(p); return true; } catch { return false; } }
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

const browser = await chromium.launch({
  executablePath: await findChrome(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    // timestamp-query is gated behind Dawn's unsafe APIs; without this the
    // device simply lacks the feature and every resolve returns nothing, which
    // looks identical to "the frame did not render".
    "--enable-dawn-features=allow_unsafe_apis",
    "--enable-gpu",
    "--use-angle=metal",
    "--mute-audio",
    "--hide-scrollbars"
  ]
});
const page = await (await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 1, serviceWorkers: "block"
})).newPage();

try {
  const res = await page.goto(`${BASE}/?autostart=1&fullfps=1&spawn=${encodeURIComponent(SPAWN)}`, {
    waitUntil: "domcontentloaded", timeout: 30_000
  });
  if (res?.status() !== 200) throw new Error(`expected 200, got ${res?.status()}`);

  await page.waitForFunction(
    () => Boolean(window.__sf?.renderer && window.__sf?.pipeline && window.__sfManual),
    undefined, { timeout: 180_000 }
  );
  await page.waitForFunction(
    () => window.__sf.renderIdle() === true
      && window.__sf.worldArrival?.active === false
      && window.__sf.rings?.state() === "settled",
    undefined, { timeout: 180_000 }
  );

  await page.evaluate(({ tod }) => {
    const sf = window.__sf;
    window.__sfManual(true);
    sf.sky.realTime = false;
    sf.sky.cycleEnabled = false;
    sf.sky.setTimeOfDay(tod);
  }, { tod: TIME });

  const aim = () => page.evaluate(() => {
    const sf = window.__sf;
    sf.chase.yaw = -sf.sky.sunAzimuth * Math.PI / 180;
    sf.chase.pitch = 0.02;
  });
  const settle = async (rounds) => {
    for (let r = 0; r < rounds; r++) {
      await aim();
      await page.evaluate(() => { for (let i = 0; i < 8; i++) window.__sf.tick(1 / 30); });
      await page.waitForTimeout(120);
    }
  };

  await page.keyboard.press("Tab"); // clean plate; also removes HUD compositing
  await settle(14);

  if (LOOK) {
    await page.evaluate((id) => window.__sf.pipeline.grade?.setLook(id), LOOK);
    await settle(3);
  }
  if (LUTSIZE) {
    await page.evaluate((n) => window.__sf.pipeline.grade?.setLutSize(n), LUTSIZE);
    await settle(3);
  }

  // Within-session A/B. Cross-session comparison is hopeless here: two runs of
  // the SAME build measured p50 49.7 ms and 23.4 ms, a noise floor of roughly
  // +/-100% that no display-transform change could ever clear. Interleaving the
  // configurations inside one session, round-robin, cancels the per-session
  // thermal/scheduling drift that causes it, and the paired medians are then
  // comparable to each other even though neither is comparable across runs.
  if (SWEEP.length) {
    const rows = new Map(SWEEP.map((s) => [s, []]));
    await page.evaluate((ratio) => {
      const sf = window.__sf;
      sf.dynRes?.setEnabled?.(false);
      sf.renderer.setPixelRatio(ratio);
      sf.renderer.setSize(window.innerWidth, window.innerHeight);
      window.__sfManual(false);
    }, RATIO);
    await page.waitForTimeout(2000);
    for (let round = 0; round < ROUNDS; round++) {
      for (const size of SWEEP) {
        await page.evaluate((n) => window.__sf.pipeline.grade.setLutSize(n), size);
        await page.waitForTimeout(400);
        const p50 = await page.evaluate(async (frames) => {
          const dts = [];
          await new Promise((resolve) => {
            let last = performance.now(); let seen = 0;
            const t = () => {
              const now = performance.now(); const dt = now - last; last = now; seen++;
              if (seen > 20) dts.push(dt);
              if (dts.length >= frames) resolve(); else requestAnimationFrame(t);
            };
            requestAnimationFrame(t);
          });
          dts.sort((a, b) => a - b);
          return dts[Math.floor(dts.length / 2)];
        }, FRAMES);
        rows.get(size).push(p50);
        console.log(`  round ${round + 1}  LUT ${String(size).padStart(3)}³  p50 ${p50.toFixed(2)} ms`);
      }
    }
    console.log(`\n${LABEL} — within-session LUT sweep (pixelRatio ${RATIO}, ${ROUNDS} rounds x ${FRAMES} frames)`);
    for (const size of SWEEP) {
      const v = rows.get(size).slice().sort((a, b) => a - b);
      const med = v[Math.floor(v.length / 2)];
      const kb = ((size ** 3 * 8) / 1024).toFixed(0);
      console.log(`  LUT ${String(size).padStart(3)}³ (${kb.padStart(5)} KB VRAM):  median-of-rounds p50 ${med.toFixed(2)} ms` +
        `   [${v.map((x) => x.toFixed(1)).join(", ")}]`);
    }
    await browser.close();
    process.exit(0);
  }

  const out = await page.evaluate(async ({ frames, ratio }) => {
    const sf = window.__sf;
    const r = sf.renderer;

    // PIN THE GOVERNOR FIRST. src/render/adaptiveResolution.ts scales the
    // drawing buffer to defend frame rate, which makes frame time
    // self-normalising and any A/B of it meaningless — it quietly dropped a
    // requested pixel ratio of 2 to 0.7. setEnabled(false) pins L0 / scale 1.0
    // and is documented as the probe + capture contract.
    sf.dynRes?.setEnabled?.(false);

    // Amplify the fragment cost so the display transform is a measurable share
    // of the frame. renderer.trackTimestamp would be the direct instrument, but
    // it has to be set before passes are recorded — flipping it mid-session
    // attaches no queries and every resolve silently returns nothing. Frame
    // INTERVALS in the live rAF loop are the honest fallback, and they only
    // discriminate once the frame is comfortably past the vsync period, which
    // is what the pixel ratio is for.
    r.setPixelRatio(ratio);
    r.setSize(window.innerWidth, window.innerHeight);

    let draws = 0;
    let tris = 0;
    // Hand the loop back to rAF: intervals are meaningless under manual ticking.
    window.__sfManual(false);
    await new Promise((res) => setTimeout(res, 1500));

    const dts = [];
    await new Promise((resolve) => {
      let last = performance.now();
      let seen = 0;
      const tick = () => {
        const now = performance.now();
        const dt = now - last;
        last = now;
        seen++;
        if (seen > 45) dts.push(dt); // discard the warm-up ramp
        if (r.info.render.drawCalls) { draws = r.info.render.drawCalls; tris = r.info.render.triangles; }
        if (dts.length >= frames) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const ms = dts;
    ms.sort((a, b) => a - b);
    const q = (p) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] : NaN;
    return {
      n: ms.length,
      p50: q(0.5), p90: q(0.9), p99: q(0.99),
      min: ms[0], max: ms[ms.length - 1],
      mean: ms.reduce((a, b) => a + b, 0) / (ms.length || 1),
      look: sf.pipeline.grade?.activeLookId?.() ?? "n/a",
      toneMapping: r.toneMapping,
      pixelRatio: r.getPixelRatio(),
      drawCalls: draws,
      triangles: tris,
      canvas: [r.domElement.width, r.domElement.height]
    };
  }, { frames: FRAMES, ratio: RATIO });

  console.log(`\n${LABEL}`);
  console.log(`  look=${out.look}  toneMapping=${out.toneMapping}  canvas=${out.canvas.join("x")}` +
    `  draws=${out.drawCalls}  tris=${out.triangles}`);
  console.log(`  GPU ms over ${out.n} frames:  p50 ${out.p50?.toFixed(3)}   p90 ${out.p90?.toFixed(3)}` +
    `   p99 ${out.p99?.toFixed(3)}   mean ${out.mean?.toFixed(3)}   min ${out.min?.toFixed(3)}`);
  console.log(JSON.stringify({ label: LABEL, ...out }));
} finally {
  await browser.close();
}
