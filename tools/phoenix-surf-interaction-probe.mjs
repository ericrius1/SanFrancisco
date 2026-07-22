import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
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
    "--mute-audio"
  ]
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto(`${URL}/?autostart=1&fullfps`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__sf?.renderIdle?.(), null, { timeout: 120_000 });
  await page.waitForFunction(
    () => window.__sf?.player?.walkGrounded && !window.__sf.player.worldArrivalHeld,
    null,
    { timeout: 60_000 }
  );

  // Derive the live dry-sand apron instead of relying on a baked shoreline.
  const beachTarget = await page.evaluate(() => {
    const sf = window.__sf;
    const z = 3370;
    for (let x = -6100; x < -5700; x += 2) {
      if (!sf.map.isWater(x, z)) return { x: x + 17, z };
    }
    throw new Error("Ocean Beach dry-sand apron was not found");
  });
  await page.evaluate(
    ({ x, z }) => window.__sf.teleportToTarget(x, z, "Phoenix surf interaction"),
    beachTarget
  );
  await page.waitForFunction(
    () => {
      const sf = window.__sf;
      return !sf.worldArrival.active &&
        sf.player.mode === "walk" &&
        sf.player.walkGrounded &&
        !sf.player.walkSwimming;
    },
    null,
    { timeout: 120_000 }
  );

  // Summon synchronously from the verified grounded state, matching the final
  // toolbar route while avoiding a transient grounded-edge race in the probe.
  const origin = await page.evaluate(() => {
    const sf = window.__sf;
    const p = sf.player.position;
    sf.embodiments.switchMode("bird");
    return { x: p.x, y: p.y, z: p.z };
  });
  assert(Math.abs(origin.x - beachTarget.x) < 25, "probe did not land on the Ocean Beach surf apron");
  await page.waitForFunction(
    () => {
      const sf = window.__sf;
      return sf.player.mode === "walk" &&
        sf.abandonedMounts.debugMounts().some((mount) =>
          mount.mode === "bird" &&
          mount.parked &&
          Math.hypot(mount.x - sf.player.position.x, mount.z - sf.player.position.z) < 5.5
        );
    },
    null,
    { timeout: 10_000 }
  );
  await page.waitForFunction(
    () => document.querySelector('[data-hud="center"]')?.textContent?.toLowerCase().includes("ride the phoenix"),
    null,
    { timeout: 10_000 }
  );

  const prompt = await page.locator('[data-hud="center"]').textContent();
  await page.keyboard.press("e");
  await page.waitForFunction(
    () => window.__sf.player.mode === "bird" || window.__sf.player.mode === "surf",
    null,
    { timeout: 30_000 }
  );
  const mode = await page.evaluate(() => window.__sf.player.mode);

  assert.equal(mode, "bird", "Ocean Beach surf fallback stole the prompted Phoenix interaction");
  assert.equal(errors.length, 0, `browser errors:\n${errors.join("\n")}`);
  console.log(JSON.stringify({ ok: true, beachTarget, origin, prompt, mode }, null, 2));
} finally {
  await browser.close();
}
