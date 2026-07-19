// Sampled nature-bed lifecycle contract. Runs against an existing dev server:
//   SF_PROBE_URL=http://127.0.0.1:5245 node tools/nature-audio-lifecycle-browser-probe.mjs

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5245";
const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error("Chrome not found; set CHROME_BIN");

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--mute-audio"
  ]
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const requests = [];
const errors = [];
page.on("request", (request) => requests.push(request.url()));
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto(`${BASE_URL}/?autostart=1&spawn=landsEnd`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  // The Lands End arrival streams substantial optional scenery. Audio only
  // needs the core debug/runtime surface; it must not wait for the full visual
  // arrival gate before beginning its own first-approach lifecycle.
  await page.waitForFunction(
    () => Boolean(window.__sf?.nature && window.__sf?.camera),
    null,
    { timeout: 120_000 }
  );
  await page.waitForTimeout(600);

  const natureRequests = () => requests.filter((url) => url.includes("/audio/nature/") && url.endsWith(".mp3"));
  assert.equal(natureRequests().length, 0, "sampled nature beds fetched before the first audio gesture");

  await page.keyboard.press("/");
  await page.waitForFunction(
    () => window.__sf?.nature?.debugState?.beds?.every((bed) => bed.loaded),
    null,
    { timeout: 45_000 }
  );
  await page.waitForFunction(
    () => window.__sf.nature.debugState.beds.some((bed) => bed.running),
    null,
    { timeout: 10_000 }
  );

  const active = await page.evaluate(() => window.__sf.nature.debugState);
  assert.equal(new Set(natureRequests()).size, 4, `expected four first-approach bed requests: ${JSON.stringify(natureRequests())}`);
  assert(active.beds.every((bed) => bed.loaded), `not every bed decoded: ${JSON.stringify(active.beds)}`);
  assert(active.beds.every((bed) => bed.running), `not every decoded bed started: ${JSON.stringify(active.beds)}`);

  const lifecycle = await page.evaluate(() => {
    const nature = window.__sf.nature;
    const cityFrame = {
      playerPos: { x: 3680, y: 20, z: 120 },
      camera: window.__sf.camera,
      gust: 0.2,
      timeOfDay: 12,
      allowNewLoads: false
    };
    nature.update(5, cityFrame);
    const parked = nature.debugState;
    nature.update(61, cityFrame);
    const unloaded = nature.debugState;
    return { parked, unloaded };
  });

  assert(
    lifecycle.parked.beds.every((bed) => !bed.running),
    `bed sources did not park after the release delay: ${JSON.stringify(lifecycle.parked.beds)}`
  );
  assert(lifecycle.parked.decodedBedMiB > 20, "parking sources should retain warm decoded buffers briefly");
  assert.equal(lifecycle.unloaded.decodedBedMiB, 0, "decoded bed buffers were not released after long idle");
  assert(
    lifecycle.unloaded.beds.every((bed) => !bed.loaded && !bed.running),
    `unloaded beds retained runtime state: ${JSON.stringify(lifecycle.unloaded.beds)}`
  );
  assert.deepEqual(errors, [], `browser errors:\n${errors.join("\n")}`);

  console.log("nature audio lifecycle browser probe: PASS", {
    requests: natureRequests(),
    activeDecodedMiB: active.decodedBedMiB,
    parkedDecodedMiB: lifecycle.parked.decodedBedMiB,
    unloadedDecodedMiB: lifecycle.unloaded.decodedBedMiB
  });
} finally {
  await browser.close();
}
