// Headless responsiveness probe for the debug Tweakpane.
// Run against an existing worktree preview:
//   SF_PROBE_URL=http://127.0.0.1:5240 node tools/tweakpane-performance-probe.mjs

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
const SCREENSHOT_PATH = process.env.SF_PROBE_SCREENSHOT;
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

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
const tweakpaneRequests = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("request", (request) => {
  if (/(?:tweakpane|debug-ui)/i.test(request.url())) tweakpaneRequests.push(request.url());
});

try {
  await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(() => Boolean(window.__sf?.debugPanel), null, { timeout: 120_000 });
  await page.evaluate(() => window.__sfManual?.(true));
  const bootRequestCount = tweakpaneRequests.length;

  const openTiming = await page.evaluate(() => {
    const started = performance.now();
    window.__sf.debugPanel.toggle();
    const feedbackReady = document.querySelector('input[aria-label="Search tweaks"]') !== null;
    return { started, feedbackMs: performance.now() - started, feedbackReady };
  });
  assert.equal(openTiming.feedbackReady, true, "first activation did not paint an immediate shell");
  await page.waitForSelector('input[aria-label="Search tweaks"]', { state: "visible", timeout: 30_000 });
  await page.waitForSelector(".tp-rotv", { state: "visible", timeout: 30_000 });
  const shellReady = await page.evaluate(() => performance.now());
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.includes("full profiler")),
    null,
    { timeout: 30_000 }
  );
  const buildReady = await page.evaluate(() => performance.now());
  const activationRequestCount = tweakpaneRequests.length;
  const debugResourceTimings = await page.evaluate(() =>
    performance.getEntriesByType("resource")
      .filter((entry) => /(?:tweakpane|debug-ui)/i.test(entry.name))
      .map((entry) => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration }))
  );

  await page.waitForTimeout(300);
  const census = await page.evaluate(() => {
    const selector = ".tp-fldv,.tp-lblv,.tp-btnv,.tp-sprv,.tp-tabv";
    return {
      blades: document.querySelectorAll(selector).length,
      folders: document.querySelectorAll(".tp-fldv").length,
      bindings: document.querySelectorAll(".tp-lblv").length
    };
  });

  const searches = [];
  for (const query of ["a", "light", "grass", "", "shadow", ""]) {
    searches.push(await page.evaluate(async (nextQuery) => {
      const input = document.querySelector('input[aria-label="Search tweaks"]');
      if (!(input instanceof HTMLInputElement)) throw new Error("Tweakpane search input is missing");
      const root = input.parentElement;
      if (!root) throw new Error("Tweakpane root is missing");
      const started = performance.now();
      input.value = nextQuery;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const handlerDone = performance.now();
      void root.scrollHeight;
      const forcedLayoutDone = performance.now();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const blades = Array.from(root.querySelectorAll(".tp-fldv,.tp-lblv,.tp-btnv,.tp-sprv,.tp-tabv"));
      return {
        query: nextQuery || "<clear>",
        handlerMs: handlerDone - started,
        forcedLayoutMs: forcedLayoutDone - handlerDone,
        settledMs: performance.now() - started,
        visibleBlades: blades.filter((blade) => blade.getClientRects().length > 0).length,
        nativeExpandedFolders: root.querySelectorAll(".tp-fldv-expanded").length,
        searchExpandedFolders: root.querySelectorAll(".sf-tp-search-expanded").length
      };
    }, query));
  }

  if (SCREENSHOT_PATH) {
    await page.evaluate(async () => {
      const input = document.querySelector('input[aria-label="Search tweaks"]');
      if (!(input instanceof HTMLInputElement)) throw new Error("Tweakpane search input is missing");
      input.value = "shadow";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await mkdir(path.dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
    await page.evaluate(() => {
      const input = document.querySelector('input[aria-label="Search tweaks"]');
      if (!(input instanceof HTMLInputElement)) throw new Error("Tweakpane search input is missing");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(32);
  }

  const reopen = await page.evaluate(async () => {
    const panel = window.__sf.debugPanel;
    const root = document.querySelector('input[aria-label="Search tweaks"]')?.parentElement;
    if (!root) throw new Error("Tweakpane root is missing");
    panel.toggle();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const started = performance.now();
    panel.toggle();
    const toggleDone = performance.now();
    void root.scrollHeight;
    const forcedLayoutDone = performance.now();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      toggleMs: toggleDone - started,
      forcedLayoutMs: forcedLayoutDone - toggleDone,
      settledMs: performance.now() - started
    };
  });

  assert.ok(searches.every((result) => result.handlerMs < 4), "search input handler blocked the main thread");
  assert.ok(searches.every((result) => result.forcedLayoutMs < 4), "search input forced synchronous layout");
  assert.equal(
    new Set(searches.map((result) => result.nativeExpandedFolders)).size,
    1,
    "search mutated Tweakpane's persistent folder expansion state"
  );
  assert.ok(
    searches.filter((result) => result.query === "<clear>").every((result) => result.searchExpandedFolders === 0),
    "clearing search left transient folder expansion behind"
  );
  assert.equal(bootRequestCount, 0, "Tweakpane was requested before first activation");
  assert.ok(activationRequestCount > 0, "first activation did not request the lazy Tweakpane chunk");
  assert.equal(
    tweakpaneRequests.length,
    activationRequestCount,
    "searching or reopening fetched additional Tweakpane resources"
  );
  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join("\n")}`);
  console.log(JSON.stringify({
    url: BASE_URL,
    waterfall: {
      bootRequests: bootRequestCount,
      activationRequests: activationRequestCount,
      subsequentRequests: tweakpaneRequests.length - activationRequestCount,
      resources: debugResourceTimings
    },
    firstOpen: {
      feedbackMs: openTiming.feedbackMs,
      shellMs: shellReady - openTiming.started,
      completeMs: buildReady - openTiming.started
    },
    census,
    searches,
    reopen,
    screenshot: SCREENSHOT_PATH ?? null,
    pageErrors
  }, null, 2));
} finally {
  await browser.close();
}
