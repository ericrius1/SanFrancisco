// Fast visual-iteration harness for wildlands grass + tree look development.
//
// Not a contract test — it exists to put real pixels in front of a human quickly
// while tuning the meadow. Each station teleports the player, lets the paged
// foliage field + GPU compactors settle, then locks `__sfFreeCam` to fixed poses
// so two runs are directly comparable. It also dumps grass/tree stats per
// station so a patchy frame can be attributed to placement rather than shading.
//
//   SF_PROBE_URL=http://127.0.0.1:5240 node tools/foliage-look-shot.mjs [label]
//
// Shots land in .data/foliage-look/<label>/.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const LABEL = process.argv[2] ?? "current";
const ONLY = (process.env.SF_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = path.resolve(ROOT, ".data/foliage-look", LABEL);
const VIEWPORT = { width: 1500, height: 900 };
const TIME_OF_DAY = Number(process.env.SF_TIME ?? 9.5);

/**
 * Each station: where the player stands, and camera poses relative to that
 * stand. `grazing` is the reference read — eye ~1.1 m up, looking nearly level
 * so the blade silhouette stacks against the far ground/sky the way the
 * reference art does. `overlook` interrogates coverage and patchiness at range.
 */
const STATIONS = [
  {
    name: "ggpark-meadow",
    // Flat speedway meadow (shared with tools/grass-orbit.mjs).
    stand: [-3760, 2250],
    shots: [
      { name: "grazing", eyeY: 1.05, dist: 0.1, look: [26, 0.9], targetY: 1.0 },
      { name: "kneeling", eyeY: 0.42, dist: 0.1, look: [10, 0.9], targetY: 0.55 },
      { name: "overlook", eyeY: 14, dist: 0.1, look: [90, 2.2], targetY: 0 }
    ]
  },
  {
    name: "buenavista-summit",
    // North of the summit clearing's centre. Do NOT stand on (212, 2450): the
    // Afterlight's authored groundcover clear is a 14.5 × 13 m ellipse centred
    // at (208, 2456), so a station there reads as "no grass in Buena Vista"
    // when it is really the exhibit's own bare plaza.
    stand: [212, 2408],
    shots: [
      { name: "grazing", eyeY: 1.05, dist: 0.1, look: [30, 0.5], targetY: 1.2 },
      { name: "canopy-north", eyeY: 3.0, dist: 0.1, look: [90, 3.6], targetY: 12 },
      { name: "overlook", eyeY: 18, dist: 0.1, look: [110, 1.6], targetY: 0 }
    ]
  },
  {
    name: "buenavista-slope",
    // On the wooded NE flank inside the OSM outline, off the clearing.
    stand: [300, 2300],
    shots: [
      { name: "grazing", eyeY: 1.05, dist: 0.1, look: [26, 2.4], targetY: 1.4 },
      { name: "understory", eyeY: 1.8, dist: 0.1, look: [45, 5.0], targetY: 6 }
    ]
  },
  {
    name: "twinpeaks",
    // A grassy shoulder near the summit — every sample in a 40 m box passes
    // grassyGround. (-620, 3900) lands on a parking structure and reads as
    // "Twin Peaks has no grass".
    stand: [-325, 4250],
    shots: [
      { name: "grazing", eyeY: 1.05, dist: 0.1, look: [30, 1.2], targetY: 1.4 },
      { name: "overlook", eyeY: 16, dist: 0.1, look: [110, 2.6], targetY: 0 }
    ]
  },
  {
    name: "marin-hills",
    stand: [-4400, -6400],
    shots: [
      { name: "grazing", eyeY: 1.05, dist: 0.1, look: [30, 0.2], targetY: 1.4 },
      { name: "overlook", eyeY: 20, dist: 0.1, look: [120, 1.0], targetY: 0 }
    ]
  },
  {
    name: "presidio",
    stand: [-1900, -900],
    shots: [
      { name: "grazing", eyeY: 1.05, dist: 0.1, look: [28, 2.0], targetY: 1.3 },
      { name: "overlook", eyeY: 16, dist: 0.1, look: [100, 4.0], targetY: 0 }
    ]
  }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  throw new Error("No Chrome/Chromium found; set CHROME_BIN.");
}

async function waitHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return;
    } catch {
      /* server still coming up */
    }
    await sleep(400);
  }
  throw new Error(`Dev server never answered at ${url}`);
}

