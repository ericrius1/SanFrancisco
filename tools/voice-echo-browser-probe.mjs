// Real-browser contract for the voice-chat microphone processing path.
// Run against an existing worktree preview:
//   SF_PROBE_URL=http://127.0.0.1:5242 node tools/voice-echo-browser-probe.mjs

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5242";
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
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream"
  ]
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
try {
  await page.goto(`${BASE_URL}/?autostart=1&profile=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(() => window.__sf?.voice, null, { timeout: 120_000 });

  const enabled = await page.evaluate(() => window.__sf.voice.setMic(true));
  assert.equal(enabled, true, "fake microphone could not satisfy the voice capture constraints");

  const active = await page.evaluate(() => window.__sf.voice.debugState());
  assert.equal(active.mic, true, "voice did not retain the microphone track");
  assert.ok(
    active.micProcessing.echoCancellation === true || active.micProcessing.echoCancellation === "all",
    `echo cancellation is not active: ${active.micProcessing.echoCancellation}`
  );
  assert.equal(active.micProcessing.contentHint, "speech", "microphone is not optimized for speech");
  assert.equal(active.micProcessing.channelCount, 1, "voice capture is not mono");

  await page.evaluate(() => window.__sf.voice.setMic(false));
  const stopped = await page.evaluate(() => window.__sf.voice.debugState());
  assert.equal(stopped.mic, false, "voice did not turn the microphone off");
  assert.equal(stopped.micProcessing, null, "stopped microphone still exposes live processing state");

  console.log("voice echo browser probe: PASS", active.micProcessing);
} finally {
  await browser.close();
}
