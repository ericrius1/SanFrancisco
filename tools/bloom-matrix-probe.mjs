// Bloom interaction probe.
//
// Bloom feeds the post-FX chain a pre-composited scene texture, so it has to
// survive every other consumer of that seam: the eight cached style variants,
// the optional final FXAA pass (which re-targets the whole graph through its own
// RGBA8 buffer), and toggling bloom itself back off. This walks that matrix and
// asserts each combination still presents a non-blank frame with no page or
// WebGPU errors, and that toggling bloom actually selects a different pipeline
// object rather than silently doing nothing.
//
//   SF_PROBE_URL=http://localhost:PORT node tools/bloom-matrix-probe.mjs

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://localhost:5240").replace(/\/$/, "");
const OUT = path.resolve(ROOT, ".data/bloom-matrix");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  for (const c of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    try {
      await access(c);
      return c;
    } catch {
      /* next */
    }
  }
  throw new Error("No Chrome/Chromium found; set CHROME_BIN.");
}

/** Style combinations worth crossing with bloom. Ink and ukiyo share a graph. */
const STYLES = [
  { label: "plain", set: {} },
  { label: "ukiyo", set: { ukiyo: true } },
  { label: "dream", set: { dream: true } },
  { label: "retro", set: { retro: true } },
  { label: "dream+retro", set: { dream: true, retro: true } }
];

const checks = [];
const expect = (id, pass, detail) => {
  checks.push({ id, pass: Boolean(pass), detail });
  process.stdout.write(`[${pass ? "PASS" : "FAIL"}] ${id}${detail ? ` ${JSON.stringify(detail)}` : ""}\n`);
};

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: await findChrome(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
    `--use-angle=${process.env.SF_ANGLE ?? "metal"}`,
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--hide-scrollbars",
    "--mute-audio"
  ]
});

const pageErrors = [];
const gpuErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && /WebGPU|GPUValidation/i.test(m.text())) gpuErrors.push(m.text());
  });

  await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1&spawn=sutroBaths`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(() => Boolean(window.__sf), null, { timeout: 180_000 });
  await page.waitForFunction(() => window.__sf?.renderIdle?.() === true, null, { timeout: 180_000 });
  await sleep(3000);

  const reset = async () =>
    page.evaluate(() => {
      const sf = window.__sf;
      Object.assign(sf.POSTFX_TUNING.values, {
        fxaa: false,
        ink: false,
        ukiyo: false,
        dream: false,
        retro: false,
        bloom: true
      });
      sf.pipeline.applyPostFx();
    });

  // Toggling bloom must actually reselect a pipeline.
  await reset();
  const toggle = await page.evaluate(() => {
    const sf = window.__sf;
    sf.POSTFX_TUNING.values.bloom = true;
    sf.pipeline.applyPostFx();
    const on = sf.pipeline.pipeline;
    sf.POSTFX_TUNING.values.bloom = false;
    sf.pipeline.applyPostFx();
    const off = sf.pipeline.pipeline;
    sf.POSTFX_TUNING.values.bloom = true;
    sf.pipeline.applyPostFx();
    const backOn = sf.pipeline.pipeline;
    return { changed: on !== off, cached: on === backOn };
  });
  expect("bloom-toggle-selects-different-pipeline", toggle.changed, toggle);
  expect("bloom-families-are-cached", toggle.cached, toggle);

  const results = {};
  for (const style of STYLES) {
    for (const bloomOn of [true, false]) {
      for (const fxaaOn of [false, true]) {
        const name = `${style.label}-bloom${bloomOn ? 1 : 0}-fxaa${fxaaOn ? 1 : 0}`;
        await reset();
        await page.evaluate(
          ([set, b, f]) => {
            const sf = window.__sf;
            Object.assign(sf.POSTFX_TUNING.values, set, { bloom: b, fxaa: f });
            sf.pipeline.applyPostFx();
          },
          [style.set, bloomOn, fxaaOn]
        );
        // FXAA is first-use gated behind a dynamic import; give it a moment.
        await sleep(fxaaOn ? 1400 : 600);
        const file = path.join(OUT, `${name}.png`);
        await page.locator("canvas").first().screenshot({ path: file });
        const stats = await sharp(file).stats();
        const spread = Math.max(...stats.channels.slice(0, 3).map((c) => c.stdev));
        const mean = stats.channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) / 3;
        results[name] = { mean: Number(mean.toFixed(2)), spread: Number(spread.toFixed(2)) };
        expect(`${name}-nonblank`, spread > 8 && mean > 4 && mean < 250, results[name]);
      }
    }
  }

  await reset();
  expect("no-page-errors", pageErrors.length === 0, pageErrors.slice(0, 4));
  expect("no-webgpu-errors", gpuErrors.length === 0, gpuErrors.slice(0, 4));

  await writeFile(
    path.join(OUT, "result.json"),
    JSON.stringify({ checks, results, pageErrors, gpuErrors }, null, 2)
  );
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.pass);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
process.exit(failed.length ? 1 : 0);
