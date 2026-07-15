import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
const OUT = path.resolve(".data/water-echo-probe");
const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].find((candidate) => candidate && existsSync(candidate));

if (!chrome) throw new Error("Chrome not found; set CHROME_BIN");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--mute-audio"
  ]
});

const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
  await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(
    () => Boolean(
      window.__sf?.player &&
      window.__sf?.water?.echoes &&
      window.__sf?.renderer?.backend?.device &&
      window.__sf?.renderIdle?.() &&
      window.__sf?.worldArrival?.snapshot?.state === "idle"
    ),
    null,
    { timeout: 180_000 }
  );

  const boot = await page.evaluate(() => ({
    mode: window.__sf.player.mode,
    shadows: window.__sf.water.echoes.shadows.count,
    lights: window.__sf.water.echoes.lights.count,
    phoenixRequested: performance.getEntriesByType("resource")
      .some((entry) => entry.name.includes("/models/phoenix.glb"))
  }));
  if (boot.shadows !== 0 || boot.lights !== 0) {
    throw new Error(`clean boot allocated visible echoes: ${JSON.stringify(boot)}`);
  }
  if (boot.phoenixRequested) throw new Error("clean boot eagerly requested phoenix.glb");

  await page.evaluate(() => {
    const sf = window.__sf;
    sf.sky.cycleEnabled = false;
    sf.sky.setTimeOfDay(20.35);
    sf.player.teleportTo({ x: 5200, y: 72, z: -650, facing: -2.58, mode: "bird" });
  });
  await page.waitForFunction(
    () => Boolean(window.__sf.player.meshes.bird.userData.rig),
    null,
    { timeout: 60_000 }
  );

  await page.evaluate(async () => {
    const sf = window.__sf;
    window.__sfManual(true);
    window.__sfFreeCam([5070, 38, -820], [5150, 18, -700]);
    sf.hud?.setHidden?.(true);
    const loading = document.getElementById("loading");
    if (loading) loading.style.display = "none";
    for (let i = 0; i < 150; i++) {
      sf.tick(1 / 60);
      await sf.renderer.backend.device.queue.onSubmittedWorkDone();
    }
  });

  const active = await page.evaluate(() => {
    const sf = window.__sf;
    const shadows = sf.water.echoes.shadows;
    const matrix = new sf.THREE.Matrix4().fromArray(shadows.instanceMatrix.array, 0);
    const center = new sf.THREE.Vector3();
    matrix.decompose(center, new sf.THREE.Quaternion(), new sf.THREE.Vector3());
    return {
      mode: sf.player.mode,
      shadows: shadows.count,
      lights: sf.water.echoes.lights.count,
      shadowVisible: shadows.visible,
      lightVisible: sf.water.echoes.lights.visible,
      center: center.toArray(),
      data: Array.from(shadows.geometry.getAttribute("echoData").array.slice(0, 4)),
      color: Array.from(shadows.geometry.getAttribute("echoColor").array.slice(0, 3)),
      phoenixRequested: performance.getEntriesByType("resource")
        .some((entry) => entry.name.includes("/models/phoenix.glb")),
      phoenixResources: performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => /phoenix|vehicles\/bird|asset-/.test(name))
    };
  });
  if (active.shadows < 1 || active.lights < 1 || !active.shadowVisible || !active.lightVisible) {
    throw new Error(`phoenix echo did not activate: ${JSON.stringify(active)}`);
  }
  if (!active.phoenixRequested) throw new Error(`phoenix asset request was not observable: ${JSON.stringify(active)}`);
  if (errors.length) throw new Error(`browser errors: ${errors.slice(0, 5).join(" | ")}`);

  const screenshot = path.join(OUT, "phoenix-bay.png");
  await page.screenshot({ path: screenshot });
  await page.evaluate(async ([x, , z]) => {
    const sf = window.__sf;
    window.__sfFreeCam([x - 44, 46, z - 58], [x, 0, z]);
    for (let i = 0; i < 36; i++) {
      sf.tick(1 / 60);
      await sf.renderer.backend.device.queue.onSubmittedWorkDone();
    }
  }, active.center);
  const closeScreenshot = path.join(OUT, "phoenix-echo-close.png");
  await page.screenshot({ path: closeScreenshot });
  console.log(JSON.stringify({ boot, active, screenshot, closeScreenshot }, null, 2));
} finally {
  await browser.close();
}
