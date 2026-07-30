// Does the terrain actually draw where the buildings appear to float?
//
//   SF_PROBE_URL=http://localhost:61335 node tools/sutro-terrain-coverage-probe.mjs
//
// Raycasting cannot answer this: the clipmap is GPU-displaced, so its CPU
// geometry is a flat y=0 grid and every ray reports 0 no matter what renders.
// So instead of asking the geometry, ask the framebuffer — capture the frame,
// hide one root, capture again, and diff. Every pixel that changed is a pixel
// that root was painting. That is a direct coverage map with no compile, no
// material swap and no dependence on the tunables/localStorage schema.
//
// Run per root: terrainClipmap, then the ocean, then the citygen chunks. If the
// horizon band changes when the clipmap is hidden, terrain IS being drawn there
// and the artifact is contrast/haze. If it does not, the terrain is genuinely
// absent and the streaming path is at fault.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:61335").replace(/\/$/, "");
const OUT = path.resolve(ROOT, ".data/sutro-coverage");
const VIEWPORT = { width: 1920, height: 1080 };

const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const localPoint = (x, y, z) => {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
};

const PLAYER_STAND = localPoint(-7, 6.2, 0);
// The south-east seat, where the floating chunks are plainly visible.
const EYE = localPoint(-28, 7.6, 40);
const DIR = [0.35, 0.05, 0.94];

/** Roots to isolate, in order. Names are matched against scene children. */
const ROOTS = ["terrainClipmap", "__water__", "__citygen__"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  for (const c of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    try {
      await access(c);
      return c;
    } catch {
      /* keep looking */
    }
  }
  throw new Error("No Chrome/Chromium found; set CHROME_BIN.");
}

async function waitHttp(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* still coming up */
    }
    await sleep(400);
  }
  throw new Error(`Dev server never answered at ${url}`);
}

/**
 * Diff two frames and report, per horizontal band, what fraction of pixels
 * changed. Banding by row is what matters here: the question is whether the
 * thin strip just above the sea horizon is painted by terrain.
 */
async function bandDiff(fileA, fileB, bands = 24) {
  const a = await sharp(fileA).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(fileB).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = a.info;
  const rows = new Array(bands).fill(0);
  const totals = new Array(bands).fill(0);
  for (let y = 0; y < height; y++) {
    const band = Math.min(bands - 1, Math.floor((y / height) * bands));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const d =
        Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]);
      totals[band]++;
      if (d > 12) rows[band]++;
    }
  }
  return rows.map((changed, i) => ({
    band: i,
    yFrom: Math.round((i / bands) * height),
    yTo: Math.round(((i + 1) / bands) * height),
    changedPct: Number(((changed / totals[i]) * 100).toFixed(2))
  }));
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await waitHttp(BASE_URL);
  const browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      `--use-angle=${process.env.SF_ANGLE ?? "metal"}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--hide-scrollbars",
      "--mute-audio"
    ]
  });

  const report = { baseUrl: BASE_URL, eye: EYE, dir: DIR, roots: {} };
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=sutroBaths`, {
      waitUntil: "domcontentloaded",
      timeout: 180_000
    });
    await page.waitForFunction(() => Boolean(window.__sf), null, { timeout: 240_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 240_000 });
    await page.evaluate(([x, y, z]) => {
      const sf = window.__sf;
      sf.player.restoreState({ x, y, z, heading: sf.player.heading, mode: "walk" });
      sf.hud?.setHidden?.(true);
    }, PLAYER_STAND);
    await page.waitForTimeout(13_000);

    await page.evaluate(() => {
      window.__sf.camera.fov = 75;
      window.__sf.camera.updateProjectionMatrix();
    });
    await page.evaluate(
      ([eye, dir]) => window.__sfFreeCam(eye, [eye[0] + dir[0] * 600, eye[1] + dir[1] * 600, eye[2] + dir[2] * 600]),
      [EYE, DIR]
    );
    await page.waitForTimeout(3000);

    // Inventory what we can actually toggle, so a name miss is visible.
    report.sceneRoots = await page.evaluate(() =>
      window.__sf.scene.children
        .filter((c) => c.visible && c.name)
        .map((c) => c.name)
        .slice(0, 200)
    );

    const canvas = page.locator("canvas").first();
    const base = path.join(OUT, "00-base.png");
    await canvas.screenshot({ path: base });

    for (const root of ROOTS) {
      const hidden = await page.evaluate((name) => {
        const sf = window.__sf;
        const match = (c) => {
          if (name === "__water__") return /water|ocean/i.test(c.name) && !/kite|echo/i.test(c.name);
          if (name === "__citygen__") return c.name.startsWith("cityGen");
          return c.name === name;
        };
        const hit = sf.scene.children.filter((c) => c.visible && c.name && match(c));
        for (const c of hit) c.visible = false;
        return hit.map((c) => c.name);
      }, root);

      await page.waitForTimeout(2200);
      const file = path.join(OUT, `off-${root.replace(/_/g, "")}.png`);
      await canvas.screenshot({ path: file });
      const bands = await bandDiff(base, file);
      report.roots[root] = { hidden, file, bands };

      process.stdout.write(`\n=== hid ${root} -> ${JSON.stringify(hidden)} ===\n`);
      for (const b of bands) {
        if (b.changedPct < 0.5) continue;
        process.stdout.write(`  rows ${String(b.yFrom).padStart(4)}-${String(b.yTo).padStart(4)}: ${b.changedPct}% changed\n`);
      }

      // Restore before the next isolation so effects do not compound.
      await page.evaluate((names) => {
        const sf = window.__sf;
        for (const c of sf.scene.children) if (names.includes(c.name)) c.visible = true;
      }, hidden);
      await page.waitForTimeout(1200);
    }

    await writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`\nWrote ${OUT}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exitCode = 1;
});
