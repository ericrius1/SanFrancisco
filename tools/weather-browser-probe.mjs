import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://localhost:5268";
const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) throw new Error("Chrome not found; set CHROME_BIN");

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal"]
});

async function readyPage(weather) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const requests = [];
  const errors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /weather|WebGPU|WGSL/i.test(message.text())) errors.push(message.text());
  });
  await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1&weather=${weather}`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(() => window.__sf?.renderIdle?.(), null, { timeout: 120_000 });
  await page.waitForFunction(() => window.__sf?.worldArrival?.active === false, null, { timeout: 120_000 });
  await page.waitForTimeout(1200);
  return { page, requests, errors };
}

try {
  const clear = await readyPage("clear");
  const clearState = await clear.page.evaluate(() => window.__sf?.getWeather?.()?.debugState);
  assert.equal(clearState.kind, "clear");
  assert.equal(clearState.effects, "dormant", "clear boot must not construct weather effects");
  assert.equal(
    clear.requests.filter((url) => /weatherEffects/i.test(new URL(url).pathname)).length,
    0,
    "clear boot imported the optional weather-effects chunk"
  );
  assert.deepEqual(clear.errors, [], `clear-weather browser errors: ${clear.errors.join("\n")}`);
  await clear.page.close();

  const storm = await readyPage("storm");
  await storm.page.waitForFunction(
    () => window.__sf?.getWeather?.()?.debugState?.effects === "active",
    null,
    { timeout: 20_000 }
  );
  await storm.page.locator(".mixer-btn").click();
  await storm.page.waitForFunction(
    () => window.__sf?.getWeather?.()?.debugState?.effectState?.audio === true,
    null,
    { timeout: 8_000 }
  );
  await storm.page.waitForFunction(
    () => window.__sf?.getLivingScore?.()?.debugState?.storm > 0.8,
    null,
    { timeout: 40_000 }
  );
  const stormState = await storm.page.evaluate(() => ({
    weather: window.__sf.getWeather().debugState,
    score: window.__sf.getLivingScore().debugState,
    flashCount: document.querySelectorAll("[data-weather-flash]").length
  }));
  assert(stormState.weather.rain > 0.8 && stormState.weather.storm > 0.8);
  assert.equal(stormState.weather.effectState.drops, 520);
  assert(stormState.weather.effectState.visibleRain > 0.8);
  assert.match(stormState.score.direction, /electrical storm/);
  assert.equal(stormState.flashCount, 1);
  assert(
    storm.requests.some((url) => /weatherEffects/i.test(new URL(url).pathname)),
    "storm never imported its optional weather-effects chunk"
  );
  assert.deepEqual(storm.errors, [], `storm browser errors: ${storm.errors.join("\n")}`);

  console.log("weather browser probe: PASS", {
    clear: clearState,
    storm: stormState
  });
} finally {
  await browser.close();
}
