// Headless loading and transition contract for the Suno living score.
// Run against an existing worktree server:
//   SF_PROBE_URL=http://localhost:5268 node tools/living-score-browser-probe.mjs

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
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal"
  ]
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const requests = [];
const scoreErrors = [];
page.on("request", (request) => requests.push(request.url()));
page.on("pageerror", (error) => scoreErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && /living.?score|audio\/music/i.test(message.text())) {
    scoreErrors.push(message.text());
  }
});

const pathsMatching = (pattern) => [...new Set(
  requests
    .map((url) => new URL(url).pathname)
    .filter((pathname) => pattern.test(pathname))
)];

try {
  await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(() => window.__sf?.renderIdle?.(), null, { timeout: 120_000 });
  await page.waitForFunction(() => window.__sf?.worldArrival?.active === false, null, { timeout: 120_000 });
  await page.waitForTimeout(900);

  // Phase 1: neither the director nor any part of its catalog may enter clean
  // boot. The ordinary nature/wave systems are intentionally outside this test.
  assert.equal(pathsMatching(/livingScore/i).length, 0, "clean boot imported the living-score chunk");
  assert.equal(pathsMatching(/\/audio\/music\//).length, 0, "clean boot requested living-score media");

  // Phase 2: exercise the player's exact path. Opening Mixer is a real browser
  // gesture; it must expose MUSIC (never the legacy LIVE row), unlock Web Audio,
  // and admit exactly the set selected by the player's musical geography.
  await page.locator(".mixer-btn").click();
  const mixerLabels = await page.locator(".audio-lbl").allTextContents();
  assert.deepEqual(mixerLabels, ["Music", "FX", "World", "Voice"], "mixer labels are stale or incomplete");
  assert.equal(await page.locator('input[data-kind="music"]').count(), 1, "mixer has no music slider");
  await page.waitForFunction(() => window.__sf?.audioEngine?.debugState?.unlocked === true, null, {
    timeout: 5_000
  });
  await page.waitForFunction(() => window.__sf?.getLivingScore?.(), null, { timeout: 15_000 });
  await page.waitForFunction(
    () => window.__sf?.getLivingScore?.()?.debugState?.status === "ready" && window.__sf.getLivingScore().debugState.set,
    null,
    { timeout: 40_000 }
  );
  await page.waitForFunction(
    () => {
      const score = window.__sf?.getLivingScore?.()?.debugState;
      const engine = window.__sf?.audioEngine?.debugState;
      return score?.playingStemCount > 0 && score?.leaderTime > 0.1 &&
        engine?.ctx === "running" && engine?.levels?.music > 0;
    },
    null,
    { timeout: 15_000 }
  );
  const clockA = await page.evaluate(() => window.__sf.getLivingScore().debugState.leaderTime);
  await page.waitForTimeout(800);
  const clockB = await page.evaluate(() => window.__sf.getLivingScore().debugState.leaderTime);
  assert(clockB > clockA + 0.4, `music media clock did not advance (${clockA} -> ${clockB})`);
  const outputSamples = [];
  for (let i = 0; i < 20; i++) {
    outputSamples.push(await page.evaluate(() => window.__sf.getLivingScore().debugState.outputDb));
    await page.waitForTimeout(200);
  }
  const peakOutputDb = Math.max(...outputSamples);
  const initial = await page.evaluate(() => window.__sf.getLivingScore().debugState);
  assert(
    peakOutputDb > -50,
    `living-score deck is effectively silent (peak ${peakOutputDb} dBFS; ${outputSamples.join(", ")})`
  );
  const manifestRequests = pathsMatching(/\/audio\/music\/manifest\.json$/);
  assert.equal(manifestRequests.length, 1, "activation should request one manifest");
  assert(pathsMatching(/livingScore/i).length >= 1, "activation did not import the living-score chunk");

  const initialAssets = pathsMatching(new RegExp(`/audio/music/${initial.set}/.*\\.m4a$`));
  const allActivatedAssets = pathsMatching(/\/audio\/music\/[^/]+\/.*\.m4a$/);
  assert.equal(initialAssets.length, initial.loadedStemCount, "activation did not request exactly one complete set");
  assert.deepEqual(allActivatedAssets, initialAssets, "activation leaked media from another score profile");

  // Phase 3: hold a synthetic direction long enough to cross one border. The
  // real director must request only that newly selected set, not the catalog.
  // Prefer the intentionally sparse three-stem cosmic set so the transition
  // also protects the quiet end of the library. If it was the initial set,
  // cross to the dense blue-hour arrangement instead.
  const target = initial.profile === "afterlight-cosmos"
    ? { profile: "city-rain", x: 1500, z: 1000, hour: 18.2 }
    : { profile: "afterlight-cosmos", x: 208, z: 2456, hour: 22 };
  await page.evaluate(({ x, z, hour }) => {
    const score = window.__sf.getLivingScore();
    const input = { x, z, speed: 0, timeOfDay: hour, indoor: false, allowNewLoads: true };
    for (let i = 0; i < 9; i++) score.update(1, input);
  }, target);
  await page.waitForFunction(
    (profile) => window.__sf?.getLivingScore?.()?.debugState?.profile === profile,
    target.profile,
    { timeout: 40_000 }
  );
  await page.waitForTimeout(1200);

  const transitioned = await page.evaluate(() => window.__sf.getLivingScore().debugState);
  const transitionedOutput = [];
  for (let i = 0; i < 30; i++) {
    transitionedOutput.push(await page.evaluate(() => window.__sf.getLivingScore().debugState.outputDb));
    await page.waitForTimeout(200);
  }
  const transitionedPeakOutputDb = Math.max(...transitionedOutput);
  assert(
    transitionedPeakOutputDb > -50,
    `transitioned score is effectively silent (peak ${transitionedPeakOutputDb} dBFS)`
  );
  const targetAssets = pathsMatching(new RegExp(`/audio/music/${target.profile}/.*\\.m4a$`));
  assert.equal(targetAssets.length, transitioned.loadedStemCount, "transition did not request exactly one new set");
  const allowedPrefixes = [`/audio/music/${initial.set}/`, `/audio/music/${target.profile}/`];
  const unexpected = pathsMatching(/\/audio\/music\/[^/]+\/.*\.m4a$/)
    .filter((pathname) => !allowedPrefixes.some((prefix) => pathname.startsWith(prefix)));
  assert.deepEqual(unexpected, [], `transition requested unrelated score assets: ${unexpected.join(", ")}`);
  assert.deepEqual(scoreErrors, [], `living-score browser errors:\n${scoreErrors.join("\n")}`);

  console.log("living score browser probe: PASS", {
    initial: {
      profile: initial.profile,
      set: initial.set,
      stems: initial.loadedStemCount,
      peakOutputDb
    },
    transitioned: {
      profile: transitioned.profile,
      set: transitioned.set,
      stems: transitioned.loadedStemCount,
      peakOutputDb: transitionedPeakOutputDb
    },
    manifestRequests: manifestRequests.length
  });
} finally {
  await browser.close();
}
