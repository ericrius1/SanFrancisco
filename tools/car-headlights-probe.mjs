// Car brake-light + volumetric headlamp probe.
//
// Boots a known car, enters drive mode, forces night, and verifies:
//   - the headlamp light rig (2 beam cones + 2 ground splashes) exists and is
//     additive / non-shadowing, gated ON at night and OFF by day;
//   - the taillight emissive lerps red → the configured brake colour when the
//     brake (S / down) is held, and relaxes back when released.
// Captures night-cruise and night-braking screenshots for a visual check.
//
// Usage:
//   SF_PROBE_URL=http://127.0.0.1:62859 node tools/car-headlights-probe.mjs

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/car-headlights-probe");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5243").replace(/\/$/, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Distinct violet brake glow so the config → rig colour path is unambiguous.
const BRAKE_HEX = 0x7c3cff;
const SAVED_CAR = {
  form: "coast-coupe",
  surface: "solid",
  decal: "none",
  wheel: "split-five",
  paint: 7, // midnight — dark body so the lights read
  trim: 0,
  interior: 0,
  rim: 0,
  brake: 3, // violet
  paintHex: null,
  trimHex: null,
  interiorHex: null,
  rimHex: null,
  brakeHex: null,
  surfaceScale: 48,
  decalScale: 50,
  decalPosition: 52,
  clearcoat: 72
};

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error("Chrome/Chromium not found; set CHROME_BIN");
}

