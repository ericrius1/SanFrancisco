// Numeric ground truth for the "floating landmark" question.
//
// Samples the heightmap along the coast south of Sutro Baths, reports the active
// terrain cutouts, and measures the vertical gap between the Cliff House
// landmark's lowest vertex and the ground the heightmap claims is under it.
//
//   SF_PROBE_URL=http://localhost:54905 node tools/sutro-terrain-truth-probe.mjs

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:54905").replace(/\/$/, "");
const OUT = path.resolve(ROOT, ".data/sutro-terrain-truth");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERY = `(() => {
  const sf = window.__sf;
  const THREE = sf.THREE;
  const scene = sf.scene;
  const box = new THREE.Box3();

  // Every named landmark / structure root near the west coast, with the ground
  // the heightmap says is beneath its centre.
  const groundAt = (x, z) => {
    try { return Number(sf.map.groundHeight(x, z).toFixed(2)); } catch (e) { return "ERR:" + e.message; }
  };

  const structures = [];
  const walk = (node, depth) => {
    if (depth > 3) return;
    for (const child of node.children) {
      if (!child.name) { walk(child, depth + 1); continue; }
      let bb = null;
      try {
        box.setFromObject(child, true);
        if (isFinite(box.min.x) && !box.isEmpty()) bb = box.clone();
      } catch { /* skip */ }
      if (bb) {
        const cx = (bb.min.x + bb.max.x) / 2;
        const cz = (bb.min.z + bb.max.z) / 2;
        // West-coast band only.
        if (cx > -6600 && cx < -5300 && cz > 700 && cz < 4200 && (bb.max.y - bb.min.y) > 3) {
          structures.push({
            name: child.name,
            visible: child.visible,
            center: [Number(cx.toFixed(1)), Number(cz.toFixed(1))],
            minY: Number(bb.min.y.toFixed(2)),
            maxY: Number(bb.max.y.toFixed(2)),
            ground: groundAt(cx, cz),
            gap: Number((bb.min.y - sf.map.groundHeight(cx, cz)).toFixed(2))
          });
        }
      }
      walk(child, depth + 1);
    }
  };
  walk(scene, 0);

  // Heightmap transect: due south from the baths down the coast.
  const transect = [];
  for (let z = 900; z <= 4200; z += 100) {
    transect.push({ z, g_6200: groundAt(-6200, z), g_5900: groundAt(-5900, z), g_5500: groundAt(-5500, z), g_5000: groundAt(-5000, z) });
  }

  // Point Lobos / Cliff House shelf specifically.
  const shelf = [];
  for (let x = -6400; x <= -5900; x += 50) {
    shelf.push({ x, g1200: groundAt(x, 1200), g1300: groundAt(x, 1300), g1400: groundAt(x, 1400) });
  }

  const clip = scene.getObjectByName("terrainClipmap");
  const clipInfo = clip ? {
    visible: clip.visible,
    children: clip.children.map((c) => ({
      name: c.name, visible: c.visible, type: c.type,
      pos: [Number(c.position.x.toFixed(1)), Number(c.position.y.toFixed(1)), Number(c.position.z.toFixed(1))],
      scale: [c.scale.x, c.scale.y, c.scale.z],
      material: c.material?.name ?? c.material?.type ?? null,
      vertices: c.geometry?.attributes?.position?.count ?? null
    }))
  } : null;

  return {
    twilight: sf.sutroBaths?.debugState?.()?.twilight ?? null,
    seaLevel: sf.map?.meta?.seaLevel ?? sf.map?.seaLevel ?? null,
    mapMeta: sf.map?.meta ? Object.keys(sf.map.meta) : null,
    structures: structures.sort((a, b) => b.gap - a.gap).slice(0, 40),
    clipInfo,
    transect,
    shelf
  };
})()`;

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
      "--mute-audio"
    ]
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=sutroBaths`, {
      waitUntil: "domcontentloaded",
      timeout: 180_000
    });
    await page.waitForFunction(() => Boolean(window.__sf), null, { timeout: 240_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 240_000 });
    await page.waitForTimeout(10_000);

    const data = await page.evaluate(QUERY);
    await writeFile(path.join(OUT, "truth.json"), JSON.stringify(data, null, 2));

    process.stdout.write(`seaLevel=${data.seaLevel} mapMeta=${JSON.stringify(data.mapMeta)}\n`);
    process.stdout.write(`\nclipmap: ${JSON.stringify(data.clipInfo, null, 1)?.slice(0, 2200)}\n`);
    process.stdout.write(`\n--- structures by vertical gap above heightmap ground ---\n`);
    for (const s of data.structures) {
      process.stdout.write(
        `  gap ${String(s.gap).padStart(8)}  minY ${String(s.minY).padStart(7)}  ground ${String(s.ground).padStart(7)}  vis=${s.visible}  @${JSON.stringify(s.center)}  ${s.name}\n`
      );
    }
    process.stdout.write(`\n--- coast transect (ground height) ---\n`);
    for (const t of data.transect) {
      process.stdout.write(`  z=${String(t.z).padStart(5)}  x-6200:${String(t.g_6200).padStart(7)}  x-5900:${String(t.g_5900).padStart(7)}  x-5500:${String(t.g_5500).padStart(7)}  x-5000:${String(t.g_5000).padStart(7)}\n`);
    }
    process.stdout.write(`\nWrote ${OUT}/truth.json\n`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exitCode = 1;
});
