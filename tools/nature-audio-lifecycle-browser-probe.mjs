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
  await page.waitForFunction(() => {
    const beds = window.__sf?.nature?.debugState?.beds;
    const wanted = beds?.filter((bed) => bed.wanted) ?? [];
    return wanted.length === 3 && wanted.every((bed) => bed.loaded && bed.running && !bed.loading);
  }, null, { timeout: 45_000 });

  const landsEnd = await page.evaluate(() => window.__sf.nature.debugState);
  const landsEndRequests = [...new Set(natureRequests())];
  const landsEndWanted = landsEnd.beds.filter((bed) => bed.wanted);
  const landsEndUnused = landsEnd.beds.filter((bed) => !bed.wanted);
  assert.equal(landsEndRequests.length, 3, `expected only three Lands End bed requests: ${JSON.stringify(landsEndRequests)}`);
  assert.equal(landsEndWanted.length, 3, `unexpected Lands End wanted set: ${JSON.stringify(landsEnd.beds)}`);
  assert(landsEndWanted.every((bed) => bed.loaded && bed.running), `wanted Lands End bed did not start: ${JSON.stringify(landsEnd.beds)}`);
  assert(landsEndUnused.every((bed) => !bed.loaded && !bed.running), `unused Lands End bed was fetched or started: ${JSON.stringify(landsEnd.beds)}`);
  assert(!landsEndRequests.some((url) => url.endsWith("/forest-birds.mp3")), "Lands End fetched its absent forest-birds bed");
  assert(landsEnd.decodedBedMiB > 40 && landsEnd.decodedBedMiB < 80, `unexpected three-bed decoded footprint: ${landsEnd.decodedBedMiB} MiB`);

  // Cross into the Botanical Garden, which overlaps Golden Gate Park and uses
  // all four beds. The resident Lands End trio stays warm; only forest birds
  // may be requested and decoded as new work.
  await page.evaluate(() => {
    window.__sf.player.teleportTo({ x: -2290, y: 0, z: 2470, facing: -0.72, mode: "walk" });
  });
  await page.waitForFunction(() => {
    const state = window.__sf?.nature?.debugState;
    return state?.beds?.length === 4 && state.beds.every((bed) => bed.wanted && bed.loaded && bed.running && !bed.loading);
  }, null, { timeout: 45_000 });

  const botanical = await page.evaluate(() => window.__sf.nature.debugState);
  const botanicalRequests = [...new Set(natureRequests())];
  const newlyRequested = botanicalRequests.filter((url) => !landsEndRequests.includes(url));
  assert.equal(botanicalRequests.length, 4, `expected four total requests after entering the garden: ${JSON.stringify(botanicalRequests)}`);
  assert.equal(newlyRequested.length, 1, `garden transition fetched more than its one missing bed: ${JSON.stringify(newlyRequested)}`);
  assert(newlyRequested[0].endsWith("/forest-birds.mp3"), `garden transition fetched the wrong bed: ${newlyRequested[0]}`);
  assert(botanical.decodedBedMiB > landsEnd.decodedBedMiB, "four-bed garden footprint did not exceed the three-bed Lands End footprint");

  // Return to Lands End and advance the residency clock in one deterministic
  // update. The garden-only forest bed should release after 30 seconds while the
  // other three keep running. This is deliberately shorter than the 60-second
  // all-region idle cache used when leaving nature entirely.
  await page.evaluate(() => {
    window.__sf.player.teleportTo({ x: -5872, y: 0, z: 792, facing: 2, mode: "walk" });
  });
  await page.waitForFunction(() => {
    const beds = window.__sf?.nature?.debugState?.beds ?? [];
    return beds.filter((bed) => bed.wanted).length === 3 && !beds.find((bed) => bed.id === "forestBirds")?.wanted;
  }, null, { timeout: 20_000 });

  const retired = await page.evaluate(() => {
    const nature = window.__sf.nature;
    nature.update(31, {
      playerPos: { x: -5872, y: 60, z: 792 },
      camera: window.__sf.camera,
      gust: 0.2,
      timeOfDay: 12,
      allowNewLoads: false
    });
    return nature.debugState;
  });
  const retiredForest = retired.beds.find((bed) => bed.id === "forestBirds");
  assert(retiredForest && !retiredForest.wanted && !retiredForest.loaded && !retiredForest.running, `garden-only bed was not retired: ${JSON.stringify(retiredForest)}`);
  assert(retired.beds.filter((bed) => bed.wanted).every((bed) => bed.loaded && bed.running), `resident Lands End trio did not survive transition: ${JSON.stringify(retired.beds)}`);
  assert.equal(retired.decodedBedMiB, landsEnd.decodedBedMiB, "returning to Lands End did not recover the original decoded footprint");

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
    landsEndRequests,
    botanicalNewRequests: newlyRequested,
    landsEndDecodedMiB: landsEnd.decodedBedMiB,
    botanicalDecodedMiB: botanical.decodedBedMiB,
    retiredDecodedMiB: retired.decodedBedMiB,
    parkedDecodedMiB: lifecycle.parked.decodedBedMiB,
    unloadedDecodedMiB: lifecycle.unloaded.decodedBedMiB
  });
} finally {
  await browser.close();
}
