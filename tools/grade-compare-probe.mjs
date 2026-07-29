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
 *   SF_LUTSIZE re-bake the LUT at this edge length before shooting
 *   SF_LUTAB   also shoot the SAME frame at this edge length, as a near-truth
 *              reference to diff the shipped LUT against (fidelity check)
 *   SF_GREYCARDS=1  raise the "/" calibration chart and report where the 18%
 *              card lands, in stops vs photographic neutral
 *   SF_TAG     filename prefix
 *   SF_SHOT_OUT output dir              (default: .data/grade-shots)
 *
 * Every plate is gated on the canvas actually advancing — see settleUntilLive.
 * Without that gate this probe will happily write a stale frame whose log line
 * describes the state you asked for, which is the single most expensive failure
 * mode in this harness.
 */

import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { decodePng, sampleDisc } from "./lib/pngSample.mjs";
import { GRADE_LUT_SIZE, evaluateLook, findLook } from "../src/render/gradeLooks.ts";

const OUT = process.env.SF_SHOT_OUT ?? ".data/grade-shots";
const BASE = process.env.SF_PROBE_URL?.trim() || "http://localhost:5245";
const LOOKS = (process.env.SF_LOOKS ?? "goldenState,aces").split(",").map((s) => s.trim()).filter(Boolean);
const TIMES = (process.env.SF_TIMES ?? "18.6").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const SPAWN = process.env.SF_SPAWN ?? "oceanBeach";
const FACE = process.env.SF_FACE ?? "sun";
const PITCH = Number(process.env.SF_PITCH ?? 0.02);
const LUTSIZE = process.env.SF_LUTSIZE ? Number(process.env.SF_LUTSIZE) : null;
const TAG = process.env.SF_TAG ?? "";
const CARDS = process.env.SF_GREYCARDS === "1";
// Shoot a second plate of the SAME frame at this LUT edge length, as a
// near-truth reference to diff the shipped 48-cube against.
const LUTAB = process.env.SF_LUTAB ? Number(process.env.SF_LUTAB) : null;

