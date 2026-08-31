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
    "--use-angle=metal",
    "--autoplay-policy=no-user-gesture-required"
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

  // Phase 2: use the engine's probe-only equivalent of its gesture unlock, then
  // admit exactly the one set selected by the player's musical geography.
  await page.evaluate(() => window.__sf.audioEngine.unlock());
  await page.waitForFunction(() => window.__sf?.getLivingScore?.(), null, { timeout: 15_000 });
  await page.waitForFunction(
    () => window.__sf?.getLivingScore?.()?.debugState?.status === "ready" && window.__sf.getLivingScore().debugState.set,
    null,
    { timeout: 40_000 }
  );
  await page.waitForTimeout(1200);
  const initial = await page.evaluate(() => window.__sf.getLivingScore().debugState);
  const manifestRequests = pathsMatching(/\/audio\/music\/manifest\.json$/);
  assert.equal(manifestRequests.length, 1, "activation should request one manifest");
  assert(pathsMatching(/livingScore/i).length >= 1, "activation did not import the living-score chunk");

  const initialAssets = pathsMatching(new RegExp(`/audio/music/${initial.set}/.*\\.m4a$`));
  const allActivatedAssets = pathsMatching(/\/audio\/music\/[^/]+\/.*\.m4a$/);
  assert.equal(initialAssets.length, initial.loadedStemCount, "activation did not request exactly one complete set");
  assert.deepEqual(allActivatedAssets, initialAssets, "activation leaked media from another score profile");

  // Phase 3: hold a synthetic direction long enough to cross one border. The
  // real director must request only that newly selected set, not the catalog.
  const target = initial.profile === "sutro-memory"
    ? { profile: "mission-sun", x: 1090, z: 3020, hour: 13 }
    : { profile: "sutro-memory", x: -6125, z: 1117, hour: 13 };
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
  const targetAssets = pathsMatching(new RegExp(`/audio/music/${target.profile}/.*\\.m4a$`));
  assert.equal(targetAssets.length, transitioned.loadedStemCount, "transition did not request exactly one new set");
  const allowedPrefixes = [`/audio/music/${initial.set}/`, `/audio/music/${target.profile}/`];
  const unexpected = pathsMatching(/\/audio\/music\/[^/]+\/.*\.m4a$/)
    .filter((pathname) => !allowedPrefixes.some((prefix) => pathname.startsWith(prefix)));
  assert.deepEqual(unexpected, [], `transition requested unrelated score assets: ${unexpected.join(", ")}`);
  assert.deepEqual(scoreErrors, [], `living-score browser errors:\n${scoreErrors.join("\n")}`);

  console.log("living score browser probe: PASS", {
    initial: { profile: initial.profile, set: initial.set, stems: initial.loadedStemCount },
    transitioned: {
      profile: transitioned.profile,
      set: transitioned.set,
      stems: transitioned.loadedStemCount
    },
    manifestRequests: manifestRequests.length
  });
} finally {
  await browser.close();
}
