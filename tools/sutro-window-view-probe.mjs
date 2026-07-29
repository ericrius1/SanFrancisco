// Sutro Baths window-view probe: the ocean-facing look the user screenshotted.
//
// Stands the player inside the hall so the 1896 pocket latches, then sweeps
// free-cam poses from just inside the west (ocean) glass across south → west →
// north-west, so distant-terrain and distant-city artifacts in the sky are
// captured at full resolution and can be attributed to a heading.
//
//   SF_PROBE_URL=http://127.0.0.1:54905 node tools/sutro-window-view-probe.mjs [label]
//
// Shots land in .data/sutro-window/<label>/.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:54905").replace(/\/$/, "");
const LABEL = process.argv[2] ?? "current";
const OUT = path.resolve(ROOT, ".data/sutro-window", LABEL);
const VIEWPORT = { width: 1920, height: 1080 };

const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const localPoint = (x, y, z) => {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
};

const PLAYER_STAND = localPoint(-7, 6.2, 0);

// Eye just inside the west glass, deck height + standing eye.
const EYE = localPoint(-34, 7.4, 8);

/** Look directions swept in world space from the same eye, 300 m out. */
const HEADINGS = [
  { name: "01-sw-ocean", dx: -0.75, dy: -0.06, dz: 0.66 },
  { name: "02-s-shoreline", dx: -0.25, dy: -0.05, dz: 0.97 },
  { name: "03-w-open-ocean", dx: -1.0, dy: -0.04, dz: 0.0 },
  { name: "04-sw-high", dx: -0.75, dy: 0.12, dz: 0.66 },
  { name: "05-s-high", dx: -0.3, dy: 0.14, dz: 0.95 },
  { name: "06-nw-lands-end", dx: -0.85, dy: 0.02, dz: -0.53 }
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

async function waitHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return;
    } catch {
      /* still coming up */
    }
    await sleep(400);
  }
  throw new Error(`Dev server never answered at ${url}`);
}

async function audit(file) {
  const image = sharp(file);
  const stats = await image.stats();
  const { width, height } = await image.metadata();
  const channels = stats.channels.slice(0, 3);
  return {
    width,
    height,
    meanLuma: Number((channels.reduce((sum, c) => sum + c.mean, 0) / 3).toFixed(2))
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

    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=sutroBaths`, {
      waitUntil: "domcontentloaded",
      timeout: 180_000
    });
    await page.waitForFunction(() => Boolean(window.__sf), null, { timeout: 240_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, {
      timeout: 240_000
    });

    await page.evaluate(([x, y, z]) => {
      const sf = window.__sf;
      sf.player.restoreState({ x, y, z, heading: sf.player.heading, mode: "walk" });
      sf.hud?.setHidden?.(true);
    }, PLAYER_STAND);
    await page.waitForTimeout(11_000);

    await page
      .waitForFunction(
        () => (window.__sf?.sutroBaths?.debugState?.()?.twilight?.skyBlend ?? 0) > 0.98,
        null,
        { timeout: 40_000 }
      )
      .catch(() => process.stdout.write("WARN: pocket skyBlend never reached 1\n"));

    const canvas = page.locator("canvas").first();

    for (const shot of HEADINGS) {
      const target = [EYE[0] + shot.dx * 400, EYE[1] + shot.dy * 400, EYE[2] + shot.dz * 400];
      await page.evaluate(
        ([eye, look]) => {
          window.__sfFreeCam(eye, look);
        },
        [EYE, target]
      );
      await page.waitForTimeout(2500);
      const file = path.join(OUT, `${shot.name}.png`);
      await canvas.screenshot({ path: file });
      results[shot.name] = { file, target, ...(await audit(file)) };
      process.stdout.write(`${shot.name}: luma ${results[shot.name].meanLuma}\n`);
    }

    const debug = await page.evaluate(() => {
      const sf = window.__sf;
      return {
        sutro: sf?.sutroBaths?.debugState?.() ?? null,
        camera: sf?.camera
          ? { x: sf.camera.position.x, y: sf.camera.position.y, z: sf.camera.position.z }
          : null,
        keys: Object.keys(sf ?? {})
      };
    });

    await writeFile(
      path.join(OUT, "report.json"),
      JSON.stringify({ baseUrl: BASE_URL, eye: EYE, results, debug, pageErrors, consoleErrors }, null, 2)
    );
    process.stdout.write(`\nWrote ${OUT}\n`);
    if (pageErrors.length) process.stdout.write(`pageErrors: ${pageErrors.length}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
