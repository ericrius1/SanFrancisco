// Real-browser contract for sticky voice-chat microphone state: a player who
// enables the mic keeps it across a refresh, and a player who turns it off
// stays off. Run against an existing worktree preview:
//   SF_PROBE_URL=http://127.0.0.1:5240 node tools/voice-mic-persistence-probe.mjs

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
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

// A remembered permission is what makes the restore silent — grant it at the
// context level so navigator.permissions reports "granted", exactly like a
// browser the player has already said yes to.
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  permissions: ["microphone"]
});
const page = await context.newPage();

/** Wait for boot, then for the mic restore to have settled one way or the other. */
const enterWorld = async (target = page) => {
  await target.waitForFunction(() => window.__sf?.voice, null, { timeout: 120_000 });
  // The restore fires from main.ts's start handler; give it room to settle.
  await target.waitForFunction(
    () => {
      const state = window.__sf.voice.debugState();
      return !state.savedMic || state.mic || state.awaitingGesture;
    },
    null,
    { timeout: 60_000 }
  );
  return target.evaluate(() => window.__sf.voice.debugState());
};

const storedIntent = () => page.evaluate(() => localStorage.getItem("sf-mic"));

/**
 * Second half: a browser that did NOT remember the grant (Safari's per-session
 * permission, a Firefox "allow once"). Nothing may reopen the mic on its own —
 * one real gesture has to do it, and the worst case is that the gesture is the
 * HUD mic button, whose own handler must not cancel the restore back off.
 */
async function forgottenPermissionPhase() {
  const forgetful = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    permissions: ["microphone"]
  });
  // Headless Chrome claims transient activation with no gesture at all, so pin
  // both signals to what a real browser reports on a cold, untouched load.
  await forgetful.addInitScript(() => {
    navigator.permissions.query = async () => ({ state: "prompt", onchange: null });
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      get: () => ({ isActive: false, hasBeenActive: true })
    });
    // Count every capture, so a leaked second track can't hide behind the first.
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__micTracks = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await real(constraints);
      window.__micTracks.push(...stream.getAudioTracks());
      return stream;
    };
  });
  const forgetfulPage = await forgetful.newPage();
  try {
    await forgetfulPage.goto(`${BASE_URL}/?autostart=1&profile=1`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
    await enterWorld(forgetfulPage);
    assert.equal(await forgetfulPage.evaluate(() => window.__sf.voice.setMic(true)), true);

    await forgetfulPage.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    const armed = await enterWorld(forgetfulPage);
    assert.equal(armed.mic, false, "reopened the mic with no gesture and no remembered permission");
    assert.equal(armed.awaitingGesture, true, "stored mic intent was dropped instead of waiting for a gesture");

    await forgetfulPage.click(".mic-btn");
    await forgetfulPage.waitForFunction(() => window.__sf.voice.debugState().mic === true, null, {
      timeout: 20_000
    });
    await forgetfulPage.waitForTimeout(1500); // let a second request land, if one exists
    const live = await forgetfulPage.evaluate(() =>
      window.__micTracks.filter((t) => t.readyState === "live").length
    );
    assert.equal(live, 1, "mic button plus armed restore left more than one live capture track");

    await forgetfulPage.evaluate(() => window.__sf.voice.setMic(false));
    const released = await forgetfulPage.evaluate(() =>
      window.__micTracks.every((t) => t.readyState === "ended")
    );
    assert.equal(released, true, "a capture track outlived mic off");
    return { armed: armed.awaitingGesture, liveTracksAfterClick: live };
  } finally {
    await forgetful.close();
  }
}

try {
  // `?autostart=1` enters with no click anywhere: whatever the mic does here, it
  // does without a user gesture to lean on.
  await page.goto(`${BASE_URL}/?autostart=1&profile=1`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });

  const clean = await enterWorld();
  assert.equal(clean.mic, false, "a first visit must not open the mic on its own");
  assert.equal(clean.savedMic, false, "a first visit must not have a stored mic intent");

  const enabled = await page.evaluate(() => window.__sf.voice.setMic(true));
  assert.equal(enabled, true, "fake microphone could not satisfy the voice capture constraints");
  assert.equal(await storedIntent(), "on", "enabling the mic did not record the intent");

  // Refresh mid-"conversation": no setMic call after this point.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
  const restored = await enterWorld();
  assert.equal(restored.mic, true, "the mic did not survive a refresh");
  assert.equal(restored.capturing, true, "restored mic is not actually capturing");
  assert.equal(restored.sessionLive, true, "restored mic did not arm the voice session hold");
  assert.equal(restored.awaitingGesture, false, "a granted permission should restore without a gesture");
  assert.ok(
    restored.micProcessing?.echoCancellation === true || restored.micProcessing?.echoCancellation === "all",
    `restored mic lost echo cancellation: ${restored.micProcessing?.echoCancellation}`
  );

  // Turning it off has to stick just as hard as turning it on.
  await page.evaluate(() => window.__sf.voice.setMic(false));
  assert.equal(await storedIntent(), null, "muting the mic did not clear the stored intent");

  await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
  const stayedOff = await enterWorld();
  assert.equal(stayedOff.mic, false, "a muted mic came back after a refresh");
  assert.equal(stayedOff.capturing, false, "a muted mic still holds the capture device");
  assert.equal(stayedOff.awaitingGesture, false, "a muted mic left a restore armed");

  const forgotten = await forgottenPermissionPhase();

  console.log("voice mic persistence probe: PASS", {
    restored: { mic: restored.mic, capturing: restored.capturing, peers: restored.peers.length },
    afterMute: { mic: stayedOff.mic, savedMic: stayedOff.savedMic },
    forgottenPermission: forgotten
  });
} finally {
  await browser.close();
}
