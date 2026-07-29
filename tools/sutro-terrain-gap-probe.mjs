// Is there a hole in the ground around the restored hall?
//
//   SF_PROBE_URL=http://localhost:61335 node tools/sutro-terrain-gap-probe.mjs [label]
//
// The authored region punches a terrain cutout for its own footprints (hall
// 39.05 x 76.45 m, beach-entry 9.5 x 3.45 m, from data/authored-regions.json).
// The clipmap stops drawing inside that rectangle and the authored surface is
// expected to take over. If the authored floor is smaller than the cutout, or
// its feather lands short, the seam opens and you see straight through the world
// at the threshold — which is exactly where a camera standing on the deck looks.
//
// Two instruments:
//   * plan views straight down over the site, where a hole reads instantly
//   * a horizon scan just outside each wall, looking along the ground
// Plus a numeric check: sample groundTop on a ring around the cutout edge and
// flag any sample that returns a hole/sea-level value where land is expected.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:61335").replace(/\/$/, "");
const LABEL = process.argv[2] ?? "current";
const OUT = path.resolve(ROOT, ".data/sutro-gap", LABEL);
const VIEWPORT = { width: 1600, height: 1000 };

const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const localPoint = (x, y, z) => {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
};

const PLAYER_STAND = localPoint(-7, 6.2, 0);

const SHOTS = [
  // Plan views: a hole in the ground is unmistakable from directly above.
  { name: "01-plan-high", eye: localPoint(0, 420, 0), target: localPoint(0, 0, 0.01) },
  { name: "02-plan-west-edge", eye: localPoint(-60, 150, 0), target: localPoint(-40, 5, 0.01) },
  { name: "03-plan-south-edge", eye: localPoint(0, 150, 110), target: localPoint(0, 5, 78) },
  // Ground-level scans just outside each wall, looking along the seam.
  { name: "04-outside-west", eye: localPoint(-58, 8, 0), target: localPoint(-30, 6, 0) },
  { name: "05-outside-south", eye: localPoint(0, 8, 104), target: localPoint(0, 6, 74) },
  { name: "06-outside-north", eye: localPoint(0, 8, -104), target: localPoint(0, 6, -74) },
  { name: "07-deck-look-out", eye: localPoint(-34, 7.4, 0), target: localPoint(-120, 4, 40) }
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
 * Walk outward from the cutout edge and record the rendered walkable surface.
 * groundTop is the surface buildings and feet actually meet, so a seam shows up
 * as a step between the authored floor inside and the terrain outside.
 */
const RING = `(() => {
  const sf = window.__sf;
  const yaw = ${SITE.yaw}, cx = ${SITE.x}, cz = ${SITE.z};
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const toWorld = (lx, lz) => [cx + c * lx + s * lz, cz - s * lx + c * lz];
  const top = (x, z) => {
    try { return Number((sf.map.groundTop ? sf.map.groundTop(x, z) : sf.map.groundHeight(x, z)).toFixed(2)); }
    catch (e) { return "ERR"; }
  };
  const height = (x, z) => { try { return Number(sf.map.groundHeight(x, z).toFixed(2)); } catch (e) { return "ERR"; } };
  const rows = [];
  // Cross-sections through each wall, from 12 m inside to 40 m outside.
  const cuts = [
    { name: "west",  step: (t) => [-39.05 + t, 0] },
    { name: "east",  step: (t) => [ 39.05 - t, 0] },
    { name: "south", step: (t) => [0,  76.45 - t] },
    { name: "north", step: (t) => [0, -76.45 + t] }
  ];
  for (const cut of cuts) {
    const samples = [];
    for (let t = -40; t <= 12; t += 2) {
      const [lx, lz] = cut.step(t);
      const [wx, wz] = toWorld(lx, lz);
      samples.push({ offset: -t, top: top(wx, wz), height: height(wx, wz) });
    }
    rows.push({ cut: cut.name, samples });
  }
  return rows;
})()`;

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
  const report = { baseUrl: BASE_URL, shots: {} };
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: "block" });
    const page = await context.newPage();
    page.on("pageerror", (e) => (report.pageErrors ??= []).push(String(e)));
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

    report.crossSections = await page.evaluate(RING);
    process.stdout.write("\n--- rendered surface across each wall (offset: + = outside) ---\n");
    for (const row of report.crossSections) {
      process.stdout.write(`\n${row.cut}:\n`);
      let prev = null;
      for (const s of row.samples) {
        const jump = prev !== null && typeof s.top === "number" && Math.abs(s.top - prev) > 3 ? "   <== STEP" : "";
        process.stdout.write(`   ${String(s.offset).padStart(4)} m  top ${String(s.top).padStart(7)}  height ${String(s.height).padStart(7)}${jump}\n`);
        if (typeof s.top === "number") prev = s.top;
      }
    }

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
    process.stdout.write(`\nWrote ${OUT}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exitCode = 1;
});
