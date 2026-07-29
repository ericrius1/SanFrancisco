// Where exactly is the pool rim, and how high is it?
//
//   SF_PROBE_URL=http://localhost:5251 node tools/sutro-coping-profile-probe.mjs
//
// The sitEdge bathers were moved to 0.3 m proud of the SUTRO_POOLS rect and
// still ended up embedded in the coping, which means the rect edge is not the
// same thing as the walkable rim: there is a raised lip above deck level that
// the pool rectangle knows nothing about. So stop doing arithmetic on rects and
// sample the rendered walk surface across the profile instead.

import { access } from "node:fs/promises";
import { chromium } from "playwright-core";

const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:5251").replace(/\/$/, "");
const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const L = (lx, y, lz) => [
  SITE.x + Math.cos(SITE.yaw) * lx + Math.sin(SITE.yaw) * lz,
  y,
  SITE.z - Math.sin(SITE.yaw) * lx + Math.cos(SITE.yaw) * lz
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Profiles to walk: name, fixed axis value, and the axis to sweep. */
const PROFILES = [
  { name: "plunge west rim (sit-1/2, z -25.4)", axis: "x", from: -34, to: -28, fixed: -25.4 },
  { name: "plunge east rim (sit-3, z 14)", axis: "x", from: -13, to: -7, fixed: 14 },
  { name: "bath-two north rim (sit-4, x 7.5)", axis: "z", from: -41, to: -35, fixed: 7.5 },
  { name: "bath-five south rim (sit-5, x 14)", axis: "z", from: 23, to: 29, fixed: 14 }
];

async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)) {
    try { await access(c); return c; } catch { /* keep looking */ }
  }
  throw new Error("No Chrome found");
}

const browser = await chromium.launch({
  executablePath: await findChrome(),
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", `--use-angle=metal`, "--mute-audio"]
});
try {
  const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
  await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=sutroBaths`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForFunction(() => Boolean(window.__sf), null, { timeout: 240000 });
  await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 240000 });
  await page.evaluate(([x, y, z]) => window.__sf.player.restoreState({ x, y, z, heading: 0, mode: "walk" }), L(-14, 5.72, -66));
  await page.waitForTimeout(9000);

  for (const p of PROFILES) {
    const pts = [];
    for (let v = p.from; v <= p.to + 1e-9; v += 0.2) {
      pts.push(p.axis === "x" ? L(v, 0, p.fixed) : L(p.fixed, 0, v));
    }
    // groundTop is useless inside this hall: the authored region declares
    // flat-ownership at groundY 2.07, so every sample in the building returns
    // 2.07 regardless of what is actually built there. Raycast the architecture
    // straight down instead and take the first surface.
    const tops = await page.evaluate((list) => {
      const THREE = window.__sf.THREE;
      const scene = window.__sf.scene;
      const down = new THREE.Vector3(0, -1, 0);
      return list.map(([x, , z]) => {
        const ray = new THREE.Raycaster(new THREE.Vector3(x, 14, z), down, 0, 20);
        ray.camera = window.__sf.camera;
        const hit = ray.intersectObjects(scene.children, true).filter((h) => {
          let n = h.object;
          while (n) { if (!n.visible) return false; n = n.parent; }
          // Ignore people and the water sheet; we want the stone.
          return !/bather|rig-skin|water|steam/i.test(h.object.name || "");
        })[0];
        return hit ? Number(hit.point.y.toFixed(3)) : null;
      });
    }, pts);
    process.stdout.write(`\n${p.name}  (deck 5.62, water 5.18)\n`);
    let v = p.from;
    for (const t of tops) {
      const bar = t === null ? " (no hit)" : t > 5.9 ? " <== RAISED RIM" : t > 5.5 ? " deck" : t > 5.0 ? " water level" : " below/basin";
      process.stdout.write(`  ${p.axis}=${v.toFixed(1).padStart(6)}  top ${String(t).padStart(7)}${bar}\n`);
      v += 0.2;
    }
  }
} finally {
  await browser.close();
}
