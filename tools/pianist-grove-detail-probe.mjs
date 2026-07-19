// Beach Pianist grove close-detail contract.
//
//  A. Wider near ring: every grove tree is promoted to a textured close LOD
//     from ~120 m out, and demoted back to landscape cards beyond the ring.
//  B. Transient KTX2 failure self-heals: with *.ktx2 blocked during first
//     approach the grove keeps its landscape fallback (never solid-triangle
//     close cards), and once the network recovers the textured detail arrives
//     within one retry window (~15 s) without a page reload.
//
// Usage: node tools/pianist-grove-detail-probe.mjs
// Starts its own Vite on a free port; artifacts in .data/pianist-grove-detail-probe.

import { access, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data/pianist-grove-detail-probe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(f) { try { await access(f); return true; } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (await exists(c)) return c;
  }
  throw new Error("no chrome");
}
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function waitHttp(url, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); }
  throw new Error(`timeout ${url}`);
}

const AUDIT = `(() => {
  const sf = window.__sf;
  const forest = sf.scene.getObjectByName("beach_pianist_cypress");
  if (!forest) return { missing: true };
  const near = forest.userData.nativeTreeNearLodStats?.() ?? null;
  return {
    player: { x: Math.round(sf.player.position.x), z: Math.round(sf.player.position.z) },
    near: near ? {
      active: near.active, canopy: near.canopy, grove: near.grove,
      loadingDesigns: near.loadingDesigns, failedDesigns: near.failedDesigns,
      retryDesigns: near.retryDesigns ?? null,
      closestReady: near.closestCandidate?.detailMaterialReady ?? null
    } : null
  };
})()`;

async function bootPage(context, base) {
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => { if (logs.length < 500) logs.push({ type: m.type(), text: m.text() }); });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${base}/?autostart=1&fullfps=1&profile=1&spawn=beachPianist`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => Boolean(window.__sf?.renderer?.backend?.device && window.__sf?.player), null, { timeout: 180000 });
  await page.waitForFunction(() => window.__sf.renderIdle?.() === true, null, { timeout: 180000 });
  await page.waitForFunction(() => window.__sf.siteFoliage?.isReady?.("beach-pianist-grove") === true, null, { timeout: 120000 });
  return { page, logs, pageErrors };
}

const hop = (page, x, z, facing) => page.evaluate((m) => {
  const sf = window.__sf;
  const y = sf.map.groundHeight(m.x, m.z);
  sf.player.teleportTo({ x: m.x, y: y + 1.7, z: m.z, facing: m.facing, mode: "walk" });
}, { x, z, facing });

async function main() {
  await mkdir(OUT, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`[pianist-grove-detail] vite on ${base}`);
  const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: ROOT, stdio: ["ignore", "ignore", "inherit"]
  });
  const SITE = { x: -3340, z: -870 };
  const results = {};
  try {
    await waitHttp(base, 60000);
    const browser = await chromium.launch({
      executablePath: await findChrome(),
      headless: true,
      args: [
        "--enable-unsafe-webgpu",
        "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
        "--use-angle=metal",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--mute-audio"
      ]
    });
    try {
      // ---- Scenario A: promotion from bluff distance ----
      {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const { page, pageErrors } = await bootPage(context, base);
        await sleep(6000);
        results.spawn = await page.evaluate(AUDIT);
        await page.screenshot({ path: path.join(OUT, "a-spawn.png") });
        // ~120 m SE of the site, looking back at the grove
        await hop(page, SITE.x + 85, SITE.z + 85, -2.35);
        await sleep(9000);
        results.bluff120 = await page.evaluate(AUDIT);
        await page.screenshot({ path: path.join(OUT, "a-bluff120.png") });
        // ~250 m out: beyond the ring, grove should be back on landscape cards
        await hop(page, SITE.x + 180, SITE.z + 180, -2.35);
        await sleep(7000);
        results.far250 = await page.evaluate(AUDIT);
        await page.screenshot({ path: path.join(OUT, "a-far250.png") });
        results.aPageErrors = pageErrors;
        await context.close();
      }
      // ---- Scenario B: blocked KTX2 heals after recovery ----
      {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        let blocked = 0;
        await context.route("**/*.ktx2", (route) => { blocked++; route.abort(); });
        const { page, logs, pageErrors } = await bootPage(context, base);
        await sleep(9000);
        results.blockedState = await page.evaluate(AUDIT);
        results.blockedRequests = blocked;
        await page.screenshot({ path: path.join(OUT, "b-blocked.png") });
        await context.unroute("**/*.ktx2");
        // Movement drives rebins; retry window is 15 s.
        for (let i = 0; i < 9; i++) {
          await hop(page, SITE.x + 6 + (i % 2) * 4, SITE.z + 10 + (i % 3) * 4, -0.9);
          await sleep(3500);
        }
        results.healedState = await page.evaluate(AUDIT);
        await page.screenshot({ path: path.join(OUT, "b-healed.png") });
        results.bWarnings = logs.filter((m) => ["warning", "error"].includes(m.type)).map((m) => m.text.slice(0, 200));
        results.bPageErrors = pageErrors;
        await context.close();
      }
      await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
      console.log(JSON.stringify(results, null, 2));

      const a = results.bluff120?.near;
      const far = results.far250?.near;
      const b0 = results.blockedState?.near;
      const b1 = results.healedState?.near;
      const pass =
        results.spawn?.near?.active === 24 &&
        a?.active === 24 &&
        (far?.active ?? 0) === 0 &&
        (b0?.active ?? 0) === 0 &&
        b1?.active === 24 && b1?.closestReady === true &&
        (results.aPageErrors?.length ?? 0) === 0 && (results.bPageErrors?.length ?? 0) === 0;
      console.log(pass ? "[pianist-grove-detail] PASS" : "[pianist-grove-detail] FAIL");
      if (!pass) process.exitCode = 1;
    } finally {
      await browser.close();
    }
  } finally {
    vite.kill("SIGTERM");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
