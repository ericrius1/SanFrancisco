// Photograph the timber gallery wall, so a change to the hang is reviewed as
// pixels rather than as a diff of plate names.
//
//   SF_PROBE_URL=http://localhost:59706 node tools/sutro-wall-shot.mjs [label]
//
// Three passes down the inland wall from out over the water, plus one close
// three-quarter view, land in .data/sutro-wall/<label>/.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:59706").replace(/\/$/, "");
const LABEL = process.argv[2] ?? "current";
const OUT = path.resolve(ROOT, ".data/sutro-wall", LABEL);
const VIEWPORT = { width: 1920, height: 1080 };

const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const localPoint = (x, y, z) => {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
};

const PLAYER_STAND = localPoint(-7, 6.2, 0);

// The pictures hang on the INLAND wall (local +x). Stand out over the water and
// look back at it, which is how a visitor on the deck actually sees the hang.
const SHOTS = [
  { name: "01-wall-north", eye: localPoint(-26, 16, -46), target: localPoint(34, 13, -30) },
  { name: "02-wall-centre", eye: localPoint(-26, 16, 4), target: localPoint(34, 13, 12) },
  { name: "03-wall-south", eye: localPoint(-26, 16, 52), target: localPoint(34, 13, 60) },
  { name: "04-wall-raking", eye: localPoint(-12, 12, -60), target: localPoint(30, 14, 40) },
  { name: "05-plates-close", eye: localPoint(6, 12, 6), target: localPoint(34, 13, 14) }
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

  const report = { baseUrl: BASE_URL, shots: {}, pageErrors: [], consoleErrors: [] };
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.pageErrors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error" && report.consoleErrors.length < 40) report.consoleErrors.push(m.text());
    });

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

    // Every plate texture must be resident before the first frame is kept, or a
    // shot records the loading state rather than the hang.
    const textures = await page.evaluate(async () => {
      const found = new Set();
      window.__sf.scene.traverse((o) => {
        const map = o.material?.map;
        if (map?.userData?.src) found.add(map.userData.src);
        else if (map?.image?.currentSrc) found.add(map.image.currentSrc);
        else if (map?.source?.data?.currentSrc) found.add(map.source.data.currentSrc);
      });
      return [...found].filter((s) => s.includes("/sutro/art/")).sort();
    });
    report.plateTextures = textures;
    process.stdout.write(`plate textures resident: ${textures.length}\n`);

    const canvas = page.locator("canvas").first();
    for (const shot of SHOTS) {
      await page.evaluate(([eye, target]) => window.__sfFreeCam(eye, target), [shot.eye, shot.target]);
      await page.waitForTimeout(2600);
      const file = path.join(OUT, `${shot.name}.png`);
      await canvas.screenshot({ path: file });
      report.shots[shot.name] = { eye: shot.eye, target: shot.target, file };
      process.stdout.write(`shot ${shot.name}\n`);
    }

    await writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`\nWrote ${OUT}\npageErrors: ${report.pageErrors.length}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exitCode = 1;
});
