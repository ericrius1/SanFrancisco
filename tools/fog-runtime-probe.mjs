// Headless browser contract for the fog UI, post-reveal live feed, procedural-
// only lazy path, and simulated-clock gating.
// Run against an existing dev server:
//   SF_PROBE_URL=http://127.0.0.1:5242 node tools/fog-runtime-probe.mjs

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5242";
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
page.on("request", (request) => {
  const url = request.url();
  if (url.includes("liveFog") || url.includes("/api/weather/fog")) requests.push(url);
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

async function load() {
  await page.goto(`${URL}/?autostart=1&fullfps`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__sf?.renderIdle?.(), null, { timeout: 120_000 });
  await page.waitForTimeout(1200);
}

try {
  // Default blend mode: procedural renders first, then the post-reveal adapter
  // and same-origin observation request appear.
  await load();
  assert(requests.some((url) => url.includes("liveFog")), "default mode never loaded liveFog chunk");
  assert(requests.some((url) => url.includes("/api/weather/fog")), "default mode never requested weather API");

  await page.keyboard.press("/");
  const search = page.locator('input[aria-label="Search tweaks"]');
  await search.waitFor({ state: "visible", timeout: 5000 });
  for (const label of ["master density", "weather source", "live influence", "driver", "sf date"]) {
    await search.fill(label);
    await page.waitForTimeout(100);
    const paneText = (await page.locator("body").innerText()).toLowerCase();
    assert(paneText.includes(label), `fog pane missing ${label}`);
  }
  await search.fill("");

  // Preserve the registered schema fingerprint from the first load, then pin
  // only this group's persisted source to procedural and reload from scratch.
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("sf-tweaks") ?? "{}");
    saved["world.fogWeather"] = "procedural";
    localStorage.setItem("sf-tweaks", JSON.stringify(saved));
  });
  requests.length = 0;
  await load();
  assert(
    !requests.some((url) => url.includes("liveFog") || url.includes("/api/weather/fog")),
    `procedural-only reload eagerly requested ${requests.join(", ")}`
  );

  const procedural = await page.evaluate(() => {
    const out = {};
    window.__sf.sky.writeFogWeatherDiagnostics(out);
    return out;
  });
  assert.equal(procedural.driver, "procedural");

  // First activation loads on demand. Pinning simulated time then drops live
  // influence immediately and advances the calendar across midnight.
  requests.length = 0;
  const weatherResponse = page.waitForResponse(
    (response) => response.url().includes("/api/weather/fog"),
    { timeout: 12_000 }
  );
  await page.evaluate(() => {
    window.__sf.WORLD_TUNING.values.fogWeather = "blend";
    window.__sf.sky.refreshFogWeatherSource();
  });
  await weatherResponse;
  assert(requests.some((url) => url.includes("/api/weather/fog")), "activation did not request weather API");

  const simulated = await page.evaluate(() => {
    const sky = window.__sf.sky;
    sky.setCivilTime({ year: 2026, month: 7, day: 31, hour: 23.5 });
    sky.advanceCivilHours(1);
    const out = {};
    sky.writeFogWeatherDiagnostics(out);
    return { civil: sky.civilTime, diagnostics: out };
  });
  assert.equal(simulated.civil.year, 2026);
  assert.equal(simulated.civil.month, 8);
  assert.equal(simulated.civil.day, 1);
  assert(Math.abs(simulated.civil.hour - 0.5) < 1e-8, `rollover hour ${simulated.civil.hour}`);
  assert.equal(simulated.diagnostics.driver, "procedural · simulated clock");
  assert.equal(simulated.diagnostics["live mix"], "0%");

  assert.equal(errors.length, 0, `browser errors:\n${errors.join("\n")}`);
  console.log(JSON.stringify({
    ok: true,
    defaultLiveRequests: 2,
    proceduralBootRequests: 0,
    activatedRequests: requests.length,
    simulated
  }, null, 2));
} finally {
  await browser.close();
}
