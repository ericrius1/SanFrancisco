// A/B the marine-layer ceiling against the ridgelines it is slicing.
//
//   SF_PROBE_URL=http://localhost:56012 node tools/sutro-fogtop-sweep.mjs
//
// From the Sutro deck the hills south-east of the basin crest at 100-107 m
// (measured: tools/sutro-terrain-truth-probe.mjs) while the fog layer tops out
// at 95 m with only ~4 m of ceiling noise. The layer therefore guillotines those
// ridges a few metres below their summits and leaves the tops floating in clear
// air with no visible slope under them.
//
// This holds one pose and sweeps fogTop / fogNoise so the artifact can be seen
// appearing and disappearing rather than argued about. Shots land in
// .data/sutro-fogtop/.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:56012").replace(/\/$/, "");
const OUT = path.resolve(ROOT, ".data/sutro-fogtop");
const VIEWPORT = { width: 1920, height: 1080 };

const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const localPoint = (x, y, z) => {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
};

const PLAYER_STAND = localPoint(-7, 6.2, 0);
// On the deck at the ocean glass, looking south-east down the coast — the
// heading in the user's screenshot, where the sliced ridges sit.
const EYE = localPoint(-30, 7.6, 30);
const TARGET = localPoint(120, 60, 420);

const CASES = [
  { name: "00-baseline-top95", fogTop: 95, fogNoise: 0.2 },
  { name: "01-top130", fogTop: 130, fogNoise: 0.2 },
  { name: "02-top160", fogTop: 160, fogNoise: 0.2 },
  { name: "03-top200", fogTop: 200, fogNoise: 0.2 },
  { name: "04-top160-noise06", fogTop: 160, fogNoise: 0.6 },
  { name: "05-top160-noise10", fogTop: 160, fogNoise: 1.0 },
  { name: "06-fog-off", fogTop: 95, fogNoise: 0.2, fogEnabled: false }
];

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

async function waitHttp(url, timeoutMs = 90_000) {
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

  const report = { baseUrl: BASE_URL, eye: EYE, target: TARGET, cases: {} };
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
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
      window.__sf.camera.fov = 70;
      window.__sf.camera.updateProjectionMatrix();
    });
    await page.evaluate(([eye, target]) => window.__sfFreeCam(eye, target), [EYE, TARGET]);
    await page.waitForTimeout(2500);

    const canvas = page.locator("canvas").first();
    for (const c of CASES) {
      await page.evaluate((cfg) => {
        const t = window.__sf.WORLD_TUNING.values;
        t.fogTop = cfg.fogTop;
        t.fogNoise = cfg.fogNoise;
        t.fogEnabled = cfg.fogEnabled !== false;
      }, c);
      await page.waitForTimeout(2600);
      const file = path.join(OUT, `${c.name}.png`);
      await canvas.screenshot({ path: file });
      report.cases[c.name] = {
        ...c,
        file,
        resolved: await page.evaluate(() => ({
          fogTop: window.__sf.WORLD_TUNING.values.fogTop,
          fogNoise: window.__sf.WORLD_TUNING.values.fogNoise,
          fogEnabled: window.__sf.WORLD_TUNING.values.fogEnabled
        }))
      };
      process.stdout.write(`shot ${c.name} (fogTop=${c.fogTop} noise=${c.fogNoise})\n`);
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
