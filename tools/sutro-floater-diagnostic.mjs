// Attribution probe for the "floating hills and buildings" seen from inside the
// Sutro Baths hall looking south/west over the Pacific.
//
// Two jobs:
//   1. Reproduce the artifact at several vantages and pocket states, at wide FOV.
//   2. Walk the live scene graph and report every VISIBLE object whose world
//      bounding box sits out over the ocean and/or high in the air, so a shape in
//      the sky can be attributed to a named node instead of guessed at.
//
//   SF_PROBE_URL=http://localhost:54905 node tools/sutro-floater-diagnostic.mjs [label]

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:54905").replace(/\/$/, "");
const LABEL = process.argv[2] ?? "current";
const OUT = path.resolve(ROOT, ".data/sutro-floaters", LABEL);
const VIEWPORT = { width: 1920, height: 1080 };

const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const localPoint = (x, y, z) => {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
};

const PLAYER_STAND = localPoint(-7, 6.2, 0);

const SHOTS = [
  { name: "01-deck-south-wide", eye: localPoint(-30, 7.6, 40), dir: [-0.35, 0.02, 0.94] },
  { name: "02-deck-southwest", eye: localPoint(-30, 7.6, 30), dir: [-0.72, 0.03, 0.69] },
  { name: "03-south-end-open", eye: localPoint(-20, 9, 70), dir: [-0.3, 0.03, 0.95] },
  { name: "04-above-roof-south", eye: localPoint(-20, 60, 40), dir: [-0.3, -0.02, 0.95] },
  { name: "05-above-roof-southwest", eye: localPoint(-20, 60, 40), dir: [-0.8, -0.02, 0.6] },
  { name: "06-far-out-to-sea", eye: [SITE.x - 900, 60, SITE.z + 900], dir: [0.6, 0.0, -0.8] }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean);
  for (const c of candidates) {
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
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* still coming up */
    }
    await sleep(400);
  }
  throw new Error(`Dev server never answered at ${url}`);
}

/**
 * Scene-graph sweep. Reports visible renderables whose world AABB is either far
 * from the site or elevated, grouped by an "identity" string built from the
 * node/material/geometry names so a mystery shape maps back to source.
 */
const SWEEP = `(() => {
  const THREE = window.__sf.THREE;
  const scene = window.__sf.scene;
  const cam = window.__sf.camera;
  const site = { x: ${SITE.x}, z: ${SITE.z} };
  const groups = new Map();
  const box = new THREE.Box3();

  const visibleUp = (o) => {
    let n = o;
    while (n) { if (!n.visible) return false; n = n.parent; }
    return true;
  };

  scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isBatchedMesh && !o.isPoints && !o.isLine && !o.isSprite) return;
    if (!visibleUp(o)) return;
    let b;
    try {
      box.setFromObject(o, true);
      if (!isFinite(box.min.x) || box.isEmpty()) return;
      b = {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z]
      };
    } catch { return; }
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const dist = Math.hypot(cx - site.x, cz - site.z);
    const spanY = b.max[1] - b.min[1];
    // Interesting = out past the hall AND (elevated base OR reaching high).
    const elevated = b.min[1] > 12;
    const tall = b.max[1] > 45;
    const overOcean = cx < site.x - 250;
    if (dist < 220) return;
    if (!elevated && !tall && !overOcean) return;

    const names = [];
    let n = o;
    for (let i = 0; i < 5 && n; i++) { if (n.name) names.push(n.name); n = n.parent; }
    const key = [
      o.type,
      names.join("<") || "(unnamed)",
      o.geometry?.type ?? "",
      o.material?.name ?? (Array.isArray(o.material) ? "multi" : o.material?.type ?? "")
    ].join(" | ");

    const entry = groups.get(key) ?? {
      key, count: 0, instances: 0,
      minY: Infinity, maxY: -Infinity, minDist: Infinity, maxDist: -Infinity,
      minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
      frustum: 0
    };
    entry.count++;
    entry.instances += o.isInstancedMesh ? o.count : (o.isBatchedMesh ? (o.instanceCount ?? 1) : 1);
    entry.minY = Math.min(entry.minY, b.min[1]);
    entry.maxY = Math.max(entry.maxY, b.max[1]);
    entry.minDist = Math.min(entry.minDist, dist);
    entry.maxDist = Math.max(entry.maxDist, dist);
    entry.minX = Math.min(entry.minX, b.min[0]);
    entry.maxX = Math.max(entry.maxX, b.max[0]);
    entry.minZ = Math.min(entry.minZ, b.min[2]);
    entry.maxZ = Math.max(entry.maxZ, b.max[2]);
    groups.set(key, entry);
  });

  const round = (v) => Number(v.toFixed(1));
  return [...groups.values()]
    .map((e) => ({
      key: e.key, nodes: e.count, instances: e.instances,
      y: [round(e.minY), round(e.maxY)],
      dist: [round(e.minDist), round(e.maxDist)],
      x: [round(e.minX), round(e.maxX)],
      z: [round(e.minZ), round(e.maxZ)]
    }))
    .sort((a, b) => b.y[0] - a.y[0]);
})()`;

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
      if (m.type() === "error" && report.consoleErrors.length < 60) report.consoleErrors.push(m.text());
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
    await page.waitForTimeout(12_000);

    // Widen the lens so the whole vista is in frame like the user's screenshot.
    await page.evaluate(() => {
      const cam = window.__sf.camera;
      cam.fov = 75;
      cam.updateProjectionMatrix();
    });

    report.twilight = await page.evaluate(() => window.__sf?.sutroBaths?.debugState?.()?.twilight ?? null);

    const canvas = page.locator("canvas").first();
    for (const shot of SHOTS) {
      const target = [
        shot.eye[0] + shot.dir[0] * 500,
        shot.eye[1] + shot.dir[1] * 500,
        shot.eye[2] + shot.dir[2] * 500
      ];
      await page.evaluate(([eye, look]) => window.__sfFreeCam(eye, look), [shot.eye, target]);
      await page.waitForTimeout(3000);
      const file = path.join(OUT, `${shot.name}.png`);
      await canvas.screenshot({ path: file });
      report.shots[shot.name] = { eye: shot.eye, target };
      process.stdout.write(`shot ${shot.name}\n`);
    }

    // Sweep from a vantage that has everything streamed in.
    await page.evaluate(([eye, look]) => window.__sfFreeCam(eye, look), [
      SHOTS[0].eye,
      [SHOTS[0].eye[0] - 175, SHOTS[0].eye[1] + 10, SHOTS[0].eye[2] + 470]
    ]);
    await page.waitForTimeout(4000);
    report.floaters = await page.evaluate(SWEEP);
    process.stdout.write(`\nfloater groups: ${report.floaters.length}\n`);
    for (const f of report.floaters.slice(0, 40)) {
      process.stdout.write(
        `  y[${f.y}] dist[${f.dist}] x[${f.x}] z[${f.z}] n=${f.nodes} i=${f.instances}  ${f.key}\n`
      );
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
