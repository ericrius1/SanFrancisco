// Point at the artifacts and ask the scene what they are.
//
// Reproduces the exact free-cam pose that shows a building hanging in the air
// south of Sutro Baths, then raycasts through named screen points and reports
// the full ancestor chain of whatever is hit — plus a downward probe under the
// hit to show what (if anything) is holding it up.
//
//   SF_PROBE_URL=http://localhost:54905 node tools/sutro-raypick-probe.mjs

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:54905").replace(/\/$/, "");
const OUT = path.resolve(ROOT, ".data/sutro-raypick");

const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const localPoint = (x, y, z) => {
  const c = Math.cos(SITE.yaw);
  const s = Math.sin(SITE.yaw);
  return [SITE.x + c * x + s * z, y, SITE.z - s * x + c * z];
};

const EYE = localPoint(-20, 9, 70);
const DIR = [-0.3, 0.03, 0.95];

// Screen points measured off .data/sutro-floaters/baseline/03-south-end-open.png
const PICKS = [
  { name: "floating-structure", px: 780, py: 440 },
  { name: "structure-stub", px: 900, py: 565 },
  { name: "under-structure", px: 800, py: 640 },
  { name: "left-building-row", px: 150, py: 553 },
  { name: "pale-sheet", px: 500, py: 800 },
  { name: "dark-band", px: 400, py: 590 },
  { name: "far-right-water", px: 1600, py: 640 }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pickExpression = (picks) => `((picks) => {
  const sf = window.__sf;
  const THREE = sf.THREE;
  const cam = sf.camera;
  const ray = new THREE.Raycaster();
  ray.far = 20000;
  // Sprite.raycast dereferences raycaster.camera; the scene has sprites in it,
  // so leaving this unset throws on the first one rather than missing it.
  ray.camera = cam;
  // Instanced/batched terrain and GPU-displaced meshes will not raycast, so
  // report misses explicitly rather than silently.
  const chain = (o) => {
    const names = [];
    let n = o;
    while (n && names.length < 8) { names.push(n.name || "(" + n.type + ")"); n = n.parent; }
    return names.join(" < ");
  };
  const out = [];
  for (const p of picks) {
    const ndc = new THREE.Vector2((p.px / 1920) * 2 - 1, -((p.py / 1080) * 2 - 1));
    ray.setFromCamera(ndc, cam);
    const hits = ray.intersectObjects(sf.scene.children, true).filter((h) => {
      let n = h.object;
      while (n) { if (!n.visible) return false; n = n.parent; }
      return true;
    });
    const first = hits[0];
    let below = null;
    if (first) {
      const down = new THREE.Raycaster(
        new THREE.Vector3(first.point.x, first.point.y - 0.5, first.point.z),
        new THREE.Vector3(0, -1, 0),
        0,
        4000
      );
      down.camera = cam;
      const dh = down.intersectObjects(sf.scene.children, true).filter((h) => {
        let n = h.object;
        while (n) { if (!n.visible) return false; n = n.parent; }
        return true;
      })[0];
      below = dh
        ? { dropTo: Number(dh.point.y.toFixed(2)), drop: Number((first.point.y - dh.point.y).toFixed(2)), what: chain(dh.object) }
        : { dropTo: null, drop: null, what: "NOTHING BELOW" };
    }
    out.push({
      pick: p.name,
      hit: first
        ? {
            distance: Number(first.distance.toFixed(1)),
            point: [Number(first.point.x.toFixed(1)), Number(first.point.y.toFixed(2)), Number(first.point.z.toFixed(1))],
            groundHere: Number(sf.map.groundHeight(first.point.x, first.point.z).toFixed(2)),
            chain: chain(first.object)
          }
        : null,
      below,
      alsoHit: hits.slice(1, 4).map((h) => ({ d: Number(h.distance.toFixed(1)), y: Number(h.point.y.toFixed(2)), chain: chain(h.object) }))
    });
  }
  return out;
})(${JSON.stringify(picks)})`;

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
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, serviceWorkers: "block" });
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
    }, localPoint(-7, 6.2, 0));
    await page.waitForTimeout(13_000);

    await page.evaluate(() => {
      window.__sf.camera.fov = 75;
      window.__sf.camera.updateProjectionMatrix();
    });
    await page.evaluate(
      ([eye, dir]) => {
        window.__sfFreeCam(eye, [eye[0] + dir[0] * 500, eye[1] + dir[1] * 500, eye[2] + dir[2] * 500]);
      },
      [EYE, DIR]
    );
    await page.waitForTimeout(3500);

    await page.locator("canvas").first().screenshot({ path: path.join(OUT, "pose.png") });
    const picks = await page.evaluate(pickExpression(PICKS));
    await writeFile(path.join(OUT, "picks.json"), JSON.stringify(picks, null, 2));
    for (const p of picks) {
      process.stdout.write(`\n[${p.pick}]\n`);
      if (!p.hit) {
        process.stdout.write("  MISS (sky, or GPU-displaced geometry that does not raycast)\n");
        continue;
      }
      process.stdout.write(
        `  hit d=${p.hit.distance} at ${JSON.stringify(p.hit.point)} groundHere=${p.hit.groundHere}\n  ${p.hit.chain}\n`
      );
      process.stdout.write(`  below: ${JSON.stringify(p.below)}\n`);
      for (const a of p.alsoHit) process.stdout.write(`  also d=${a.d} y=${a.y} ${a.chain}\n`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exitCode = 1;
});
