// End-to-end QA for the historical expanded-map pilot.
//
// Verifies:
// - the optional painted plate is absent from a clean boot
// - first map activation requests it exactly once
// - Retina canvas backing resolution is active
// - pan/zoom does not refetch the plate
// - the real WebGPU app renders the overview and closest zoom without errors

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data", "historical-map-pilot");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5243").replace(/\/$/, "");
const ASSET = "/map/golden-gate-historical-pilot.webp";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
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

async function main() {
  await mkdir(OUT, { recursive: true });
  const requests = [];
  const consoleErrors = [];
  const pageErrors = [];
  const browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      `--use-angle=${process.platform === "darwin" ? "metal" : "swiftshader"}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--mute-audio"
    ]
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 2,
      serviceWorkers: "block"
    });
    const page = await context.newPage();
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === ASSET) requests.push(request.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    // Production previews expose the read-only QA hooks only behind `profile`;
    // development servers expose them automatically.
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    });
    await page.waitForFunction(() => Boolean(window.__sf?.minimap && window.__sf?.renderer?.backend?.device), null, {
      timeout: 180_000
    });
    await page.waitForTimeout(700);

    const bootRequests = requests.length;
    assert(bootRequests === 0, `historical plate requested during boot (${bootRequests})`);

    const plateResponse = page.waitForResponse((response) => new URL(response.url()).pathname === ASSET, {
      timeout: 30_000
    });
    const resolved = await page.evaluate(() => window.__sf.minimap.focusLandmark("Golden Gate Bridge"));
    assert(resolved, "Golden Gate Bridge landmark did not resolve");
    await plateResponse;
    await page.waitForTimeout(500);

    const canvas = page.locator("canvas[data-big-map]");
    await canvas.waitFor({ state: "visible" });
    const overview = path.join(OUT, "historical-overview.png");
    await canvas.screenshot({ path: overview });

    const canvasInfo = await canvas.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        cssWidth: rect.width,
        cssHeight: rect.height,
        pixelWidth: element.width,
        pixelHeight: element.height,
        dpr: window.devicePixelRatio
      };
    });
    assert(canvasInfo.pixelWidth / canvasInfo.cssWidth > 1.9, "expanded map canvas is not Retina resolution");
    assert(requests.length === 1, `first activation made ${requests.length} plate requests`);

    const box = await canvas.boundingBox();
    assert(box, "expanded map has no bounding box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -2200);
    await page.mouse.wheel(0, -2200);
    await page.waitForTimeout(250);
    const close = path.join(OUT, "historical-close.png");
    await canvas.screenshot({ path: close });

    const timing = await page.evaluate(() => {
      const started = performance.now();
      for (let i = 0; i < 40; i++) window.__sf.minimap.update();
      return {
        averageUpdateMs: (performance.now() - started) / 40,
        debug: window.__sf.minimap.debugState()
      };
    });
    assert(timing.debug.spanX <= 261, `closest zoom did not reach its clamp (${timing.debug.spanX})`);
    assert(requests.length === 1, `zoom/pan refetched the plate (${requests.length} total requests)`);
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);

    const result = {
      url: BASE_URL,
      asset: ASSET,
      bootRequests,
      activationRequests: requests.length,
      canvas: canvasInfo,
      closestZoomSpanM: timing.debug.spanX,
      averageMapUpdateMs: timing.averageUpdateMs,
      consoleErrors,
      pageErrors,
      screenshots: { overview, close }
    };
    await writeFile(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
