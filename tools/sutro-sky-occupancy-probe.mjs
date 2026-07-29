// What is in the sky from the Sutro deck?
//
//   SF_PROBE_URL=http://localhost:61335 node tools/sutro-sky-occupancy-probe.mjs
//
// The floating shapes have been guessed at three times now (grass, sliced
// ridges, foliage). This stops guessing: from several deck viewpoints it casts a
// grid of rays across the UPPER half of the frame and names every object each
// one strikes. Anything the rays hit above the horizon IS the artifact, whatever
// it turns out to be — no pose matching, no interpretation of a JPEG.
//
// Hits are grouped by ancestor chain and reported with screen position, distance
// and world height, so a shape can be traced to the system that owns it.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:61335").replace(/\/$/, "");
const OUT = path.resolve(ROOT, ".data/sutro-sky");
const VIEWPORT = { width: 1920, height: 1080 };

const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const localPoint = (x, y, z) => {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
};

const PLAYER_STAND = localPoint(-7, 6.2, 0);

/** Deck seats looking out over the water, the way the screenshots were taken. */
const VIEWS = [
  { name: "A-sw-ocean", eye: localPoint(-32, 7.6, 10), dir: [-0.75, 0.02, 0.66] },
  { name: "B-w-ocean", eye: localPoint(-32, 7.6, 10), dir: [-1.0, 0.03, 0.0] },
  { name: "C-s-coast", eye: localPoint(-30, 7.6, 40), dir: [-0.3, 0.02, 0.95] },
  { name: "D-se-ridges", eye: localPoint(-28, 7.6, 40), dir: [0.35, 0.05, 0.94] },
  { name: "E-nw-landsend", eye: localPoint(-32, 7.6, -20), dir: [-0.85, 0.03, -0.52] }
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

/** Cast a grid over the upper 55% of the frame and name every hit. */
const gridExpression = `(() => {
  const sf = window.__sf;
  const THREE = sf.THREE;
  const cam = sf.camera;
  const ray = new THREE.Raycaster();
  ray.far = 30000;
  ray.camera = cam;
  const visibleUp = (o) => { let n = o; while (n) { if (!n.visible) return false; n = n.parent; } return true; };
  const chain = (o) => {
    const names = []; let n = o;
    while (n && names.length < 6) { names.push(n.name || "(" + n.type + ")"); n = n.parent; }
    return names.join(" < ");
  };
  const groups = new Map();
  const COLS = 48, ROWS = 22;
  let tested = 0, hits = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const px = (c + 0.5) / COLS;
      const py = (r + 0.5) / ROWS * 0.55; // upper 55% only — the sky band
      tested++;
      ray.setFromCamera(new THREE.Vector2(px * 2 - 1, -(py * 2 - 1)), cam);
      let first = null;
      try {
        first = ray.intersectObjects(sf.scene.children, true).filter((h) => visibleUp(h.object))[0] ?? null;
      } catch (e) { continue; }
      if (!first) continue;
      hits++;
      const key = chain(first.object);
      const e = groups.get(key) ?? { key, count: 0, minD: Infinity, maxD: -Infinity, minY: Infinity, maxY: -Infinity, sample: null };
      e.count++;
      e.minD = Math.min(e.minD, first.distance);
      e.maxD = Math.max(e.maxD, first.distance);
      e.minY = Math.min(e.minY, first.point.y);
      e.maxY = Math.max(e.maxY, first.point.y);
      if (!e.sample) e.sample = { px: Math.round(px * 1920), py: Math.round(py * 1080), at: [Math.round(first.point.x), Number(first.point.y.toFixed(1)), Math.round(first.point.z)] };
      groups.set(key, e);
    }
  }
  const round = (v) => Number(v.toFixed(1));
  return {
    tested, hits,
    groups: [...groups.values()]
      .map((e) => ({ key: e.key, rays: e.count, dist: [round(e.minD), round(e.maxD)], y: [round(e.minY), round(e.maxY)], sample: e.sample }))
      .sort((a, b) => b.rays - a.rays)
  };
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
  const report = { baseUrl: BASE_URL, views: {} };
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

    const canvas = page.locator("canvas").first();
    for (const v of VIEWS) {
      const target = [v.eye[0] + v.dir[0] * 600, v.eye[1] + v.dir[1] * 600, v.eye[2] + v.dir[2] * 600];
      await page.evaluate(([eye, t]) => window.__sfFreeCam(eye, t), [v.eye, target]);
      await page.waitForTimeout(2600);
      await canvas.screenshot({ path: path.join(OUT, `${v.name}.png`) });
      const grid = await page.evaluate(gridExpression);
      report.views[v.name] = { eye: v.eye, dir: v.dir, ...grid };
      process.stdout.write(`\n=== ${v.name} — ${grid.hits}/${grid.tested} sky rays hit something ===\n`);
      for (const g of grid.groups.slice(0, 12)) {
        process.stdout.write(
          `  ${String(g.rays).padStart(4)} rays  d[${g.dist}]  y[${g.y}]  @${JSON.stringify(g.sample?.at)}\n      ${g.key}\n`
        );
      }
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