/** Mean luminance / spread / entropy — catches a black or blown frame, and
 *  makes "did this change move the image" answerable without eyeballing. */
async function audit(file) {
  const image = sharp(file);
  const stats = await image.stats();
  const { width, height } = await image.metadata();
  const channels = stats.channels.slice(0, 3);
  const grey = await image.clone().greyscale().raw().toBuffer();
  const histogram = new Array(256).fill(0);
  for (const value of grey) histogram[value]++;
  const total = grey.length;
  let entropy = 0;
  for (const count of histogram) {
    if (!count) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return {
    width,
    height,
    meanLuma: Number((channels.reduce((sum, c) => sum + c.mean, 0) / 3).toFixed(2)),
    channelMean: channels.map((c) => Number(c.mean.toFixed(2))),
    entropy: Number(entropy.toFixed(3))
  };
}

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
      `--use-angle=${process.env.SF_ANGLE ?? (process.platform === "darwin" ? "metal" : "swiftshader")}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--hide-scrollbars",
      "--mute-audio"
    ]
  });

  const pageErrors = [];
  const consoleErrors = [];
  const report = { label: LABEL, stations: {} };

  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error" && consoleErrors.length < 100) {
        consoleErrors.push(message.text());
      }
    });

    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
    await page.waitForFunction(() => Boolean(window.__sf), null, { timeout: 180_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 180_000 });
    await page.evaluate((tod) => {
      window.__sf.hud?.setHidden?.(true);
      if (window.__sf.sky) window.__sf.sky.timeOfDay = tod;
    }, TIME_OF_DAY);

    const canvas = page.locator("canvas").first();
    const stations = ONLY.length ? STATIONS.filter((s) => ONLY.includes(s.name)) : STATIONS;

    for (const station of stations) {
      await page.evaluate(([x, z]) => {
        const sf = window.__sf;
        const y = sf.map.groundHeight(x, z);
        sf.player.restoreState({ x, y: y + 1.2, z, heading: 0, mode: "walk" });
      }, station.stand);
      // The paged foliage field, the GPU compactors and the tree chunk streamer
      // all need real wall-clock; a short wait shows a half-grown field. Buena
      // Vista's first approach also compiles a five-design forest one pipeline
      // at a time, which takes tens of seconds — capture before that lands and
      // every station reads as "no trees" whatever the layout says.
      await page.waitForTimeout(9000);
      // A teleport opens a world arrival, and the per-frame foliage update is
      // gated on it. While it is active `grass.update()` never runs, so the
      // blade materials keep their initial (1e6, 1e6) focus — every cluster
      // dissolves to zero size even though the placement pass already filled
      // the instance buffers and the cull still reports draws. Capturing inside
      // that window photographs a bald world and blames the grass.
      await page
        .waitForFunction(() => window.__sf?.worldArrival?.active === false, null, { timeout: 120_000 })
        .catch(() => process.stdout.write("  WARN: world arrival never settled\n"));
      await page.waitForTimeout(4000);
      if (station.name.startsWith("buenavista")) {
        await page
          .waitForFunction(() => Boolean(window.__sf.buenaVistaTrees?.group?.parent), null, {
            timeout: 180_000
          })
          .catch(() => process.stdout.write("  WARN: buena vista forest never attached\n"));
        await page.waitForTimeout(4000);
      }

      const state = await page.evaluate(([x, z]) => {
        const sf = window.__sf;
        const grass = sf.wildlands?.grass;
        const layers = grass?.stats?.layers ?? null;
        const bv = sf.buenaVistaTrees;
        return {
          ground: Number(sf.map.groundHeight(x, z).toFixed(2)),
          surfaceType: sf.map.surfaceType?.(x, z) ?? null,
          isWater: sf.map.isWater?.(x, z) ?? null,
          grassCount: grass?.stats?.count ?? null,
          grassLayers: layers
            ? Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, v.count]))
            : null,
          fieldReady: grass?.group?.userData?.foliageField?.stats?.ready ?? null,
          grassVisible: grass?.group?.visible ?? null,
          arrivalActive: sf.worldArrival?.active ?? null,
          wildTrees: sf.wildlands?.stats?.trees ?? null,
          wildTreeChunks: sf.wildlands?.stats?.treeChunks ?? null,
          bvTrees: bv?.stats ?? null,
          bvPresent: Boolean(bv),
          bvVisible: bv?.group?.visible ?? null,
          flowers: sf.wildlands?.stats?.flowers ?? null
        };
      }, station.stand);

      report.stations[station.name] = { stand: station.stand, state, shots: {} };
      process.stdout.write(
        `\n[${station.name}] ground ${state.ground} surf ${state.surfaceType} grass ${state.grassCount} ` +
          `layers ${JSON.stringify(state.grassLayers)} bvTrees ${JSON.stringify(state.bvTrees)}\n`
      );

      for (const shot of station.shots) {
        await page.evaluate(([stand, s]) => {
          const sf = window.__sf;
          const [x, z] = stand;
          const g = sf.map.groundHeight(x, z);
          const eye = [x, g + s.eyeY, z];
          const tx = x + Math.cos(s.look[1]) * s.look[0];
          const tz = z + Math.sin(s.look[1]) * s.look[0];
          const target = [tx, sf.map.groundHeight(tx, tz) + s.targetY, tz];
          window.__sfFreeCam(eye, target);
        }, [station.stand, shot]);
        // A freecam pose needs a frame; the wind animates, so give it a beat.
        await page.waitForTimeout(1600);
        const file = path.join(OUT, `${station.name}-${shot.name}.png`);
        await canvas.screenshot({ path: file });
        const a = await audit(file);
        report.stations[station.name].shots[shot.name] = { file, ...a };
        process.stdout.write(`  ${shot.name}: luma ${a.meanLuma} entropy ${a.entropy}\n`);
      }

      // Pacing, measured rather than glanced at: a single `tracer.ema` read is
      // dominated by whatever streaming or shader compile landed in the last
      // second. Park on the grazing pose, let the EMA settle, take a spread and
      // report the median.
      await page.evaluate(([stand, s]) => {
        const sf = window.__sf;
        const [x, z] = stand;
        const g = sf.map.groundHeight(x, z);
        const tx = x + Math.cos(s.look[1]) * s.look[0];
        const tz = z + Math.sin(s.look[1]) * s.look[0];
        window.__sfFreeCam([x, g + s.eyeY, z], [tx, sf.map.groundHeight(tx, tz) + s.targetY, tz]);
      }, [station.stand, station.shots[0]]);
      await page.waitForTimeout(4000);
      const samples = [];
      for (let i = 0; i < 9; i++) {
        samples.push(await page.evaluate(() => window.__sf?.tracer?.ema ?? null));
        await page.waitForTimeout(350);
      }
      const usable = samples.filter((v) => typeof v === "number").sort((a, b) => a - b);
      const medianEmaMs = usable.length ? Number(usable[usable.length >> 1].toFixed(2)) : null;
      const submitted = await page.evaluate(
        () => window.__sf.wildlands?.grass?.stats?.submittedTriangles ?? null
      );
      report.stations[station.name].medianEmaMs = medianEmaMs;
      report.stations[station.name].grassTriangles = submitted;
      process.stdout.write(`  frame EMA median ${medianEmaMs} ms · grass tris ${submitted}\n`);
      await page.evaluate(() => window.__sfFreeCam(null));
    }

    report.pageErrors = pageErrors;
    report.consoleErrors = consoleErrors.slice(0, 20);
    await writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
    if (pageErrors.length) {
      process.stdout.write(`\nPAGE ERRORS (${pageErrors.length}):\n${pageErrors.slice(0, 5).join("\n")}\n`);
    }
    process.stdout.write(`\nwrote ${OUT}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
