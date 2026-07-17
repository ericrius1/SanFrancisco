import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, ".data", "ukiyo-postfx");
const BASE_URL = process.env.SF_UKIYO_URL ?? "http://127.0.0.1:5522";

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  for (const candidate of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (!candidate.includes("/") || await exists(candidate)) return candidate;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}

async function imageDifference(beforePath, afterPath) {
  const before = await sharp(beforePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const after = await sharp(afterPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(before.info, after.info, "capture dimensions must match");
  let absolute = 0;
  let changed = 0;
  const pixels = before.info.width * before.info.height;
  for (let i = 0; i < before.data.length; i += 3) {
    const delta = Math.abs(before.data[i] - after.data[i])
      + Math.abs(before.data[i + 1] - after.data[i + 1])
      + Math.abs(before.data[i + 2] - after.data[i + 2]);
    absolute += delta / 3;
    if (delta > 12) changed++;
  }
  return {
    meanAbsoluteChannelDelta: absolute / pixels,
    changedPixelRatio: changed / pixels
  };
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: await findChrome(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--enable-gpu",
    "--use-angle=metal",
    "--mute-audio",
    "--hide-scrollbars"
  ]
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  serviceWorkers: "block"
});
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
let requestPhase = "boot";
let lastRequestAt = Date.now();
const activationRequests = [];
page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("request", (request) => {
  lastRequestAt = Date.now();
  if (requestPhase === "activation") activationRequests.push(request.url());
});

try {
  const response = await page.goto(
    `${BASE_URL}/?autostart=1&spawn=teaGardenPagoda&fullfps=1`,
    { waitUntil: "domcontentloaded", timeout: 30_000 }
  );
  assert.equal(response?.status(), 200, "worktree preview must return 200");
  await page.waitForFunction(
    () => Boolean(
      window.__sf?.pipeline
      && window.__sf?.renderer
      && window.__sf?.renderIdle?.()
      && document.getElementById("loading")?.classList.contains("done")
      && window.__sf.scene.getObjectByName("japanese_tea_garden")
    ),
    undefined,
    { timeout: 120_000 }
  );
  await page.evaluate(() => window.__sfManual?.(true));
  const quietDeadline = Date.now() + 45_000;
  while (Date.now() - lastRequestAt < 5_000 && Date.now() < quietDeadline) {
    await page.waitForTimeout(250);
  }
  assert.ok(Date.now() - lastRequestAt >= 5_000, "world requests did not settle before activation");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(2_000);

  const baselinePath = path.join(OUT, "baseline.png");
  const ukiyoPath = path.join(OUT, "ukiyo.png");
  await page.evaluate(() => {
    const sf = window.__sf;
    Object.assign(sf.POSTFX_TUNING.values, {
      fxaa: false,
      ink: false,
      ukiyo: false,
      dream: false,
      retro: false
    });
    sf.pipeline.applyPostFx();
    sf.tick(0);
    window.__ukiyoBaselinePipeline = sf.pipeline.pipeline;
  });
  await page.screenshot({ path: baselinePath });

  requestPhase = "activation";
  const runtime = await page.evaluate(() => {
    const sf = window.__sf;
    sf.POSTFX_TUNING.values.ukiyo = true;
    sf.pipeline.applyPostFx();
    sf.tick(0);
    const ukiyoPipeline = sf.pipeline.pipeline;
    const activeChanged = ukiyoPipeline !== window.__ukiyoBaselinePipeline;

    sf.POSTFX_TUNING.values.ink = true;
    sf.pipeline.applyPostFx();
    const sharesOutlineGraph = sf.pipeline.pipeline === ukiyoPipeline;
    sf.POSTFX_TUNING.values.ink = false;
    sf.pipeline.applyPostFx();
    sf.tick(0);
    return {
      activeChanged,
      sharesOutlineGraph,
      backend: sf.renderer.backend?.isWebGPUBackend === true,
      values: {
        amount: sf.POSTFX_TUNING.values.ukiyoAmount,
        palette: sf.POSTFX_TUNING.values.ukiyoPalette,
        lines: sf.POSTFX_TUNING.values.ukiyoLines,
        paper: sf.POSTFX_TUNING.values.ukiyoPaper
      }
    };
  });
  await page.waitForTimeout(1_000);
  requestPhase = "done";
  await page.screenshot({ path: ukiyoPath });

  const difference = await imageDifference(baselinePath, ukiyoPath);
  assert.equal(runtime.backend, true, "probe must exercise the WebGPU backend");
  assert.equal(runtime.activeChanged, true, "ukiyo-e must select the outlined graph");
  assert.equal(runtime.sharesOutlineGraph, true, "ink and ukiyo-e should share one outline graph");
  assert.ok(
    difference.meanAbsoluteChannelDelta > 4 && difference.changedPixelRatio > 0.35,
    `ukiyo-e frame change is unexpectedly weak: ${JSON.stringify(difference)}`
  );
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join("\n")}`);
  assert.deepEqual(
    activationRequests,
    [],
    `post-FX activation must not fetch optional assets: ${activationRequests.join("\n")}`
  );

  console.log(JSON.stringify({
    url: page.url(),
    runtime,
    difference,
    activationRequests,
    pageErrors,
    consoleErrors,
    captures: { baselinePath, ukiyoPath }
  }, null, 2));
} finally {
  await browser.close();
}