const srgbDecode = (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

/**
 * Screen-space disc + sun-facing term for each calibration sphere. Pixel
 * sampling happens node-side on the screenshot: drawImage() of a WebGPU canvas
 * reads back black in headless Chrome, so the page can only report geometry.
 */
const GEOM_EXPR = `(()=>{const sf=window.__sf,THREE=sf.THREE,cam=sf.camera,chart=sf.calibrationChart;
  const cv=sf.renderer.domElement,w=cv.width,h=cv.height;
  const sun=sf.sky.sun;const sd=sun.position.clone().sub(sun.target.position).normalize();
  const v=new THREE.Vector3(),n=new THREE.Vector3();
  const f=(h*0.5)/Math.tan(THREE.MathUtils.degToRad(cam.fov*0.5));
  const out={w,h,exposure:sf.renderer.toneMappingExposure,
    look:sf.pipeline.grade.activeLookId(),
    sunI:sun.intensity,sunC:sun.color.toArray(),spheres:[]};
  for(const s of chart.spheres){
    s.mesh.getWorldPosition(v);
    n.copy(cam.position).sub(v).normalize();
    const ndl=Math.max(0,n.dot(sd)),dist=v.distanceTo(cam.position);
    v.project(cam);
    out.spheres.push({albedo:s.albedo,ndl,
      cx:(v.x*0.5+0.5)*w,cy:(-v.y*0.5+0.5)*h,
      pr:Math.max(4,chart.radius/dist*f*0.72)});
  }
  return out;})()`;

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

  await page.evaluate((cards) => {
    window.__sfManual(true);
    window.__sf.sky.cycleEnabled = false;
    window.__sf.sky.realTime = false;
    if (cards) window.__sf.RENDER_TUNING.values.greyCards = true;
  }, CARDS);

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
   * It also cost the first grey-card plate of every run: the chart is posed by
   * main's tick, so with no real frame between enabling it and shooting, the
   * sampler read sky instead of spheres.
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

  /**
   * Refuse to hand back a frozen canvas.
   *
   * Everything else this probe checks reads the SCENE GRAPH, which is exactly
   * why a stale plate slips through: the sun elevation and camera heading are
   * already correct while the pixels are minutes old. The one signal that comes
   * from the pixels is that the ocean never stops moving — so two byte-identical
   * screenshots mean rendering is stalled, not that the world is calm.
   *
   * This fires for real. Running the probe while `npm run build` had the machine
   * at load average 70+ stretched compiles past the settle window and produced a
   * confident midday inland plate for a sunset request.
   */
  const settleUntilLive = async (label) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      await settle(attempt === 0 ? 14 : 8);
      const a = await page.screenshot();
      await page.evaluate(() => { for (let i = 0; i < 4; i++) window.__sf.tick(1 / 30); });
      await page.waitForTimeout(200);
      const b = await page.screenshot();
      if (!a.equals(b)) return;
      console.log(`[cmp]   canvas frozen (${label}), attempt ${attempt + 1} — settling further`);
    }
    throw new Error(
      `canvas never advanced for ${label}: the renderer is holding frames (a compile in ` +
      `flight, or the machine is loaded). The plate would be stale — refusing to write it.`
    );
  };

  // Clean plate: Tab fades the HUD. It is read via input.pressed("Tab") inside
  // the frame body, so in manual mode the press lands on the NEXT tick.
  await page.keyboard.press("Tab");
  await settle(8);
  await page.waitForTimeout(1_200); // the HUD fade is a CSS transition

  if (LUTSIZE) {
    await page.evaluate((n) => window.__sf.pipeline.grade.setLutSize(n), LUTSIZE);
    console.log("[cmp] LUT re-baked at", LUTSIZE);
    await settle(4);
  }

  // Prime on the first target and throw the result away. Two things are not
  // ready on a cold first plate: the chase boom is still easing from the spawn
  // heading toward the sun, and — with SF_GREYCARDS — the calibration chart has
  // not been posed yet, because main's tick is what poses it. Both failures are
  // silent: the plate looks like a normal screenshot and the card sampler
  // happily reads sand and sky, which is how the first look of a run came back
  // two stops brighter than every other look in the same sweep.
  await page.evaluate((tod) => window.__sf.sky.setTimeOfDay(tod), TIMES[0]);
  await settleUntilLive("prime");
  console.log("[cmp] primed");

  for (const time of TIMES) {
    for (const look of LOOKS) {
      await page.evaluate(({ tod, lookId }) => {
        const sf = window.__sf;
        sf.pipeline.grade.setLook(lookId);
        sf.sky.setTimeOfDay(tod);
      }, { tod: time, lookId: look });
      await settleUntilLive(`${look} @ t=${time}`);

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
      const buf = await page.screenshot({ path: file });
      written.push(file);
      console.log(`[cmp] ${name}  ${JSON.stringify(info)}`);

      if (LUTAB) {
        // Fidelity check: re-bake at a near-truth edge length and shoot the SAME
        // world state again. It has to be the same session — comparing two runs
        // measures wave phase and avatar randomisation, not the LUT (measured:
        // 35% of pixels differing by >2 code values, all of it scene motion).
        // Even here the water moves slightly between the two frames, so diff the
        // sky band, which is static at dusk.
        await page.evaluate((n) => window.__sf.pipeline.grade.setLutSize(n), LUTAB);
        await settle(2);
        const abFile = path.join(OUT, `${TAG}${look}_t${String(time).replace(".", "-")}_lut${LUTAB}.png`);
        await page.screenshot({ path: abFile });
        written.push(abFile);
        console.log(`[cmp]   + LUT ${LUTAB} reference plate`);
        await page.evaluate((n) => window.__sf.pipeline.grade.setLutSize(n), GRADE_LUT_SIZE);
        await settle(2);
      }

      if (CARDS) {
        // Measure the RENDERED grey cards. The point is not the absolute number
        // but where the 18% card sits relative to photographic neutral (0.18
        // display-linear) — that is the one reading the whole light rig is
        // calibrated against, and the one a tone-curve change moves.
        const geom = await page.evaluate(GEOM_EXPR);
        const png = decodePng(buf);
        const scale = png.w / geom.w;
        const lk = findLook(geom.look);
        console.log("   albedo | sunlit sRGB (sun-only pred) | centre sRGB");
        for (const s of geom.spheres) {
          const m = sampleDisc(png, s.cx * scale, s.cy * scale, s.pr * scale);
          const rad = geom.sunC.map((c) => (c * geom.sunI * 1 * s.albedo * geom.exposure) / Math.PI);
          const pred = evaluateLook(lk, rad[0], rad[1], rad[2]);
          console.log(
            `   ${(s.albedo * 100).toFixed(0).padStart(5)}% |  ${lum(m.max).toFixed(3)} (${lum(pred).toFixed(3)})` +
              `              |  ${lum(m.center).toFixed(3)}`
          );
        }
        const grey = geom.spheres.find((s) => Math.abs(s.albedo - 0.18) < 1e-6);
        if (grey) {
          const m = sampleDisc(png, grey.cx * scale, grey.cy * scale, grey.pr * scale);
          const dl = lum(m.max.map(srgbDecode));
          const stops = Math.log2(Math.max(dl, 1e-5) / 0.18);
          console.log(
            `   18% grey sunlit spot: display-linear ${dl.toFixed(3)} → ` +
              `${stops >= 0 ? "+" : ""}${stops.toFixed(2)} stops vs photographic neutral`
          );
        }
      }
    }
  }
  if (pageErrors.length) console.log("[cmp] pageErrors:\n" + pageErrors.join("\n"));
} finally {
  await browser.close();
}
console.log(`[cmp] wrote ${written.length} plates to ${OUT}`);
