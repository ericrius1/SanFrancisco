// Why do the floating bathers read as lying on a floor?
//
//   SF_PROBE_URL=http://localhost:5251 node tools/sutro-float-depth-probe.mjs
//
// surfaceForPose() intends backFloat to sit 5 cm under the waterline (hips at
// 5.13 against a 5.18 surface), which should read as a body IN the water. On
// screen the body is fully crisp and opaque on top of a flat sheet. Two very
// different causes, and they want different fixes:
//
//   * the placement never lands  — measure the rig's actual world Y
//   * the surface does not cover — the water draws behind the body, or writes
//     no depth, or is opaque, so nothing below it is ever tinted or hidden
//
// So report both: where every water-pose bather actually is relative to the
// water mesh, and what that mesh's material is doing.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:5251").replace(/\/$/, "");
const OUT = path.resolve(ROOT, ".data/sutro-float");

const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const L = (lx, y, lz) => [
  SITE.x + Math.cos(SITE.yaw) * lx + Math.sin(SITE.yaw) * lz,
  y,
  SITE.z - Math.sin(SITE.yaw) * lx + Math.cos(SITE.yaw) * lz
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERY = `(() => {
  const sf = window.__sf;
  const THREE = sf.THREE;
  const box = new THREE.Box3();
  const out = { waterMeshes: [], bathers: [] };

  const root = sf.scene.getObjectByName("sutro_baths_restored_1896") ?? sf.scene;

  root.traverse((o) => {
    const name = o.name || "";
    if (/water|pool|plunge/i.test(name) && (o.isMesh || o.isInstancedMesh)) {
      let bb = null;
      try { box.setFromObject(o, true); if (isFinite(box.min.y)) bb = [Number(box.min.y.toFixed(3)), Number(box.max.y.toFixed(3))]; } catch {}
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      out.waterMeshes.push({
        name,
        y: bb,
        renderOrder: o.renderOrder,
        transparent: m?.transparent ?? null,
        opacity: m?.opacity ?? null,
        depthWrite: m?.depthWrite ?? null,
        depthTest: m?.depthTest ?? null,
        side: m?.side ?? null,
        type: m?.type ?? null
      });
    }
  });

  // Every rig in the site, with its world Y and how it sits against the surface.
  const WATER_Y = 5.18;
  root.traverse((o) => {
    if (!o.isSkinnedMesh && !(o.name && /bather|rig-skin/i.test(o.name))) return;
    let holder = o;
    for (let i = 0; i < 4 && holder.parent; i++) holder = holder.parent;
    let bb = null;
    try { box.setFromObject(o, true); if (isFinite(box.min.y)) bb = { min: box.min.y, max: box.max.y }; } catch {}
    if (!bb) return;
    const pos = new THREE.Vector3();
    o.getWorldPosition(pos);
    // Report hall-LOCAL x/z too. The cast table in bathers.ts is written in
    // local coordinates, and aiming cameras by reading those numbers off the
    // page put a 105 mm lens on two people who turned out to be nowhere near
    // where the arithmetic said. Measure the rigs instead.
    const YAW = -0.077;
    const dx = pos.x - -6125;
    const dz = pos.z - 1117;
    const lx = Math.cos(YAW) * dx - Math.sin(YAW) * dz;
    const lz = Math.sin(YAW) * dx + Math.cos(YAW) * dz;
    out.bathers.push({
      node: o.name || o.type,
      local: [Number(lx.toFixed(2)), Number(lz.toFixed(2))],
      worldY: Number(pos.y.toFixed(3)),
      bbY: [Number(bb.min.toFixed(3)), Number(bb.max.toFixed(3))],
      aboveWater: Number((bb.min - WATER_Y).toFixed(3)),
      renderOrder: o.renderOrder,
      visible: o.visible
    });
  });

  out.bathers.sort((a, b) => a.bbY[0] - b.bbY[0]);
  out.stats = sf.sutroBaths?.stats ?? null;
  out.waterState = sf.sutroBaths?.debugState?.().water ?? null;
  return out;
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
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
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
    }, L(-14, 5.72, -66));
    await page
      .waitForFunction(() => (window.__sf?.sutroBaths?.stats?.bathers ?? 0) > 0, null, { timeout: 120_000 })
      .catch(() => process.stdout.write("WARN: cast never hydrated\n"));
    await page.waitForTimeout(6000);

    const data = await page.evaluate(QUERY);
    await writeFile(path.join(OUT, "float.json"), JSON.stringify(data, null, 2));

    process.stdout.write(`bathers: ${data.stats?.bathers}\n`);
    process.stdout.write(`\n--- water meshes ---\n`);
    for (const w of data.waterMeshes) {
      process.stdout.write(
        `  ${w.name}\n    y=${JSON.stringify(w.y)} order=${w.renderOrder} ${w.type} transparent=${w.transparent} opacity=${w.opacity} depthWrite=${w.depthWrite} depthTest=${w.depthTest}\n`
      );
    }
    process.stdout.write(`\n--- rigs, lowest first (aboveWater = bbox bottom minus 5.18) ---\n`);
    for (const b of data.bathers.slice(0, 40)) {
      process.stdout.write(
        `  local=[${String(b.local[0]).padStart(7)},${String(b.local[1]).padStart(7)}] bb=[${b.bbY}] aboveWater=${String(b.aboveWater).padStart(7)} ${b.node}\n`
      );
    }
    process.stdout.write(`\nWrote ${OUT}/float.json\n`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exitCode = 1;
});
