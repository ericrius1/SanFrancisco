// Fast visual-iteration harness for Sutro Baths look development.
//
// Not a contract test — this exists to put real pixels in front of a human (or
// an agent) quickly while tuning the twilight render. It walks the player onto
// the deck so the out-of-time pocket latches, then locks `__sfFreeCam` to a
// fixed set of eye→target poses so two runs are directly comparable.
//
//   SF_PROBE_URL=http://127.0.0.1:5240 node tools/sutro-look-shot.mjs [label]
//
// Shots land in .data/sutro-look/<label>/. Pass "before" and "after" to keep a
// pair; pass the same label twice to overwrite while iterating on one change.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const LABEL = process.argv[2] ?? "current";
const OUT = path.resolve(ROOT, ".data/sutro-look", LABEL);
const VIEWPORT = { width: 1600, height: 1000 };

// Hall frame, mirrored from tools/sutro-baths-probe.mjs and layout.ts:
// halfWidth 38.7 (local x), halfLength 76.1 (local z), deck 5.62, water 5.18,
// roof apex 43.5. The great plunge is local x -31..-10, z -55..29.
const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const localPoint = (x, y, z) => {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
};

/** Deck walkway between the great plunge and the graduated baths — well inside
 *  every wall, so the pocket latches and stays latched. */
const PLAYER_STAND = localPoint(-7, 6.2, 0);

/**
 * Poses chosen to interrogate one thing each, so a regression is attributable.
 */
const SHOTS = [
  {
    // The money shot for sky reflection: a low look down the length of the
    // great plunge (local x -31..-10, z -55..29) puts fresnel near 1, so the
    // water should mirror the twilight. The eye has to sit INSIDE the pool
    // footprint and above the 5.18 water line — from the deck beyond the south
    // rim the 5.62 deck lip occludes the surface entirely.
    name: "01-plunge-grazing",
    eye: localPoint(-20.5, 7.4, 26),
    target: localPoint(-20.5, 5.2, -45)
  },
  {
    // Straight up into the barrel roof: the thin-member aliasing case, and
    // where upward caustic projection has to read.
    name: "02-truss-canopy",
    eye: localPoint(-20, 8, 10),
    target: localPoint(-14, 43, -25)
  },
  {
    // Wide interior: lamps, deck, pools and roof together — the overall grade.
    name: "03-hall-wide",
    eye: localPoint(33, 12, 60),
    target: localPoint(-15, 12, -20)
  },
  {
    // A west lamp post globe (local -34.2, z 6, 2.45 above deck) close enough
    // that bloom either works or does not.
    name: "04-lamp-close",
    eye: localPoint(-26, 7.2, 16),
    target: localPoint(-34.2, 8.07, 6)
  },
  {
    // Looking back north up the plunge with the open end behind it: the sky
    // gradient and the water together.
    name: "05-plunge-north",
    eye: localPoint(-20, 9, -50),
    target: localPoint(-20, 7, 25)
  }
];

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

async function waitHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return;
    } catch {
      /* server still coming up */
    }
    await sleep(400);
  }
  throw new Error(`Dev server never answered at ${url}`);
}

/**
 * Mean luminance, per-channel spread and a coarse entropy — enough to catch a
 * black or blown-out frame without a human, and enough to show at a glance
 * whether a change moved the image. `clipped` is the bloom guard.
 */
