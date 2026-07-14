// End-to-end QA for the city-wide historical expanded-map atlas.
//
// Verifies:
// - every optional atlas plate is absent from a clean boot
// - first map activation requests only the city overview plate
// - focusing Golden Gate requests only its intersecting regional plate
// - close Golden Gate zoom requests exactly one nearby detail plate
// - Retina canvas backing resolution is active
// - subsequent redraws do not refetch either plate
// - the real WebGPU app renders the overview and closest zoom without errors

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".data", "historical-map-atlas");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5243").replace(/\/$/, "");
const OVERVIEW_ASSET = "/map/historical-atlas/city-overview.webp";
const REGION_ASSETS = Array.from(
  { length: 9 },
  (_, index) => `/map/historical-atlas/region-r${Math.floor(index / 3)}-c${index % 3}.webp`
);
const DETAIL_ASSET = "/map/golden-gate-historical-detail.webp";

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
  const requests = {
    overview: 0,
    detail: 0,
    regions: Object.fromEntries(REGION_ASSETS.map((asset) => [asset, 0]))
  };
  const consoleErrors = [];
  const pageErrors = [];
  const failedResponses = [];
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
      const pathname = new URL(request.url()).pathname;
      if (pathname === OVERVIEW_ASSET) requests.overview++;
      else if (pathname === DETAIL_ASSET) requests.detail++;
      else if (pathname in requests.regions) requests.regions[pathname]++;
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("response", (response) => {
      if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() });
    });

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

    const snapshotRequests = () => ({
      overview: requests.overview,
      detail: requests.detail,
      regions: { ...requests.regions }
    });
    const regionRequestCount = () => Object.values(requests.regions).reduce((sum, count) => sum + count, 0);
    const bootRequests = snapshotRequests();
    assert(
      bootRequests.overview === 0 && bootRequests.detail === 0 && regionRequestCount() === 0,
      `historical atlas requested during boot (${JSON.stringify(bootRequests)})`
    );

    const plateResponse = page.waitForResponse((response) => new URL(response.url()).pathname === OVERVIEW_ASSET, {
      timeout: 30_000
    });
    await page.evaluate(() => window.__sf.minimap.setExpanded(true));
    const overviewResponse = await plateResponse;
    assert(overviewResponse.ok(), `overview plate returned ${overviewResponse.status()}`);
    await page.evaluate(() => window.__sf.minimap.focusWorldPoint(384, -1952, 15104));
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
    assert(requests.overview === 1, `first activation made ${requests.overview} overview requests`);
    assert(regionRequestCount() === 0, "regional atlas loaded before a regional zoom/focus");
    assert(requests.detail === 0, "detail tile loaded before close zoom");

    const regionAsset = "/map/historical-atlas/region-r1-c0.webp";
    const regionalResponsePromise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === regionAsset,
      { timeout: 30_000 }
    );
    const resolved = await page.evaluate(() => window.__sf.minimap.focusLandmark("Golden Gate Bridge"));
    assert(resolved, "Golden Gate Bridge landmark did not resolve");
    const regionalResponse = await regionalResponsePromise;
    assert(regionalResponse.ok(), `regional plate returned ${regionalResponse.status()}`);
    await page.waitForTimeout(400);
    const regional = path.join(OUT, "historical-regional.png");
    await canvas.screenshot({ path: regional });
    assert(requests.regions[regionAsset] === 1, "Golden Gate regional plate did not load exactly once");
    assert(regionRequestCount() === 1, `focus loaded non-intersecting regions (${JSON.stringify(requests.regions)})`);
    assert(requests.detail === 0, "detail tile loaded at regional zoom");

    const box = await canvas.boundingBox();
    assert(box, "expanded map has no bounding box");
    const detailResponse = page.waitForResponse((response) => new URL(response.url()).pathname === DETAIL_ASSET, {
      timeout: 30_000
    });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -1800);
    const closeResponse = await detailResponse;
    assert(closeResponse.ok(), `detail plate returned ${closeResponse.status()}`);
    await page.mouse.wheel(0, -1800);
    await page.waitForTimeout(500);
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
    assert(requests.overview === 1, `zoom/pan refetched the overview (${requests.overview})`);
    assert(regionRequestCount() === 1, `close zoom refetched or added regions (${JSON.stringify(requests.regions)})`);
    assert(requests.detail === 1, `close zoom made ${requests.detail} detail requests`);
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);
    const closeZoomRequests = snapshotRequests();

    // Visit every regional core independently. Each move should add exactly
    // the requested tile and no other region; r1-c0 is already resident.
    const centers = [
      [-4650.6667, -6581.3333], [384, -6581.3333], [5418.6667, -6581.3333],
      [-4650.6667, -1952], [384, -1952], [5418.6667, -1952],
      [-4650.6667, 2677.3333], [384, 2677.3333], [5418.6667, 2677.3333]
    ];
    for (let index = 0; index < REGION_ASSETS.length; index++) {
      const asset = REGION_ASSETS[index];
      if (requests.regions[asset] === 1) continue;
      const expectedBefore = regionRequestCount();
      const responsePromise = page.waitForResponse(
        (response) => new URL(response.url()).pathname === asset,
        { timeout: 30_000 }
      );
      const [x, z] = centers[index];
      await page.evaluate(([wx, wz]) => window.__sf.minimap.focusWorldPoint(wx, wz, 1500), [x, z]);
      const response = await responsePromise;
      assert(response.ok(), `${asset} returned ${response.status()}`);
      assert(
        regionRequestCount() === expectedBefore + 1,
        `regional sweep loaded more than ${asset} (${JSON.stringify(requests.regions)})`
      );
    }
    assert(regionRequestCount() === REGION_ASSETS.length, "regional sweep did not load the complete atlas");
    await page.evaluate(() => window.__sf.minimap.focusWorldPoint(-2133.3333, 362.6667, 2800));
    await page.waitForTimeout(400);
    const seam = path.join(OUT, "historical-four-tile-seam.png");
    await canvas.screenshot({ path: seam });

    const result = {
      url: BASE_URL,
      assets: { overview: OVERVIEW_ASSET, regions: REGION_ASSETS, detail: DETAIL_ASSET },
      bootRequests,
      activationRequests: { overview: 1, regions: 0, detail: 0 },
      regionalRequests: { overview: 1, regions: { [regionAsset]: 1 }, detail: 0 },
      closeZoomRequests,
      completeAtlasRequests: snapshotRequests(),
      canvas: canvasInfo,
      closestZoomSpanM: timing.debug.spanX,
      averageMapUpdateMs: timing.averageUpdateMs,
      consoleErrors,
      pageErrors,
      failedResponses,
      screenshots: { overview, regional, close, seam }
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
