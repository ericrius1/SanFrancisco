// Headless regression probe for prioritized `?read=bts.foliage` startup.
// Requires a running local server (SF_PROBE_URL) and Chrome/Chromium.

import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5196";
const chromePath = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].filter(Boolean).find((candidate) => existsSync(candidate));

if (!chromePath) throw new Error("Chrome not found");

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--mute-audio"]
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const requests = [];
  const errors = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText ?? "failed"}`));
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));

  await page.goto(`${BASE}/?read=bts.foliage`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.bts-overlay.open [data-pane="foliage"].active h3', { timeout: 30_000 });

  const indexOf = (patterns) => requests.findIndex((path) => patterns.some((pattern) => path.includes(pattern)));
  const foliageRequest = indexOf(["/src/ui/btsFoliage.ts", "/assets/btsFoliage-"]);
  const mainRequest = indexOf(["/src/main.ts", "/assets/main-"]);
  const firstWorldRequest = indexOf([
    "/data/meta.json",
    "/data/heightmap.bin",
    "/data/surface.bin",
    "/data/groundtop-delta.bin",
    "/data/manifest.json",
    "/ui/san-francisco-survey-map.webp"
  ]);
  if (foliageRequest < 0) throw new Error("foliage chapter request was not observed");
  if (mainRequest < 0 || mainRequest < foliageRequest) {
    throw new Error(`main requested before foliage (${mainRequest} < ${foliageRequest})`);
  }
  if (firstWorldRequest < 0 || firstWorldRequest < foliageRequest) {
    throw new Error(`world data requested before foliage (${firstWorldRequest} < ${foliageRequest})`);
  }

  await page.locator(".bts-close").click();
  await page.waitForFunction(() => !document.body.classList.contains("reading"));
  const afterClose = await page.evaluate(() => ({
    overlayOpen: document.querySelector(".bts-overlay")?.classList.contains("open") ?? false,
    started: document.body.classList.contains("started"),
    loadingDone: document.getElementById("loading")?.classList.contains("done") ?? false,
    loadingLabel: document.querySelector("[data-loading-label]")?.textContent ?? ""
  }));
  if (afterClose.overlayOpen || afterClose.started) {
    throw new Error(`closing the reader entered the world: ${JSON.stringify(afterClose)}`);
  }

  await page.waitForSelector("#loading.ready", { timeout: 120_000 });
  const afterReady = await page.evaluate(() => ({
    started: document.body.classList.contains("started"),
    startDisabled: document.querySelector("[data-start-form] button")?.disabled ?? true,
    loadingLabel: document.querySelector("[data-loading-label]")?.textContent ?? ""
  }));
  if (afterReady.started || afterReady.startDisabled) {
    throw new Error(`reading visit did not settle on the start screen: ${JSON.stringify(afterReady)}`);
  }
  if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);

  const normalContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const normalPage = await normalContext.newPage();
  const normalRequests = [];
  normalPage.on("request", (request) => normalRequests.push(new URL(request.url()).pathname));
  const normalMainSeen = normalPage.waitForRequest(
    (request) => request.url().includes("/src/main.ts") || request.url().includes("/assets/main-"),
    { timeout: 15_000 }
  );
  await normalPage.goto(`${BASE}/?startscreen=1`, { waitUntil: "domcontentloaded" });
  await normalMainSeen;
  await normalPage.waitForTimeout(250);
  const normalMainRequest = normalRequests.findIndex(
    (path) => path.includes("/src/main.ts") || path.includes("/assets/main-")
  );
  const normalWorldRequest = normalRequests.findIndex((path) => path.includes("/data/meta.json"));
  const normalReaderRequest = normalRequests.findIndex(
    (path) =>
      path.endsWith("/src/ui/behindTheScenes.ts") ||
      path.includes("/assets/behindTheScenes-") ||
      path.endsWith("/src/ui/btsFoliage.ts") ||
      path.includes("/assets/btsFoliage-")
  );
  await normalContext.close();
  if (normalWorldRequest < 0 || normalWorldRequest > normalMainRequest) {
    throw new Error(`normal boot no longer prefetches before main (${normalWorldRequest} > ${normalMainRequest})`);
  }
  if (normalReaderRequest >= 0) {
    throw new Error(`normal boot eagerly requested the optional reader at ${normalReaderRequest}`);
  }

  console.log(JSON.stringify({
    requestOrder: { foliageRequest, mainRequest, firstWorldRequest },
    normalOrder: { normalWorldRequest, normalMainRequest, normalReaderRequest },
    afterClose,
    afterReady,
    errors
  }, null, 2));
} finally {
  await browser.close();
}
