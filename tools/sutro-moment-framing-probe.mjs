// Fast framing check for the five interior moments.
//
//   SF_PROBE_URL=http://localhost:PORT node tools/sutro-moment-framing-probe.mjs [label]
//
// The cinematic stills path is the correct final review, but it costs a private
// Vite, a seeded Chrome and a full deterministic replay per production — about
// four minutes to answer "is the camera pointing at the person". This does the
// same job in one boot: latch the pocket, then step the free cam through each
// look's start/mid/end pose and screenshot. Iterate here, port the numbers into
// src/dev/demos/sutroMomentsCinematic.ts, and spend the render on a shot that is
// already framed.
//
// Poses are in HALL-LOCAL coordinates so they can be copied across verbatim.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:5240").replace(/\/$/, "");
const LABEL = process.argv[2] ?? "current";
const OUT = path.resolve(ROOT, ".data/sutro-moments", LABEL);
const VIEWPORT = { width: 1920, height: 1080 };

const SITE = { x: -6125, z: 1117, yaw: -0.077 };
const L = (lx, y, lz) => [
  SITE.x + Math.cos(SITE.yaw) * lx + Math.sin(SITE.yaw) * lz,
  y,
  SITE.z - Math.sin(SITE.yaw) * lx + Math.cos(SITE.yaw) * lz
];

const DECK = 5.62;
const WATER = 5.18;
const EYE = 1.62;

/**
 * Candidate looks, revised after the first render put the pool coping across
 * the lower half of frame. The mistake was reading "crouched at the water" as a
 * low absolute height: the deck sits only 0.44 m above the water, so an eye at
 * water + 0.75 is 0.31 m above the deck the camera is standing on, and the
 * coping fills the bottom of the lens.
 */
