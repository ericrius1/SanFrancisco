// In-engine look at how the boats ride the bay.
//
// The offline probe (boat-buoyancy-physics-probe.mjs) proves the numbers; this
// one proves the picture: it boots the real world, drives each boat into the
// open-bay swell through the scripted-input rail, and captures both telemetry
// (how far the hull travels vertically while under way) and beam-on frames of
// the boat against the waves it is actually riding.
//
// Usage:
//   SF_PROBE_URL=http://localhost:5240 node tools/boat-seakeeping-browser-probe.mjs

import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/boat-seakeeping-probe");
const URL_BASE = (process.env.SF_PROBE_URL ?? "http://localhost:5240").replace(/\/$/, "");
// Open bay north of the city — deep, clear of the surf strip and the lagoon.
const BAY = { x: 2000, z: -2600 };

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean);
  for (const c of candidates) if (await exists(c)) return c;
  throw new Error("Chrome/Chromium not found; set CHROME_BIN");
}

await mkdir(OUT, { recursive: true });
const errors = [];
const browser = await chromium.launch({
  executablePath: await findChrome(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--mute-audio"
  ]
});

let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${URL_BASE}/?autostart=1&fullfps=1`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(() => Boolean(window.__sf?.player), null, { timeout: 120_000 });
  // Wait for the world to stop streaming before hopping to water: enterOnWater
  // reads map.isWater/groundHeight, and against unstreamed tiles it happily
  // "finds" open bay 149 m up a hill.
  await page.waitForFunction(() => window.__sf.renderIdle?.() !== false, null, { timeout: 180_000 });

  // Open bay north of the city: deep water, clear of the Ocean Beach surf strip
  // and the Palace lagoon, so the spectral hero band owns the surface. Go there
  // deliberately — enterOnWater's own scan will happily settle for a hilltop
  // reservoir if that is the nearest water cell to wherever boot dropped us.
  await page.evaluate((b) => window.__sf.rings.focus(b.x, b.z, { reset: true }), BAY);
  // Only place the player once the bay's own terrain tile is real: against a
  // placeholder tile groundHeight lies, and the boat "launches" onto a hill.
  await page.waitForFunction(
    (b) => {
      const s = window.__sf;
      return s.map.isTileRealAt(b.x, b.z) && s.map.groundHeight(b.x, b.z) < -3 && s.map.isWater(b.x, b.z);
    },
    BAY,
    { timeout: 180_000 }
  );
  await page.evaluate((b) => window.__sf.player.respawn({ x: b.x, z: b.z, heading: Math.PI / 2 }), BAY);
  await page.waitForTimeout(3000);

  for (const mode of ["boat", "speedboat"]) {
    // Throttle comes from the first-class scripted-input rail (core/input
    // InputDriver) — the channel cinematics use, which every controller reads
    // exactly as it reads a held key.
    await page.evaluate((m) => {
      const s = window.__sf;
      if (s.player.mode !== m) s.player.trySwitch(m);
      s.input.suspended = false;
      s.input.setDriver({ update: (_dt, c) => c.hold("KeyW") });
    }, mode);
    // Drive on the wall clock first so the world streams in around wherever the
    // hop landed, then take the clock for deterministic sampling.
    await page.waitForTimeout(9000);
    await page.evaluate(() => window.__sfManual(true));

    const run = await page.evaluate(() => {
      const s = window.__sf;
      const p = s.player;
      const start = { x: p.position.x, z: p.position.z };
      let lo = Infinity;
      let hi = -Infinity;
      let speedSum = 0;
      const steps = 60 * 20;
      for (let i = 0; i < steps; i++) {
        s.tick(1 / 60);
        lo = Math.min(lo, p.position.y);
        hi = Math.max(hi, p.position.y);
        speedSum += Math.hypot(p.velocity.x, p.velocity.z);
      }
      return {
        mode: p.mode,
        moved: Math.hypot(p.position.x - start.x, p.position.z - start.z),
        speed: speedSum / steps,
        heave: hi - lo,
        ground: s.map.groundHeight(p.position.x, p.position.z)
      };
    });
    console.log(
      `${mode}: ran ${run.moved.toFixed(0)} m at ${run.speed.toFixed(1)} m/s over ${run.ground.toFixed(0)} m of water, ` +
        `hull rose and fell through ${run.heave.toFixed(2)} m`
    );
    if (run.mode !== mode) {
      console.error(`  ✗ never entered ${mode} mode`);
      failed = true;
    }
    if (run.moved < 50) {
      console.error(`  ✗ ${mode} barely moved (${run.moved.toFixed(0)} m) — stuck, beached, or no throttle?`);
      failed = true;
    }
    if (run.heave < 0.5) {
      console.error(`  ✗ ${mode} hardly rose or fell (${run.heave.toFixed(2)} m) — is it riding the swell?`);
      failed = true;
    }

    // Hand the clock back so the world catches up at the new position, then
    // capture: beam-on (the hull against its wave) and the driver's chase view.
    await page.evaluate(() => window.__sfManual(false));
    await page.waitForTimeout(6000);
    const pos = await page.evaluate(() => {
      const p = window.__sf.player.renderPosition;
      return [p.x, p.y, p.z];
    });
    await page.evaluate((q) => window.__sfFreeCam([q[0] + 15, q[1] + 3, q[2] + 9], [q[0], q[1] + 0.2, q[2]]), pos);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `${mode}-abeam.png`) });
    await page.evaluate(() => window.__sfFreeCam(null));
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `${mode}-chase.png`) });
    await page.evaluate(() => window.__sf.input.setDriver(null));
  }

  if (errors.length) {
    console.error(`\npage errors:\n${errors.map((e) => `  ${e}`).join("\n")}`);
    failed = true;
  }
} finally {
  await browser.close();
}

if (failed) {
  console.error("\nboat sea-keeping browser probe: FAILED");
  process.exit(1);
}
console.log(`\nboat sea-keeping browser probe: frames in ${path.relative(ROOT, OUT)}`);