async function waitHttp(url, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await waitHttp(BASE_URL);
  const browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-gpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      `--use-angle=${process.env.SF_ANGLE ?? (process.platform === "darwin" ? "metal" : "swiftshader")}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--hide-scrollbars",
      "--mute-audio"
    ]
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  await context.addInitScript((car) => localStorage.setItem("sf-car-v1", JSON.stringify(car)), SAVED_CAR);
  const page = await context.newPage();
  const errors = [];
  const checks = [];
  const check = (id, pass, detail) => checks.push({ id, pass, detail });
  page.on("pageerror", (error) => errors.push(`page: ${error}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  try {
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(
      () => window.__sf?.player && document.body.classList.contains("started"),
      undefined,
      { timeout: 180_000 }
    );

    // Enter the car and force deep night so the headlamps switch on.
    await page.keyboard.press("Digit2");
    await page.waitForFunction(() => window.__sf.player.mode === "drive", undefined, { timeout: 15_000 });
    await page.evaluate(() => window.__sf.sky.setTimeOfDay(1)); // 1am
    await sleep(600);

    // Rig structure: 1 carLights group, 4 children (2 beams + 2 splashes), all
    // additive + non-shadowing, plus the configured brake colour.
    const rig = await page.evaluate((brakeHex) => {
      const mesh = window.__sf.player.meshes.drive;
      const group = mesh.getObjectByName("carLights");
      const kids = group ? group.children : [];
      const ADD = 2; // THREE.AdditiveBlending
      const lights = mesh.userData.carLights;
      return {
        hasGroup: !!group,
        childCount: kids.length,
        visibleAtNight: !!group?.visible,
        allAdditive: kids.every((m) => m.material.blending === ADD && m.material.depthWrite === false),
        noneCastOrReceive: kids.every((m) => !m.castShadow && !m.receiveShadow),
        brakeColorHex: lights ? lights.brakeColor.getHex() : null,
        expectedBrakeHex: brakeHex
      };
    }, BRAKE_HEX);
    check("rig-group-present", rig.hasGroup, rig);
    check("rig-has-4-children", rig.childCount === 4, rig);
    check("rig-on-at-night", rig.visibleAtNight, rig);
    check("rig-additive-no-depthwrite", rig.allAdditive, rig);
    check("rig-no-shadow", rig.noneCastOrReceive, rig);
    check("brake-colour-from-config", rig.brakeColorHex === rig.expectedBrakeHex, rig);

    // Roll forward a moment so a following brake reads as deceleration.
    await page.keyboard.down("KeyW");
    await sleep(900);
    await page.keyboard.up("KeyW");
    await sleep(250);
    const resting = await page.evaluate(() => {
      const t = window.__sf.player.meshes.drive.userData.carLights.taillight;
      return { emissive: t.emissive.getHex(), intensity: t.emissiveIntensity };
    });

    // Night cruise screenshot (beams thrown forward, tails at rest).
    await page.screenshot({ path: path.join(OUT, "night-cruise.png"), fullPage: false });

    // Hold the brake (S). brakeLevel is smoothed (~dt*14) so ~0.8s reaches glow.
    await page.keyboard.down("KeyS");
    await sleep(900);
    const braking = await page.evaluate(() => {
      const mesh = window.__sf.player.meshes.drive;
      const t = mesh.userData.carLights.taillight;
      return { emissive: t.emissive.getHex(), intensity: t.emissiveIntensity };
    });
    await page.screenshot({ path: path.join(OUT, "night-braking.png"), fullPage: false });
    await page.keyboard.up("KeyS");
    await sleep(900);
    const released = await page.evaluate(() => {
      const t = window.__sf.player.meshes.drive.userData.carLights.taillight;
      return { emissive: t.emissive.getHex(), intensity: t.emissiveIntensity };
    });

    // Braking must brighten the taillights and shift them toward the violet
    // brake colour (more blue than the resting red), then relax on release.
    const blueOf = (hex) => hex & 0xff;
    check("brake-brightens", braking.intensity > resting.intensity + 0.2, { resting, braking });
    check("brake-shifts-toward-violet", blueOf(braking.emissive) > blueOf(resting.emissive) + 20, { resting, braking });
    check("release-relaxes", released.intensity < braking.intensity - 0.2, { braking, released });

    // Day gate: headlamps off, group hidden.
    await page.evaluate(() => window.__sf.sky.setTimeOfDay(12));
    await sleep(500);
    const day = await page.evaluate(() => {
      const group = window.__sf.player.meshes.drive.getObjectByName("carLights");
      return { visibleByDay: !!group?.visible };
    });
    check("rig-off-by-day", !day.visibleByDay, day);

    // Customizer: a "brake" colour row exists, and picking a new swatch recolours
    // the live rig (proves the glow colour is adjustable in the atelier).
    await page.locator(".car-launcher-ui .car-toggle").click({ force: true });
    await page.locator(".car-panel").waitFor({ state: "visible", timeout: 20_000 });
    const brakeRow = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".car-panel .avatar-row")];
      const row = rows.find((r) => r.querySelector(".avatar-label")?.textContent === "brake");
      return { present: !!row, swatches: row ? row.querySelectorAll(".avatar-swatch").length : 0 };
    });
    check("customizer-has-brake-row", brakeRow.present && brakeRow.swatches >= 5, brakeRow);

    const orchid = 0xd23bff; // CAR_BRAKE_COLORS[1]
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".car-panel .avatar-row")];
      const row = rows.find((r) => r.querySelector(".avatar-label")?.textContent === "brake");
      row.querySelectorAll(".avatar-swatch")[1].click();
    });
    await page.waitForFunction(() => window.__sf.getCarConfig().brake === 1, undefined, { timeout: 10_000 });
    const recolored = await page.evaluate(() => {
      const lights = window.__sf.player.meshes.drive.userData.carLights;
      return { brakeColorHex: lights ? lights.brakeColor.getHex() : null };
    });
    check("customizer-recolors-live-rig", recolored.brakeColorHex === orchid, recolored);

    check("runtime-no-errors", errors.length === 0, errors);
    const report = {
      ok: checks.every((c) => c.pass),
      url: BASE_URL,
      checks,
      resting,
      errors,
      artifacts: [path.join(OUT, "night-cruise.png"), path.join(OUT, "night-braking.png")]
    };
    await writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

await main();
