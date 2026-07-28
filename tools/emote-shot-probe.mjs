// Screenshots of the emote feature in the real game: the wheel over the world,
// and a friend's avatar mid-emote as seen from another browser.
//
//   node tools/emote-shot-probe.mjs
// Env: SF_PROBE_URL (default http://127.0.0.1:5240), SF_PROBE_OUT, CHROME_BIN

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/emote-shots");
const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";

function chromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  const result = candidates.find((c) => existsSync(c));
  if (!result) throw new Error("Chrome/Chromium not found; set CHROME_BIN");
  return result;
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal", "--hide-scrollbars", "--mute-audio"]
});
const contexts = [];
const save = async (page, name) => {
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, await page.screenshot());
  console.log(`[shot] ${file}`);
};

try {
  const pages = await Promise.all([0, 1].map(async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    return page;
  }));
  const [actor, watcher] = pages;
  await Promise.all(pages.map((p) => p.waitForFunction(
    () => window.__sf?.player && window.__sf?.net?.status === "online" && window.__sf.net.roster.size === 1,
    undefined,
    { timeout: 180_000 }
  )));

  // Stand the two of them face to face on flat ground so the watcher's shot is
  // of an avatar, not of whatever hill it spawned behind.
  const spot = await actor.evaluate(() => ({ x: window.__sf.player.position.x, z: window.__sf.player.position.z }));
  await watcher.evaluate(({ x, z }) => window.__sf.teleportToTarget(x + 3.2, z + 1.2, "probe"), spot);
  await watcher.waitForTimeout(2500);

  // 1. the wheel, over the live world
  await actor.keyboard.press("KeyJ");
  await actor.waitForFunction(() => !!document.querySelector(".emote-wheel.open"), undefined, { timeout: 8_000 });
  await actor.waitForTimeout(600);
  await save(actor, "wheel");

  // 2. what a friend sees. Frame their camera on the emoting player first —
  // a default chase cam points at the viewer's own back.
  await actor.keyboard.press("Digit2"); // dance
  await actor.waitForFunction(() => window.__sf.player.activeEmote === "dance", undefined, { timeout: 8_000 });
  const actorId = await actor.evaluate(() => window.__sf.net.selfId);
  await watcher.waitForFunction(
    (id) => window.__sf.remotes.avatars.get(id)?.emote?.id === "dance",
    actorId,
    { timeout: 10_000 }
  );
  await watcher.evaluate((id) => {
    const a = window.__sf.remotes.avatars.get(id);
    const p = a.root.position;
    window.__sfFreeCam([p.x + 2.2, p.y + 1.6, p.z + 6.4], [p.x, p.y + 0.75, p.z]);
  }, actorId);
  for (const [i, wait] of [400, 220, 220].entries()) {
    await watcher.waitForTimeout(wait);
    await save(watcher, `remote-dance-${i}`);
  }

  // 3. the wheel again, this time with the running emote lit — that chip is
  //    also the one that stops it.
  await actor.keyboard.press("KeyJ");
  await actor.waitForFunction(() => !!document.querySelector(".emote-slot.active"), undefined, { timeout: 8_000 });
  await actor.waitForTimeout(400);
  await save(actor, "wheel-active");
  await actor.keyboard.press("Escape");

  await actor.evaluate(() => window.__sf.player.playEmote("wave"));
  await watcher.waitForTimeout(700);
  await save(watcher, "remote-wave");
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
