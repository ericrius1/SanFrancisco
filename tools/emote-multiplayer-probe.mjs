// Two real browsers in one world: does an emote look the same to the player
// doing it and to the friend watching?
//
// Covers the whole path — wheel key → player pose layer → relay → remote rig —
// plus the rules that keep emotes from fighting the rest of the game: walking
// ends one, a vehicle ends one, and a held loop survives on the far side long
// enough for the keepalive to matter.
//
//   node tools/emote-multiplayer-probe.mjs
// Env: SF_PROBE_URL (default http://127.0.0.1:5240), CHROME_BIN

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";

function chromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  const result = candidates.find((candidate) => existsSync(candidate));
  if (!result) throw new Error("Chrome/Chromium not found; set CHROME_BIN");
  return result;
}

const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--hide-scrollbars",
    "--mute-audio"
  ]
});

const contexts = [];
const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✓ ${name}`); };

try {
  const errors = [[], []];
  const pages = await Promise.all([0, 1].map(async (index) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    contexts.push(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors[index].push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors[index].push(message.text());
    });
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
    return page;
  }));
  const [actor, watcher] = pages;

  await Promise.all(pages.map((page) => page.waitForFunction(
    () => window.__sf?.player && window.__sf?.net?.status === "online" && window.__sf.net.roster.size === 1,
    undefined,
    { timeout: 180_000 }
  )));
  console.log("[probe] both clients online");

  // Co-locate: the watcher only interpolates poses for avatars it has placed.
  const meetup = await actor.evaluate(() => ({
    x: window.__sf.player.position.x,
    z: window.__sf.player.position.z
  }));
  await watcher.evaluate(({ x, z }) => window.__sf.teleportToTarget(x + 4, z, "probe"), meetup);
  await Promise.all(pages.map((p) => p.evaluate(() => window.__sf.player.playEmote(null))));

  const actorId = await actor.evaluate(() => window.__sf.net.selfId);
  const remoteEmote = () => watcher.evaluate(
    (id) => window.__sf.remotes.avatars.get(id)?.emote?.id ?? null,
    actorId
  );

  // --- the wheel is a keyboard menu -------------------------------------
  // Every wait is a condition, never a sleep: key presses are consumed by the
  // frame loop, whose cadence under two headless WebGPU clients is not
  // something a fixed timeout can predict.
  const wheelOpen = () => actor.evaluate(() => !!document.querySelector(".emote-wheel.open"));
  const waitWheel = (open) => actor.waitForFunction(
    (want) => !!document.querySelector(".emote-wheel.open") === want,
    open,
    { timeout: 8_000 }
  );
  assert.equal(await wheelOpen(), false, "wheel starts closed");
  await actor.keyboard.press("KeyJ");
  await waitWheel(true);
  ok("J opens the emote wheel");

  await actor.keyboard.press("Digit2"); // 2 = dance (EMOTES wire order)
  await actor.waitForFunction(
    () => window.__sf.player.activeEmote === "dance" && !document.querySelector(".emote-wheel.open"),
    undefined,
    { timeout: 8_000 }
  );
  ok("a number key picks an emote and closes the wheel");

  // Number keys must not double as vehicle switches while the wheel is open.
  assert.equal(await actor.evaluate(() => window.__sf.player.mode), "walk");
  ok("the wheel owns the number row (no vehicle switch)");

  // --- it reaches the other browser -------------------------------------
  await watcher.waitForFunction(
    (id) => window.__sf.remotes.avatars.get(id)?.emote?.id === "dance",
    actorId,
    { timeout: 10_000 }
  );
  ok("the watcher's copy of that avatar is dancing");

  // A loop has to survive well past one keepalive interval (2.5 s) without the
  // 6 s hold timer letting go of it.
  await actor.waitForTimeout(7000);
  assert.equal(await remoteEmote(), "dance", "held loop survived the keepalive window");
  assert.equal(await actor.evaluate(() => window.__sf.player.activeEmote), "dance");
  ok("a held dance survives 7 s of keepalives on both sides");

  // --- walking ends it, on both sides -----------------------------------
  await actor.keyboard.down("KeyW");
  await actor.waitForFunction(
    () => window.__sf.player.activeEmote === null,
    undefined,
    { timeout: 10_000 }
  );
  await actor.keyboard.up("KeyW");
  ok("walking away ends the emote locally");
  await watcher.waitForFunction(
    (id) => (window.__sf.remotes.avatars.get(id)?.emote?.id ?? null) === null,
    actorId,
    { timeout: 10_000 }
  );
  ok("…and the watcher stops dancing too");

  // --- a one-shot ends itself -------------------------------------------
  await actor.evaluate(() => window.__sf.player.playEmote("wave"));
  assert.equal(await actor.evaluate(() => window.__sf.player.activeEmote), "wave");
  await actor.waitForFunction( // wave is 2.8 s and nobody sends a stop
    () => window.__sf.player.activeEmote === null,
    undefined,
    { timeout: 10_000 }
  );
  await watcher.waitForFunction(
    (id) => (window.__sf.remotes.avatars.get(id)?.emote?.id ?? null) === null,
    actorId,
    { timeout: 8_000 }
  );
  ok("a one-shot retires itself on both sides without a stop packet");

  // --- driving is not emoting -------------------------------------------
  await actor.evaluate(() => window.__sf.player.playEmote("sit"));
  assert.equal(await actor.evaluate(() => window.__sf.player.activeEmote), "sit");
  await actor.evaluate(() => window.__sf.switchMode("drive"));
  await actor.waitForFunction(() => window.__sf.player.mode === "drive", undefined, { timeout: 10_000 });
  assert.equal(await actor.evaluate(() => window.__sf.player.activeEmote), null);
  assert.equal(
    await actor.evaluate(() => {
      window.__sf.player.playEmote("dance");
      return window.__sf.player.activeEmote;
    }),
    null,
    "a driving player cannot start one either"
  );
  ok("getting in a car ends the emote and refuses new ones");
  await actor.evaluate(() => window.__sf.switchMode("walk"));
  await actor.waitForFunction(() => window.__sf.player.mode === "walk", undefined, { timeout: 10_000 });

  // --- reopening shows what is running, and re-picking stops it ----------
  // Retry until it sticks: hopping out of the car leaves the body briefly
  // airborne, and an airborne body correctly refuses to hold an emote.
  await actor.waitForFunction(() => {
    if (window.__sf.player.activeEmote === "dance") return true;
    window.__sf.player.playEmote("dance");
    return false;
  }, undefined, { timeout: 15_000 });
  await actor.keyboard.press("KeyJ");
  await waitWheel(true);
  const lit = await actor.evaluate(() =>
    [...document.querySelectorAll(".emote-slot")].findIndex((b) => b.classList.contains("active"))
  );
  assert.equal(lit, 1, "the running emote (dance, slot 2) is the lit chip");
  ok("reopening the wheel lights the running emote");

  await actor.keyboard.press("Digit2"); // the lit one — a toggle
  await actor.waitForFunction(
    () => window.__sf.player.activeEmote === null,
    undefined,
    { timeout: 8_000 }
  );
  ok("re-picking the lit emote stops it");

  // --- the wheel gets out of the way ------------------------------------
  await actor.keyboard.press("KeyJ");
  await waitWheel(true);
  await actor.keyboard.press("Escape");
  await waitWheel(false);
  ok("Escape dismisses the wheel");

  // The merged-rig surgery warning is the Sutro Baths bathing costume
  // recolouring base blocks (world/sutroBaths/bathingCostume.ts) — pre-existing,
  // unrelated to emotes, and it only appears when the two clients happen to
  // spawn near the baths.
  const pageErrors = errors
    .flat()
    .filter((e) => !/WebGPU|deprecat/i.test(e))
    .filter((e) => !/merged rig's base block/.test(e));
  assert.deepEqual(pageErrors, [], "no page errors");
  ok("no page errors on either client");

  console.log(`\n[probe] ${checks.length} checks passed`);
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