const LOOKS = [
  {
    id: "01-still-water",
    // Standing on the west coping of the great plunge (pool x -31..-10),
    // looking down at sutro-swim-3 backfloating at (-26, -8).
    eye: [
      [-31.5, DECK + 1.45, -13.6],
      [-31.5, DECK + 1.42, -12.4],
      [-31.6, DECK + 1.4, -11.4]
    ],
    at: [
      [-26.0, WATER + 0.2, -8.8],
      [-25.8, WATER + 0.22, -8.2],
      [-25.6, WATER + 0.24, -7.7]
    ],
    lens: 50
  },
  {
    id: "02-long-view",
    // Behind the window-south bench at (-36.2, 21), over two pairs of
    // shoulders, out through the ocean glass at x -38.7.
    eye: [
      [-33.4, DECK + EYE, 22.9],
      [-33.7, DECK + EYE, 22.3],
      [-34.0, DECK + EYE - 0.03, 21.8]
    ],
    at: [
      [-46, DECK + 1.15, 18.6],
      [-47, DECK + 1.3, 17.6],
      [-48, DECK + 1.45, 16.8]
    ],
    lens: 35
  },
  {
    id: "03-tea-window",
    // The west-b table at (-34.2, 6): three chairs at bearings 0.8, 2.89, 4.98
    // on a 0.94 m reach, so the group occupies roughly a 2 m circle.
    eye: [
      [-30.7, DECK + 1.52, 7.9],
      [-31.2, DECK + 1.5, 7.3],
      [-31.6, DECK + 1.48, 6.9]
    ],
    at: [
      [-34.3, DECK + 0.98, 6.1],
      [-34.4, DECK + 0.96, 6.05],
      [-34.5, DECK + 0.94, 6.0]
    ],
    lens: 45
  },
  {
    id: "04-hot-bath",
    // Across bath four at sutro-hot-1/2, (3.5, 3.5) and (5.9, 4.4).
    //
    // Two revisions. The first stood at x -2.4, inside the pool's own footprint
    // (the baths run x -4..19). The second moved to the spine at x -6.6 with a
    // 62 mm lens and made the pair specks in an empty pool: chest-deep people
    // show maybe 0.8 m of themselves, so at that range they are a few per cent
    // of frame height. Now as close to the coping as the deck allows, on a long
    // lens, so two heads and shoulders actually fill the frame.
    eye: [
      [-4.7, DECK + EYE, 5.9],
      [-4.6, DECK + EYE, 5.4],
      [-4.5, DECK + EYE - 0.02, 5.0]
    ],
    at: [
      [4.4, WATER + 0.9, 3.9],
      [4.5, WATER + 0.92, 3.85],
      [4.6, WATER + 0.94, 3.8]
    ],
    lens: 105
  },
  {
    id: "05-plunge-edge",
    // Down the west coping at sutro-sit-1/2, (-32.2, -25.4) and (-32.2, -23.2),
    // with the candle line at x -32.4 running away behind them. Closer and
    // longer than the first pass, which left a third of the frame as bare deck
    // and put the pair small and off to one side.
    eye: [
      [-33.4, DECK + EYE, -29.9],
      [-33.3, DECK + EYE, -29.1],
      [-33.2, DECK + EYE - 0.02, -28.4]
    ],
    at: [
      [-32.3, DECK + 0.6, -24.8],
      [-32.3, DECK + 0.63, -24.5],
      [-32.2, DECK + 0.65, -24.2]
    ],
    lens: 70
  }
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
  const report = { baseUrl: BASE_URL, looks: {} };
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: "block" });
    const page = await context.newPage();
    page.on("pageerror", (e) => (report.pageErrors ??= []).push(String(e)));
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=sutroBaths`, {
      waitUntil: "domcontentloaded",
      timeout: 180_000
    });
    await page.waitForFunction(() => Boolean(window.__sf), null, { timeout: 240_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 240_000 });

    // Stand inside so the pocket latches, then let its wall-clock ramp finish —
    // the same condition the demo now waits on before it arms.
    await page.evaluate(([x, y, z]) => {
      const sf = window.__sf;
      sf.player.restoreState({ x, y, z, heading: sf.player.heading, mode: "walk" });
      sf.hud?.setHidden?.(true);
    }, L(-14, DECK + 0.1, -66));
    await page
      .waitForFunction(
        () => {
          const s = window.__sf?.sutroBaths;
          const t = s?.debugState?.().twilight;
          return Boolean(s) && (t?.skyBlend ?? 0) > 0.985 && (s?.stats?.bathers ?? 0) > 0;
        },
        null,
        { timeout: 120_000 }
      )
      .catch(() => process.stdout.write("WARN: hall never fully settled\n"));
    await page.waitForTimeout(2500);

    report.twilight = await page.evaluate(() => window.__sf?.sutroBaths?.debugState?.().twilight ?? null);
    report.bathers = await page.evaluate(() => window.__sf?.sutroBaths?.stats?.bathers ?? null);
    process.stdout.write(`twilight ${JSON.stringify(report.twilight)}\nbathers ${report.bathers}\n\n`);

    const canvas = page.locator("canvas").first();
    for (const look of LOOKS) {
      for (const [phase, index] of [["start", 0], ["mid", 1], ["end", 2]]) {
        const eye = L(...look.eye[index]);
        const at = L(...look.at[index]);
        await page.evaluate(
          ([e, a, lens]) => {
            const w = window;
            const cam = w.__sf.camera;
            const fov = 2 * Math.atan(24 / (2 * lens)) * (180 / Math.PI);
            // The app rewrites camera.fov every tick (speed/mode framing), so a
            // one-shot assignment is gone by the next frame and every "lens"
            // here silently rendered at the default ~70 deg. That made subjects
            // look five times smaller than the focal length implied and sent me
            // chasing a framing bug that did not exist. Hold it instead, and
            // clear the previous hold so successive looks do not stack.
            if (w.__framingHold) clearInterval(w.__framingHold);
            w.__framingHold = setInterval(() => {
              if (cam.fov !== fov) {
                cam.fov = fov;
                cam.updateProjectionMatrix();
              }
            }, 16);
            cam.fov = fov;
            cam.updateProjectionMatrix();
            w.__sfFreeCam(e, a);
          },
          [eye, at, look.lens]
        );
        await page.waitForTimeout(1400);
        await canvas.screenshot({ path: path.join(OUT, `${look.id}-${phase}.png`) });
      }
      process.stdout.write(`framed ${look.id}\n`);
      report.looks[look.id] = { lens: look.lens };
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
