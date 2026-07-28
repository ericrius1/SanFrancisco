// Fast visual-iteration harness for the Ocean Beach shorebreak (waves running
// up the sand). Not a contract test — it exists to put real pixels in front of
// a human quickly while tuning the swash.
//
//   SF_PROBE_URL=http://127.0.0.1:5240 node tools/shorebreak-shot.mjs [label]
//
// Shots land in .data/shorebreak/<label>/. Pass "before" and "after" to keep a
// pair; pass the same label twice to overwrite while iterating on one change.
//
// Each pose is shot at several wave phases so a single frame cannot hide a
// broken up-rush or a missing backwash.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const LABEL = process.argv[2] ?? "current";
const OUT = path.resolve(ROOT, ".data/shorebreak", LABEL);
const VIEWPORT = { width: 1600, height: 1000 };

/** Along-beach station the player stands at (mid-beach, inside the strip). */
const SHOT_Z = Number(process.env.SF_SHOREBREAK_Z ?? 3370);
/** Where the cameras work — far enough up the beach to clear the surf shack. */
const CAM_Z = SHOT_Z + 240;
/** Wave-cycle phases to sample: break, mid up-rush, full run-up, backwash. */
const PHASES = Number(process.env.SF_SHOREBREAK_PHASES ?? 4);
/** Ocean Beach set period — spacing 150 m / speed 9.2 m·s⁻¹. */
const SET_PERIOD = 150 / 9.2;
/** How many set periods the phase sweep walks across. */
const SPAN = Number(process.env.SF_SHOREBREAK_SPAN ?? 2);
/**
 * Wash clock the shots are pinned to. Arbitrary but FIXED, so "before" and
 * "after" show the same waves doing the same thing.
 */
const BASE_TIME = Number(process.env.SF_SHOREBREAK_T ?? 4000);

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

