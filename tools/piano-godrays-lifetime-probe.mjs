// WebGPU regression probe for the piano grove's lazy god-ray teardown.
//
// The dedicated directional light participates in the scene's retained render
// bundles while the effect is active. Leaving the grove must keep its shadow
// texture alive until those bundles have re-recorded without the light; an
// immediate Light.dispose() produces:
//   Destroyed texture "ShadowDepthTexture" used in a submit.
//
// Usage:
//   npm run test:godrays:lifetime
//   SF_PROBE_URL=http://127.0.0.1:5241 npm run test:godrays:lifetime

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data", "piano-godrays-lifetime");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a probe port"));
      server.close(() => resolve(address.port));
    });
  });
}

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

async function waitHttp(url, timeoutMs = 90_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startServer() {
  if (process.env.SF_PROBE_URL) {
    const url = process.env.SF_PROBE_URL.replace(/\/$/, "");
    await waitHttp(url, 15_000);
    return { url, process: null };
  }
  const port = await freePort();
  const relayPort = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    "npm",
    ["run", "dev:play", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: ROOT,
      env: { ...process.env, SF_RELAY_PORT: String(relayPort) },
      stdio: "ignore",
      detached: process.platform !== "win32"
    }
  );
  await waitHttp(url);
  return { url, process: child };
}

function stopServer(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

const isLifetimeValidation = (message) =>
  /Destroyed texture.*ShadowDepthTexture|ShadowDepthTexture.*used in a submit|GPUValidationError/i.test(message);

const server = await startServer();
const chrome = await findChrome();
let browser;

try {
  await mkdir(OUT, { recursive: true });
  browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-gpu",
      "--use-angle=metal",
      "--disable-gpu-sandbox",
      "--mute-audio"
    ]
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleMessages = [];
  const featureRequests = [];
  page.on("console", (entry) => consoleMessages.push(`[${entry.type()}] ${entry.text()}`));
  page.on("pageerror", (error) => consoleMessages.push(`[pageerror] ${error.stack || error.message}`));
  page.on("request", (request) => {
    if (/pianoGodRays/i.test(request.url())) featureRequests.push(request.url());
  });

  await page.goto(`${server.url}/?autostart=1&fullfps=1`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForFunction(
    () => Boolean(window.__sf?.pipeline && window.__sf?.renderer?.backend?.device && window.__sf?.tick),
    null,
    { timeout: 180_000 }
  );
  assert.deepEqual(featureRequests, [], "clean boot eagerly requested the piano god-ray module");
  await page.evaluate(() => {
    window.__sf.POSTFX_TUNING.values.pianistRays = true;
    window.__sf.teleportToTarget(-3340, -870, "god-ray lifetime probe");
  });
  await page.waitForFunction(
    () => {
      const sf = window.__sf;
      const arrival = sf?.worldArrival?.snapshot;
      return arrival?.state === "idle" && !sf.player.worldArrivalHeld;
    },
    null,
    { timeout: 180_000 }
  );
  await page.waitForFunction(
    () => {
      const state = window.__sf?.pipeline?.pianoGodRaysState;
      return state?.requested && state?.loaded && state?.active && state.renderedFrames > 1;
    },
    null,
    { timeout: 180_000 }
  );
  assert.equal(featureRequests.length, 1, "first activation must request exactly the lazy god-ray module");

  const cycleReports = [];
  for (let cycle = 0; cycle < 2; cycle++) {
    if (cycle > 0) {
      await page.evaluate(() => {
        const sf = window.__sf;
        const y = sf.map.effectiveGround(-3340, -870) + 1.5;
        sf.player.teleportTo({ x: -3340, y, z: -870, facing: 0, mode: "walk" });
      });
      await page.waitForFunction(
        () => {
          const state = window.__sf?.pipeline?.pianoGodRaysState;
          return state?.requested && state?.loaded && state?.active;
        },
        null,
        { timeout: 30_000 }
      );
    }

    const active = await page.evaluate(() => ({ ...window.__sf.pipeline.pianoGodRaysState }));
    assert.equal(active.active, true, `cycle ${cycle + 1}: god rays did not activate`);
    const destroyedBefore = await page.evaluate(
      () => window.__sf.pipeline.textureDisposalState?.destroyed ?? 0
    );
    const errorStart = consoleMessages.length;

    await page.evaluate(() => {
      const sf = window.__sf;
      const x = -3160;
      const z = -870;
      const y = sf.map.effectiveGround(x, z) + 1.5;
      sf.player.teleportTo({ x, y, z, facing: 0, mode: "walk" });
    });
    await page.waitForFunction(
      (destroyedAtExit) => {
        const pipeline = window.__sf?.pipeline;
        const state = pipeline?.pianoGodRaysState;
        const disposal = pipeline?.textureDisposalState;
        return state && !state.requested && !state.active && !state.loaded &&
          disposal?.pending === 0 && disposal.destroyed > destroyedAtExit;
      },
      destroyedBefore,
      { timeout: 30_000 }
    );
    await page.waitForTimeout(1000);

    const cycleMessages = consoleMessages.slice(errorStart);
    const validation = cycleMessages.filter(isLifetimeValidation);
    if (validation.length > 0) {
      await page.screenshot({ path: path.join(OUT, `failure-cycle-${cycle + 1}.png`) });
    }
    assert.deepEqual(validation, [], `cycle ${cycle + 1}: ${validation.join("\n")}`);

    const inactive = await page.evaluate(() => ({ ...window.__sf.pipeline.pianoGodRaysState }));
    assert.equal(inactive.active, false, `cycle ${cycle + 1}: god rays remained active`);
    assert.equal(inactive.loaded, false, `cycle ${cycle + 1}: god-ray runtime did not unload`);
    const destroyedAfter = await page.evaluate(
      () => window.__sf.pipeline.textureDisposalState?.destroyed ?? 0
    );
    cycleReports.push({
      cycle: cycle + 1,
      retiredRawTextures: destroyedAfter - destroyedBefore,
      validationErrors: validation.length
    });
  }
  assert.equal(featureRequests.length, 1, "second activation must reuse the already-fetched god-ray module");

  const canvas = page.locator("#app canvas").first();
  const screenshot = await canvas.screenshot({ path: path.join(OUT, "success.png") });
  const pixels = PNG.sync.read(screenshot);
  let minLuma = 255;
  let maxLuma = 0;
  let lumaTotal = 0;
  const pixelCount = pixels.width * pixels.height;
  for (let i = 0; i < pixels.data.length; i += 4) {
    const luma = Math.round(
      pixels.data[i] * 0.2126 + pixels.data[i + 1] * 0.7152 + pixels.data[i + 2] * 0.0722
    );
    minLuma = Math.min(minLuma, luma);
    maxLuma = Math.max(maxLuma, luma);
    lumaTotal += luma;
  }
  assert.ok(maxLuma - minLuma > 10, "final renderer canvas is visually blank");

  const report = {
    cycles: cycleReports,
    featureRequests,
    lifetimeValidationErrors: consoleMessages.filter(isLifetimeValidation),
    finalState: await page.evaluate(() => ({ ...window.__sf.pipeline.pianoGodRaysState })),
    textureDisposal: await page.evaluate(() => ({ ...window.__sf.pipeline.textureDisposalState })),
    canvas: {
      width: pixels.width,
      height: pixels.height,
      minLuma,
      maxLuma,
      meanLuma: lumaTotal / pixelCount
    }
  };
  await writeFile(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log("piano god-ray lifetime: ok (2 activate/render/deactivate/unload cycles, 0 validation errors)");
} finally {
  await browser?.close();
  stopServer(server.process);
}
