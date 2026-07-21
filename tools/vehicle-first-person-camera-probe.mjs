// End-to-end regression probe for the C-cycle first-person camera in every
// travel mode. Boots the real WebGPU app, switches the live Player through all
// embodiments, and verifies that the settled camera reaches each animated eye
// (or the stock drone gimbal) without hiding the vehicle root.
//
//   SF_URL=http://127.0.0.1:5244 node tools/vehicle-first-person-camera-probe.mjs

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data", "vehicle-first-person-camera");
const URL = process.env.SF_URL ?? "http://127.0.0.1:5244";
const CHROME = process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODES = [
  "walk",
  "drive",
  "scooter",
  "plane",
  "boat",
  "speedboat",
  "drone",
  "board",
  "surf",
  "bird"
];

await mkdir(OUT, { recursive: true });
const errors = [];
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--mute-audio"
  ]
});

let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${URL}/?autostart=1&profile=1&fullfps=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(() => Boolean(window.__sf?.player), null, {
    timeout: 120_000
  });
  await page.evaluate(() => window.__sfManual(true));

  const pressC = () => page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyC" }));
    window.__sf.tick(1 / 60);
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyC" }));
    window.__sf.tick(1 / 60);
    return window.__sf.chase.manualFirstPerson;
  });
  const cCycleEnabled = await pressC();

  const outdoorFov = await page.evaluate(() => window.__sf.camera.fov);
  const results = [];
  for (const mode of MODES) {
    const result = await page.evaluate((nextMode) => {
      const s = window.__sf;
      const p = s.player;
      if (p.mode !== nextMode) p.trySwitch(nextMode);
      s.chase.manualFirstPerson = true;
      for (let i = 0; i < 150; i++) {
        p.syncMesh(1 / 60);
        s.chase.update(1 / 60, p, s.input);
        s.input.endFrame();
      }
      const eye = new s.THREE.Vector3();
      const direction = new s.THREE.Vector3();
      p.firstPersonViewPosition(eye);
      s.camera.getWorldDirection(direction);
      return {
        mode: p.mode,
        blend: s.chase.firstPersonBlend,
        eyeError: s.camera.position.distanceTo(eye),
        anchorDistance: s.camera.position.distanceTo(p.renderPosition),
        directionLength: direction.length(),
        fov: s.camera.fov,
        vehicleVisible: p.meshes[p.mode].visible
      };
    }, mode);
    results.push(result);
    console.log(`[${mode}] ${JSON.stringify(result)}`);
    if (mode === "drive" || mode === "scooter") {
      await page.evaluate(() => window.__sf.tick(1 / 60));
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `${mode}.png`) });
    }
  }

  const zoomCheck = await page.evaluate(() => {
    const s = window.__sf;
    const before = s.chase.zoom;
    s.input.wheel = 1000;
    s.chase.update(1 / 60, s.player, s.input);
    return { before, after: s.chase.zoom };
  });
  // The authored surf shot remains the third-person default, but C must be able
  // to leave it just like every other vehicle. Return the UI cycle to third,
  // enter surf, then exercise the real key path back into first person.
  await pressC(); // first -> orbit
  await pressC(); // orbit -> third
  await page.evaluate(() => window.__sf.player.trySwitch("surf"));
  const surfCCycleEnabled = await pressC(); // third -> first
  const exit = await page.evaluate(() => {
    const s = window.__sf;
    s.chase.manualFirstPerson = false;
    for (let i = 0; i < 150; i++) {
      s.player.syncMesh(1 / 60);
      s.chase.update(1 / 60, s.player, s.input);
      s.input.endFrame();
    }
    return {
      blend: s.chase.firstPersonBlend,
      cameraDistance: s.camera.position.distanceTo(s.player.renderPosition)
    };
  });

  const checks = {
    cCycleEnablesVehicleFirstPerson: cCycleEnabled,
    cCycleEnablesSurfFirstPerson: surfCCycleEnabled,
    everyModeReachedEye: results.every((r) => r.mode && r.blend > 0.999 && r.eyeError < 0.035),
    everyVehicleRemainsVisible: results
      .filter((r) => r.mode !== "walk")
      .every((r) => r.vehicleVisible),
    everyDirectionValid: results.every((r) => Math.abs(r.directionLength - 1) < 1e-5),
    firstPersonFovApplied: results.every((r) => r.fov > outdoorFov + 10),
    zoomIgnoredInFirstPerson: Math.abs(zoomCheck.after - zoomCheck.before) < 1e-9,
    returnsToThirdPerson: exit.blend < 0.001 && exit.cameraDistance > 2,
    noPageErrors: errors.length === 0
  };
  for (const [name, pass] of Object.entries(checks)) {
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}`);
  }
  if (errors.length) console.log("[page errors]", errors);
  failed = Object.values(checks).some((pass) => !pass);
} finally {
  await browser.close();
}

if (failed) process.exitCode = 1;