/** Mean luminance + entropy — enough to catch a black or blown-out frame. */
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
    channelStdDev: channels.map((c) => Number(c.stdev.toFixed(2))),
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
  const results = {};

  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      serviceWorkers: "block"
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("console", (message) => {
      const type = message.type();
      if ((type === "error" || type === "warning") && consoleErrors.length < 60) {
        consoleErrors.push(`[${type}] ${message.text()}`);
      }
    });

    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
    await page.waitForFunction(() => Boolean(window.__sf), null, { timeout: 180_000 });
    await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 180_000 });

    // Walk the player onto Ocean Beach so the tiles, water and (if primed) the
    // surf overlay stream in around the shot poses. The CAMERA then works a
    // couple of hundred metres up the beach from them, clear of the surf shack
    // that the approach primes right where they are standing.
    const anchor = await page.evaluate(([z, camZ, fog]) => {
      const sf = window.__sf;
      // Numeric waterline: walk shoreward until the map stops calling it water.
      const waterlineAt = (zz) => {
        let waterX = -6100;
        for (let x = -6250; x < -5700; x += 1) {
          if (sf.map.isWater(x, zz)) waterX = x;
          else break;
        }
        return waterX;
      };
      const standX = waterlineAt(z) + 26;
      const standY = sf.map.groundTop(standX, z);
      sf.player.teleportTo({ x: standX, y: standY + 1.1, z, facing: -Math.PI / 2, mode: "walk" });
      sf.hud?.setHidden?.(true);
      // Clear the marine layer: this harness is about the sand, not the fog.
      if (fog !== null) sf.WORLD_TUNING.fogMaster = fog;
      // Pin the hour through the sky's own hook. Assigning sky.timeOfDay does
      // NOT stick — the sky follows the real SF clock and overwrites it, so
      // two runs an hour apart grade completely differently. Mid-afternoon
      // puts the sun over the ocean but high enough to light the sand.
      sf.sky.setTimeOfDay(14.5);
      const waterX = waterlineAt(camZ);
      // Place cameras by ELEVATION, not by distance from a scanned waterline.
      // Ocean Beach's profile varies enough along its length that "30 m inland"
      // is ankle-deep water at one station and the top of a berm at the next,
      // and the scan itself shifts a few metres as terrain tiles stream in.
      // Asking for "the x where the sand is 1.6 m above the sea" is stable.
      const at = (targetY) => {
        let x = waterX - 30;
        for (let d = 0; d <= 260; d += 0.5) {
          x = waterX - 30 + d;
          if (sf.map.groundTop(x, camZ) >= targetY) break;
        }
        return x;
      };
      const shore = {};
      for (const y of [0, 0.6, 1.6, 3, 6, 12]) shore[y] = at(y);
      return { waterX, standX, standY, shore };
    }, [SHOT_Z, CAM_Z, process.env.SF_SHOREBREAK_FOG === "default" ? null : 0.02]);
    process.stdout.write(`anchor ${JSON.stringify(anchor)}\n`);
    // The sheet is a lazy chunk with a detached warm-up compile; how long that
    // takes is not something a fixed sleep should be guessing at.
    await page
      .waitForFunction(() => Boolean(window.__sf?.getShorebreak?.()), null, { timeout: 90_000 })
      .catch(() => process.stdout.write("WARN: shorebreak never loaded — shooting anyway\n"));
    await page.waitForTimeout(4000);
    const sheet = await page.evaluate(() => ({
      hook: typeof window.__sf?.getShorebreak,
      inScene: Boolean(window.__sf?.scene?.getObjectByName?.("ocean_beach_shorebreak")),
      state: window.__sf?.getShorebreak?.()?.debugState?.() ?? null
    }));
    process.stdout.write(`sheet ${JSON.stringify(sheet)}\n`);

    const { waterX, shore } = anchor;
    const SHOTS = [
      {
        // Eye height of someone standing on the dry sand, looking down-beach
        // at the wash rather than straight into the afternoon sun.
        name: "01-stand-eye-level",
        eye: [shore[3], 3 + 1.7, CAM_Z + 52],
        target: [shore[0] - 8, 0.2, CAM_Z - 34]
      },
      {
        // Low and close, but on DRY sand: an eye placed off the ground near
        // the waterline ends up under the ocean on the frames that matter.
        name: "02-swash-edge-low",
        eye: [shore[1.6], 1.6 + 0.85, CAM_Z + 20],
        target: [shore[0] - 5, 0.3, CAM_Z - 14]
      },
      {
        // Down the beach: several foam lines and their run-up scallops at once.
        name: "03-beach-oblique",
        eye: [shore[6], 6 + 9, CAM_Z - 190],
        target: [shore[0] - 8, 0.0, CAM_Z + 240]
      },
      {
        // Steep oblique over the swash: run-up geometry and the wet-sand
        // memory, both read as shapes from up here. Not straight down —
        // __sfFreeCam uses lookAt with up=+Y, which degenerates at nadir.
        name: "04-plan",
        eye: [shore[12], 12 + 48, CAM_Z - 58],
        target: [shore[0] - 14, 0, CAM_Z + 12]
      }
    ];

    const only = process.env.SF_SHOREBREAK_ONLY;
    for (const shot of only ? SHOTS.filter((s) => s.name.includes(only)) : SHOTS) {
      await page.evaluate((pose) => window.__sfFreeCam(pose.eye, pose.target), shot);
      await page.waitForTimeout(700);
      for (let i = 0; i < PHASES; i++) {
        // The wash clock is pinned, not waited on: every wave differs, so
        // wall-clock shots sample an arbitrary one and two runs never line up.
        // SPAN periods spread over PHASES steps walks consecutive waves.
        await page.evaluate(
          (t) => window.__sf?.getShorebreak?.()?.setDebugTime?.(t),
          BASE_TIME + (i * SET_PERIOD * SPAN) / PHASES
        );
        await page.waitForTimeout(220);
        const file = path.join(OUT, `${shot.name}-p${i}.png`);
        // Viewport shot, not an element shot: Playwright waits for an element
        // to stop moving before capturing it, and a full-fps WebGPU canvas
        // never does. The canvas fills the viewport, so this is the same pixels.
        await page
          .screenshot({ path: file, timeout: 90_000 })
          .catch(() => page.screenshot({ path: file, timeout: 90_000 }));
        results[`${shot.name}-p${i}`] = await audit(file);
      }
    }

    // One contact sheet per pose: a wash cycle is a sequence, and judging it
    // frame by frame hides whether the thing actually moves.
    for (const shot of only ? SHOTS.filter((s) => s.name.includes(only)) : SHOTS) {
      const tiles = await Promise.all(
        Array.from({ length: PHASES }, (_, i) =>
          sharp(path.join(OUT, `${shot.name}-p${i}.png`)).resize(520, 325).toBuffer()
        )
      );
      const cols = Math.min(4, PHASES);
      await sharp({
        create: {
          width: 520 * cols,
          height: 325 * Math.ceil(PHASES / cols),
          channels: 3,
          background: "#000"
        }
      })
        .composite(tiles.map((input, i) => ({ input, left: 520 * (i % cols), top: 325 * Math.floor(i / cols) })))
        .png()
        .toFile(path.join(OUT, `${shot.name}-contact.png`));
    }

    await writeFile(
      path.join(OUT, "audit.json"),
      `${JSON.stringify({ label: LABEL, anchor, results, pageErrors, consoleErrors }, null, 2)}\n`
    );
    process.stdout.write(`${JSON.stringify({ out: OUT, results, pageErrors: pageErrors.slice(0, 5) }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