async function audit(file) {
  const image = sharp(file);
  const stats = await image.stats();
  const { width, height } = await image.metadata();
  const channels = stats.channels.slice(0, 3);
  const grey = await image.clone().greyscale().raw().toBuffer();
  const histogram = new Array(256).fill(0);
  for (const value of grey) histogram[value]++;
  const total = grey.length;
  let entropy = 0;
  for (const count of histogram) {
    if (!count) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return {
    width,
    height,
    meanLuma: Number((channels.reduce((sum, c) => sum + c.mean, 0) / 3).toFixed(2)),
    channelMean: channels.map((c) => Number(c.mean.toFixed(2))),
    channelStdDev: channels.map((c) => Number(c.stdev.toFixed(2))),
    entropy: Number(entropy.toFixed(3)),
    clipped: Number((histogram.slice(250).reduce((a, b) => a + b, 0) / total).toFixed(5))
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await waitHttp(BASE_URL);
  const executablePath = await findChrome();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      `--use-angle=${process.env.SF_ANGLE ?? (process.platform === "darwin" ? "metal" : "swiftshader")}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--hide-scrollbars",
      "--mute-audio"
    ]
  });

  const pageErrors = [];
  const consoleErrors = [];
  const results = {};

  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error" && consoleErrors.length < 100) {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1&spawn=sutroBaths`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
    await page.waitForFunction(() => Boolean(window.__sf), null, { timeout: 180_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, {
      timeout: 180_000
    });

    // Stand the player deep inside the hall so the pocket latches. The sky
    // crossfade is wall-clock (~7 s in), and the lamps ramp with it.
    await page.evaluate(([x, y, z]) => {
      const sf = window.__sf;
      sf.player.restoreState({ x, y, z, heading: sf.player.heading, mode: "walk" });
      sf.hud?.setHidden?.(true);
    }, PLAYER_STAND);
    await page.waitForTimeout(9000);

    await page.waitForFunction(
      () => (window.__sf?.sutroBaths?.debugState?.()?.twilight?.skyBlend ?? 0) > 0.98,
      null,
      { timeout: 30_000 }
    ).catch(() => {
      process.stdout.write("WARN: pocket skyBlend never reached 1 — shooting anyway\n");
    });

    const canvas = page.locator("canvas").first();

    for (const shot of SHOTS) {
      await page.evaluate((pose) => {
        window.__sfFreeCam(pose.eye, pose.target);
      }, shot);
      // Two settling concerns: the freecam pose needs a frame, and the steam
      // volume + water animate, so a single frame can catch an atypical one.
      await page.waitForTimeout(1200);
      const file = path.join(OUT, `${shot.name}.png`);
      await canvas.screenshot({ path: file });
      results[shot.name] = { file, ...(await audit(file)) };
      const r = results[shot.name];
      process.stdout.write(
        `${shot.name}: luma ${r.meanLuma} rgb[${r.channelMean}] entropy ${r.entropy} clipped ${r.clipped}\n`
      );
    }

    // ---- pacing, measured rather than glanced at.
    //
    // Sampling `tracer.ema` once at the end of the run is worthless: back-to-back
    // runs of identical code reported 33.1 ms and 16.8 ms, because whatever
    // streaming or shader compile happened to land in the last second dominates
    // a running average. Park on the heaviest pose, let the EMA settle, then
    // take a spread of samples and report the median.
    await page.evaluate((pose) => window.__sfFreeCam(pose.eye, pose.target), SHOTS[0]);
    await page.waitForTimeout(4000);
    const emaSamples = [];
    for (let i = 0; i < 9; i++) {
      emaSamples.push(await page.evaluate(() => window.__sf?.tracer?.ema ?? null));
      await page.waitForTimeout(400);
    }
    const usable = emaSamples.filter((v) => typeof v === "number").sort((a, b) => a - b);
    const medianEmaMs = usable.length ? Number(usable[usable.length >> 1].toFixed(2)) : null;

    await page.evaluate(() => window.__sfFreeCam(null));

    const state = await page.evaluate(() => {
      const sf = window.__sf;
      return {
        sutro: sf?.sutroBaths?.debugState?.() ?? null,
        pixelRatio: sf?.renderer?.getPixelRatio?.() ?? null,
        // Interior quality trade: sample count is the observable half, the
        // frame cap shows up in the EMA above.
        sceneSampleCount: sf?.pipeline?.sceneSampleCount ?? null
      };
    });
    state.medianEmaMs = medianEmaMs;
    state.emaSamples = usable.map((v) => Number(v.toFixed(2)));

    await writeFile(
      path.join(OUT, "report.json"),
      JSON.stringify({ label: LABEL, shots: results, state, pageErrors, consoleErrors }, null, 2)
    );
    if (pageErrors.length) {
      process.stdout.write(`\nPAGE ERRORS (${pageErrors.length}):\n${pageErrors.slice(0, 5).join("\n")}\n`);
    }
    process.stdout.write(
      `\nframe EMA median ${state.medianEmaMs} ms (samples ${state.emaSamples.join(", ")})` +
        ` · scene samples ${state.sceneSampleCount} · wrote ${OUT}\n`
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
