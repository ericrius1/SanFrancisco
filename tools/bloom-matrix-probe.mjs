// Post-chain stage-toggle probe. (Historically the bloom × style × FXAA matrix;
// the styles and the FXAA detour died with render/postfx.ts, but the two things
// this probe actually proved are worth more now than they were then.)
//
// WHAT IT PROVES, AND WHY IT IS A DIFFERENT CLAIM THAN BEFORE
//
// The old chain answered a toggle by SELECTING A DIFFERENT PIPELINE out of a
// cache of eight style variants crossed with two bloom families, so the probe
// asserted `pipeline !== pipeline` across a bloom toggle and `===` across a
// round trip. That was the correct assertion for that design and it is exactly
// the wrong one for this one. The whole point of the rebuild is that there is
// now ONE THREE.RenderPipeline, permanently: a stage toggles by dropping out of
// the per-frame loop, not by swapping the object that presents. So the
// assertion inverts —
//
//   toggling a stage MUST change chain.state().passes
//   toggling a stage MUST NOT change chain.displayPipeline identity
//
// — and a regression back to variant caching now fails the second half rather
// than the first. `state()` is a pure read of the LAST PRESENTED FRAME
// (post/chain.ts:335-341), so every toggle is followed by real frames before it
// is read; asking earlier reports the previous configuration.
//
// The second surviving assertion is the plain one: every configuration still
// presents a non-blank frame with no page or WebGPU errors. Ablation probes are
// good at proving a stage changed the image and bad at noticing that it changed
// the image to black.
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

/**
 * How long to let rAF run after a toggle before reading `state()` or grabbing a
 * pixel. Two reasons it is not one frame: `state()` reports the last PRESENTED
 * frame, and the temporal stage reseeds its history whenever the graph upstream
 * of it changes — reading at frame one photographs the reseed, not the result.
 */
const SETTLE_MS = 700;

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

  // Snapshot boot's `enabled` for every stage that has one, rather than a
  // hardcoded list of defaults: a stage's default is that stage's business, and
  // a probe that restates it silently rots the day someone changes it.
  const stages = await page.evaluate(() => {
    const chain = window.__sf.pipeline.postChain;
    window.__sfStageDefaults = {};
    const ids = [];
    for (const stage of chain.stages) {
      const values = stage.tuning?.group?.values;
      if (!values || !("enabled" in values)) continue;
      window.__sfStageDefaults[stage.id] = values.enabled;
      ids.push({ id: stage.id, bootEnabled: Boolean(values.enabled) });
    }
    return ids;
  });
  expect("stages-are-toggleable", stages.length >= 4, stages);

  /** Put every stage back to what boot had, and lift the master bypass. */
  const reset = async () => {
    await page.evaluate(() => {
      const sf = window.__sf;
      sf.POST_TUNING.values.enabled = true;
      for (const stage of sf.pipeline.postChain.stages) {
        const values = stage.tuning?.group?.values;
        if (values && stage.id in window.__sfStageDefaults) {
          values.enabled = window.__sfStageDefaults[stage.id];
        }
      }
      sf.pipeline.applyPostFx();
    });
    await sleep(SETTLE_MS);
  };

  const setStage = async (id, on) => {
    await page.evaluate(
      ([stageId, enabled]) => {
        const sf = window.__sf;
        sf.pipeline.postChain.stage(stageId).tuning.group.values.enabled = enabled;
        sf.pipeline.applyPostFx();
      },
      [id, on]
    );
    await sleep(SETTLE_MS);
  };

  const readChain = () =>
    page.evaluate(() => {
      const chain = window.__sf.pipeline.postChain;
      // Stash the pipeline object so identity can be compared across evaluates —
      // an object cannot cross the CDP boundary, so the comparison has to happen
      // in the page.
      const same = window.__sfLastPipeline === chain.displayPipeline;
      const first = window.__sfLastPipeline === undefined;
      window.__sfLastPipeline = chain.displayPipeline;
      const s = chain.state();
      return { passes: s.passes, enabled: s.enabled, samePipeline: first ? null : same };
    });

  // ---- the two assertions carried forward from the variant-cache era --------
  await reset();
  const base = await readChain();

  // Bloom is the one stage this probe has always been named after, and it is a
  // good choice on its own merits: enabled by default, a real pass of its own,
  // and downstream of the temporal resolve so dropping it cannot be confused
  // with a history reseed.
  await setStage("bloom", false);
  const off = await readChain();
  await setStage("bloom", true);
  const backOn = await readChain();

  expect(
    "stage-toggle-changes-pass-count",
    off.passes === base.passes - 1 && backOn.passes === base.passes,
    { base: base.passes, off: off.passes, backOn: backOn.passes }
  );
  expect("stage-toggle-drops-the-stage", !off.enabled.includes("bloom") && backOn.enabled.includes("bloom"), {
    off: off.enabled,
    backOn: backOn.enabled
  });
  // THE INVERTED ASSERTION. The old chain demanded a different pipeline object
  // here; this one demands the same one, forever.
  expect("stage-toggle-keeps-one-display-pipeline", off.samePipeline === true && backOn.samePipeline === true, {
    off: off.samePipeline,
    backOn: backOn.samePipeline
  });

  // The master bypass is the strongest form of the same claim: no stage runs at
  // all, and the object that presents is still the object that presented.
  await page.evaluate(() => {
    window.__sf.POST_TUNING.values.enabled = false;
    window.__sf.pipeline.applyPostFx();
  });
  await sleep(SETTLE_MS);
  const bypass = await readChain();
  expect("master-bypass-runs-only-the-display-tail", bypass.passes === 1 && bypass.enabled[0] === "display", bypass);
  expect("master-bypass-keeps-one-display-pipeline", bypass.samePipeline === true, bypass);
  await reset();

  // ---- the per-configuration non-blank check -------------------------------
  const shoot = async (name) => {
    const file = path.join(OUT, `${name}.png`);
    await page.locator("canvas").first().screenshot({ path: file });
    const stats = await sharp(file).stats();
    const spread = Math.max(...stats.channels.slice(0, 3).map((c) => c.stdev));
    const mean = stats.channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) / 3;
    const shot = { mean: Number(mean.toFixed(2)), spread: Number(spread.toFixed(2)) };
    expect(`${name}-nonblank`, spread > 8 && mean > 4 && mean < 250, shot);
    return shot;
  };

  const results = { baseline: await shoot("baseline") };
  for (const { id, bootEnabled } of stages) {
    // Walk each stage away from its boot state and back. A stage that is off by
    // default (DOF) is exercised by turning it ON — the interesting direction is
    // "not the shipped configuration", not "off".
    await reset();
    await setStage(id, !bootEnabled);
    results[id] = await shoot(`${id}-${bootEnabled ? "off" : "on"}`);
  }

  await reset();
  results.restored = await shoot("restored");

  expect("no-page-errors", pageErrors.length === 0, pageErrors.slice(0, 4));
  expect("no-webgpu-errors", gpuErrors.length === 0, gpuErrors.slice(0, 4));

  await writeFile(
    path.join(OUT, "result.json"),
    JSON.stringify({ checks, stages, results, pageErrors, gpuErrors }, null, 2)
  );
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.pass);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} passed\n`);
process.exit(failed.length ? 1 : 0);
