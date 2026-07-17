import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "playwright-core";

const url = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240/?autostart=1&fullfps=1";
const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].filter(Boolean).find((candidate) => !candidate.includes("/") || existsSync(candidate));

if (!chrome) throw new Error("No Chrome/Chromium executable found. Set CHROME_BIN.");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
async function waitHttp(target, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(target, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${target}`);
}
async function startDev() {
  const origin = new URL(url).origin;
  try {
    await waitHttp(origin, 1_500);
    return null;
  } catch {}
  const port = Number(new URL(origin).port);
  const relayPort = await freePort();
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      env: { ...process.env, SF_RELAY_PORT: String(relayPort) },
      stdio: "ignore"
    }
  );
  await waitHttp(origin, 90_000);
  return child;
}

let dev;
let browser;

try {
  dev = await startDev();
  browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      "--use-angle=metal",
      "--mute-audio"
    ]
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(
    () => Boolean(window.__sf?.renderer?.backend?.device && window.__sf?.player),
    undefined,
    { timeout: 180_000 }
  );
  await page.evaluate(() => window.__sfManual?.(true));

  const audit = await page.evaluate(async () => {
    const sf = window.__sf;
    const device = sf.renderer.backend.device;
    const modes = [
      "walk",
      "drive",
      "scooter",
      "board",
      "drone",
      "plane",
      "boat",
      "speedboat",
      "surf",
      "bird"
    ];
    const frames = [];
    const effectivelyVisible = (object) => {
      for (let current = object; current; current = current.parent) {
        if (!current.visible) return false;
        if (current === sf.scene) return true;
      }
      // Detached roots can be made visible temporarily for shader warmup, but
      // cannot draw and therefore are not active scene embodiments.
      return false;
    };
    const snapshot = (requested) => ({
      requested,
      active: sf.player.mode,
      visibleRoots: Object.entries(sf.player.meshes)
        .filter(([, root]) => effectivelyVisible(root))
        .map(([mode, root]) => ({ mode, position: root.position.toArray() }))
    });

    for (const mode of modes) {
      sf.player.trySwitch(mode);
      for (let i = 0; i < 3; i++) {
        sf.tick(1 / 60);
        await device.queue.onSubmittedWorkDone();
      }
      frames.push(snapshot(mode));
    }
    return frames;
  });

  for (const frame of audit) {
    assert.equal(frame.active, frame.requested, `mode switch did not commit: ${JSON.stringify(frame)}`);
    assert.deepEqual(
      frame.visibleRoots.map(({ mode }) => mode),
      [frame.requested],
      `inactive local embodiment remained visible: ${JSON.stringify(frame)}`
    );
  }
  const gpuErrors = runtimeErrors.filter((message) =>
    /WebGPU|GPUValidation|WGSL|render pipeline|bind group|TypeError/i.test(message)
  );
  assert.deepEqual(gpuErrors, [], `WebGPU/runtime errors: ${gpuErrors.join("\n")}`);
  console.log(JSON.stringify({ audit, runtimeErrors }, null, 2));
} finally {
  await browser?.close();
  dev?.kill("SIGTERM");
}
