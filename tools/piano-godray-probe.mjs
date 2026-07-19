// Piano god-ray verification probe: boots at the beach pianist, confirms the
// god-ray graph activates, that grove tree batches now cast into the dedicated
// shadow light, and captures screenshots aimed through the canopy toward a
// morning sun.
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const OUT = process.env.PROBE_OUT ?? path.resolve(process.cwd(), ".data/godray-probe");
const BASE_URL = process.env.SF_PROBE_URL ?? "http://localhost:5240";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}
async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  for (const c of candidates) if (await exists(c)) return c;
  throw new Error("Chrome not found");
}

async function main() {
  await mkdir(OUT, { recursive: true });
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
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push((e.stack ?? String(e)).split("\n").slice(0, 8).join("\n")));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=beachPianist`, {
      waitUntil: "domcontentloaded", timeout: 90_000
    });
    await page.waitForFunction(
      () => Boolean(window.__sf?.renderer?.backend?.device && window.__sf?.player && window.__sf?.pipeline),
      null, { timeout: 180_000 }
    );
    // Morning sun from the ENE so an east-facing camera looks through the
    // grove into the light.
    await page.evaluate(() => window.__sf.sky.setTimeOfDay(9.0));
    await page.waitForFunction(
      () => window.__sf.pipeline.pianoGodRaysState?.active === true &&
            window.__sf.pipeline.pianoGodRaysState.renderedFrames > 60,
      null, { timeout: 120_000 }
    );
    await sleep(3000);

    const state = await page.evaluate(() => {
      const sf = window.__sf;
      let shadowLight = null;
      let casters = 0;
      const casterNames = [];
      let foliageMat = null;
      sf.scene.traverse((o) => {
        if (o.name === "beachPianist.godRays.shadowLight") {
          shadowLight = {
            castShadow: o.castShadow,
            autoUpdate: o.shadow.autoUpdate,
            mapSize: [o.shadow.mapSize.x, o.shadow.mapSize.y],
            hasMap: Boolean(o.shadow.map)
          };
        }
        if (o.isMesh && o.castShadow && o.name.includes("beach_pianist_cypress")) {
          casters += 1;
          if (casterNames.length < 8) casterNames.push(o.name);
          if (!foliageMat && o.name.endsWith("_foliage")) {
            foliageMat = {
              name: o.material?.name ?? null,
              alphaTest: o.material?.alphaTest ?? null,
              colorNodeType: o.material?.colorNode?.nodeType ?? null
            };
          }
        }
      });
      return {
        godRays: sf.pipeline.pianoGodRaysState,
        shadowLight,
        casters,
        casterNames,
        foliageMat,
        player: [sf.player.position.x, sf.player.position.y, sf.player.position.z],
        hour: sf.sky.timeOfDay
      };
    });
    console.log(JSON.stringify(state, null, 2));

    // Shot 1: default arrival framing.
    await page.screenshot({ path: path.join(OUT, "arrival.png") });
    // Shot 2: from the piano looking east through the grove into the sun.
    await page.evaluate(() => {
      const site = { x: -3340, z: -870 };
      const y = window.__sf.player.position.y + 2.2;
      window.__sfFreeCam([site.x - 14, y, site.z + 4], [site.x + 30, y + 9, site.z - 6]);
    });
    await sleep(1500);
    await page.screenshot({ path: path.join(OUT, "through-grove-east.png") });
    // Shot 3: low under the canopy looking up-sun.
    await page.evaluate(() => {
      const site = { x: -3340, z: -870 };
      const y = window.__sf.player.position.y + 1.2;
      window.__sfFreeCam([site.x - 6, y, site.z + 10], [site.x + 24, y + 14, site.z - 14]);
    });
    await sleep(1500);
    await page.screenshot({ path: path.join(OUT, "under-canopy.png") });
    await page.evaluate(() => window.__sfFreeCam(null));

    // Leave/re-enter cycle: the god-ray graph is disposed past the exit
    // radius and rebuilt on return. The rebuild must wait for the fresh
    // shadow map (GodraysNode dereferences it at setup) without erroring.
    await page.evaluate(() => {
      const p = window.__sf.player;
      p.teleportTo({ x: -3340 + 260, y: p.position.y + 4, z: -870, facing: Math.PI / 2, mode: "walk" });
    });
    await page.waitForFunction(
      () => window.__sf.pipeline.pianoGodRaysState?.active === false,
      null, { timeout: 60_000 }
    );
    await sleep(1500);
    await page.evaluate(() => {
      const p = window.__sf.player;
      p.teleportTo({ x: -3351, y: 3.5, z: -859, facing: -1.1, mode: "walk" });
    });
    await page.waitForFunction(
      () => window.__sf.pipeline.pianoGodRaysState?.active === true,
      null, { timeout: 120_000 }
    );
    await sleep(2000);
    const reentry = await page.evaluate(() => window.__sf.pipeline.pianoGodRaysState);
    console.log("reentry:", JSON.stringify(reentry));

    await writeFile(path.join(OUT, "state.json"), JSON.stringify({ state, reentry, errors }, null, 2));
    console.log("errors:", errors.length ? errors.slice(0, 10) : "none");
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
