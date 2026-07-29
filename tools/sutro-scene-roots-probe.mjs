// Definitive "what is actually in the scene, and is it visible" dump, taken at
// three moments: right after arrival, once the Sutro pocket has latched, and
// after standing at the ocean glass. Answers which roots the pocket's exterior
// thinning hides, which survive, and therefore why distant buildings are left
// hanging in the air with no landform under them.
//
//   SF_PROBE_URL=http://localhost:54905 node tools/sutro-scene-roots-probe.mjs [label]

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:54905").replace(/\/$/, "");
const LABEL = process.argv[2] ?? "current";
const OUT = path.resolve(ROOT, ".data/sutro-roots", LABEL);

const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const localPoint = (x, y, z) => {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DUMP = `(() => {
  const THREE = window.__sf.THREE;
  const scene = window.__sf.scene;
  const box = new THREE.Box3();
  const rows = [];
  for (const child of scene.children) {
    let bb = null;
    try {
      box.setFromObject(child, true);
      if (isFinite(box.min.x) && !box.isEmpty()) {
        bb = [
          Math.round(box.min.x), Math.round(box.min.y), Math.round(box.min.z),
          Math.round(box.max.x), Math.round(box.max.y), Math.round(box.max.z)
        ];
      }
    } catch { /* skip */ }
    let meshes = 0;
    child.traverse((o) => { if (o.isMesh || o.isInstancedMesh || o.isBatchedMesh || o.isPoints) meshes++; });
    rows.push({ name: child.name || "(unnamed)", type: child.type, visible: child.visible, meshes, bb });
  }
  return {
    rows,
    twilight: window.__sf?.sutroBaths?.debugState?.()?.twilight ?? null,
    player: {
      x: window.__sf.player.renderPosition.x,
      y: window.__sf.player.renderPosition.y,
      z: window.__sf.player.renderPosition.z
    }
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

const summarise = (label, dump) => {
  const visible = dump.rows.filter((r) => r.visible);
  const hidden = dump.rows.filter((r) => !r.visible);
  process.stdout.write(
    `\n===== ${label} =====\nthinned=${dump.twilight?.exteriorThinned} player=${JSON.stringify(
      dump.player
    )}\nvisible roots: ${visible.length}, hidden roots: ${hidden.length}\n`
  );
  const interesting = (r) =>
    /terrain|tile|city|lm_|ocean|water|land|wild|beach|clipmap|road|building|kite/i.test(r.name);
  process.stdout.write("-- VISIBLE (interesting) --\n");
  for (const r of visible.filter(interesting).slice(0, 60)) {
    process.stdout.write(`  ${r.name} meshes=${r.meshes} bb=${JSON.stringify(r.bb)}\n`);
  }
  process.stdout.write("-- HIDDEN (interesting) --\n");
  for (const r of hidden.filter(interesting).slice(0, 60)) {
    process.stdout.write(`  ${r.name} meshes=${r.meshes} bb=${JSON.stringify(r.bb)}\n`);
  }
};

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
  const report = {};
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block"
    });
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=sutroBaths`, {
      waitUntil: "domcontentloaded",
      timeout: 180_000
    });
    await page.waitForFunction(() => Boolean(window.__sf), null, { timeout: 240_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 240_000 });

    report.arrival = await page.evaluate(DUMP);
    summarise("ON ARRIVAL", report.arrival);

    // Walk the player deep inside so the pocket latches and thins the exterior.
    await page.evaluate(([x, y, z]) => {
      const sf = window.__sf;
      sf.player.restoreState({ x, y, z, heading: sf.player.heading, mode: "walk" });
      sf.hud?.setHidden?.(true);
    }, localPoint(-7, 6.2, 0));
    await page.waitForTimeout(14_000);
    report.latched = await page.evaluate(DUMP);
    summarise("POCKET LATCHED (deep inside)", report.latched);

    // Now stand at the ocean glass — still inside, but this is the view seat.
    await page.evaluate(([x, y, z]) => {
      window.__sf.player.restoreState({ x, y, z, heading: window.__sf.player.heading, mode: "walk" });
    }, localPoint(-34, 6.2, 20));
    await page.waitForTimeout(8000);
    report.atGlass = await page.evaluate(DUMP);
    summarise("AT THE OCEAN GLASS", report.atGlass);

    await writeFile(path.join(OUT, "roots.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`\nWrote ${OUT}/roots.json\n`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exitCode = 1;
});
