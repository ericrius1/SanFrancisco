// Headless WebGPU verification for the lazy Fort Mason collaborative ensemble.
// Checks clean-boot requests, first-approach hydration, NPC/autoplay state,
// local seat takeover, linked-scale input, release, and captures review frames.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/fort-mason-ensemble");
const URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5244/?autostart=1&profile=1&fullfps=1";
const CENTER = { x: 1284, z: -1846 };
const CHROME = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].find((candidate) => candidate && existsSync(candidate));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!CHROME) throw new Error("Chrome not found");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--disable-gpu-sandbox",
    "--autoplay-policy=no-user-gesture-required",
    "--hide-scrollbars"
  ]
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const requests = [];
const pageErrors = [];
page.on("request", (request) => requests.push(request.url()));
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") pageErrors.push(message.text());
});

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__sf?.player && window.__sf?.map && window.__sfManual), null, {
    timeout: 180_000
  });
  await page.evaluate(() => window.__sfManual(true));

  // Tiny coordinate metadata is intentionally boot-resident; the optional
  // implementation chunk itself must remain absent until first approach.
  const featureRequest = (url) => /fortMasonEnsemble\/index\.ts|fort-mason-ensemble.*\.js/i.test(url);
  const bootFeatureRequests = requests.filter(featureRequest);
  if (bootFeatureRequests.length) {
    throw new Error(`ensemble fetched during clean boot: ${bootFeatureRequests.join(", ")}`);
  }

  await page.evaluate(({ x, z }) => {
    const sf = window.__sf;
    const y = sf.map.groundTop(x, z + 12);
    sf.player.teleportTo({ x, y: y + 1.5, z: z + 12, facing: Math.PI, mode: "walk" });
  }, CENTER);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    await page.evaluate(() => window.__sf.tick(1 / 30));
    const ready = await page.evaluate(() => Boolean(window.__sf.fortMasonEnsemble));
    if (ready) break;
    await sleep(80);
  }
  if (!(await page.evaluate(() => Boolean(window.__sf.fortMasonEnsemble)))) {
    throw new Error("Fort Mason ensemble never hydrated");
  }

  for (let i = 0; i < 90; i++) await page.evaluate(() => window.__sf.tick(1 / 30));
  const activationRequests = requests.filter(featureRequest);
  if (activationRequests.length !== 1) {
    throw new Error(`expected one feature request on activation, saw ${activationRequests.length}`);
  }

  const initial = await page.evaluate(() => window.__sf.fortMasonEnsemble.debugState());
  if (!initial.visible || initial.labels.join("|") !== "piano|steel drum|pan pipes") {
    throw new Error(`bad initial ensemble state: ${JSON.stringify(initial)}`);
  }
  if (initial.scale.join(",") !== "60,62,64,67,69,72,74,76") {
    throw new Error(`linked scale changed: ${initial.scale.join(",")}`);
  }
  if (!initial.npcTicks.every((tick) => tick >= 0) || !initial.npcVisible.every(Boolean)) {
    throw new Error(`NPC autoplay did not activate all three parts: ${JSON.stringify(initial)}`);
  }

  const ground = await page.evaluate(({ x, z }) => window.__sf.map.groundTop(x, z), CENTER);
  await page.evaluate(({ x, z, ground }) => {
    window.__sfFreeCam([x + 10, ground + 5.4, z + 12], [x, ground + 1.0, z - 0.3]);
    const hud = document.getElementById("hud");
    if (hud) hud.style.display = "none";
  }, { ...CENTER, ground });
  for (let i = 0; i < 8; i++) await page.evaluate(() => window.__sf.tick(1 / 30));
  await page.screenshot({ path: path.join(OUT, "ensemble-wide.png") });

  // Move beside the piano and use the public interaction seam. Vite's relay can
  // be online, so allow a short claim round trip before checking the local slot.
  await page.evaluate(({ x, z, online }) => {
    const sf = window.__sf;
    // By default the shared developer relay on :8787 may belong to another
    // worktree and not know this protocol yet. The online end-to-end pass sets
    // SF_PROBE_ONLINE=1 and points VITE_WS_URL at this worktree's relay.
    if (!online) {
      sf.net.status = "offline";
      sf.net.selfId = 0;
    }
    const y = sf.map.groundTop(x, z);
    sf.player.restoreState({ mode: "walk", x: x - 2.75, y: y + 0.62, z: z + 1.32, heading: Math.PI });
    sf.fortMasonEnsemble.tryInteract(sf.player.renderPosition, "walk");
  }, { ...CENTER, online: process.env.SF_PROBE_ONLINE === "1" });
  for (let i = 0; i < 90; i++) {
    await page.evaluate(() => window.__sf.tick(1 / 60));
    if ((await page.evaluate(() => window.__sf.fortMasonEnsemble.debugState().localSlot)) === 0) break;
    await sleep(20);
  }
  const claimed = await page.evaluate(() => window.__sf.fortMasonEnsemble.debugState());
  if (claimed.localSlot !== 0) throw new Error(`piano takeover failed: ${JSON.stringify(claimed)}`);

  await page.keyboard.press("Digit6");
  await page.evaluate(() => window.__sf.tick(1 / 30));
  const afterNoteRequests = requests.filter(featureRequest);
  if (afterNoteRequests.length !== 1) {
    throw new Error(`playing a note fetched another feature resource: ${afterNoteRequests.length}`);
  }
  await page.screenshot({ path: path.join(OUT, "ensemble-piano-takeover.png") });

  await page.evaluate(() => window.__sf.fortMasonEnsemble.tryInteract(window.__sf.player.renderPosition, "walk"));
  for (let i = 0; i < 60; i++) {
    await page.evaluate(() => window.__sf.tick(1 / 60));
    if ((await page.evaluate(() => window.__sf.fortMasonEnsemble.debugState().localSlot)) === null) break;
    await sleep(20);
  }
  const released = await page.evaluate(() => window.__sf.fortMasonEnsemble.debugState());
  if (released.localSlot !== null) throw new Error(`seat release failed: ${JSON.stringify(released)}`);

  const report = {
    ok: true,
    url: URL,
    cleanBootFeatureRequests: bootFeatureRequests,
    activationFeatureRequests: activationRequests,
    requestCountAfterNote: afterNoteRequests.length,
    initial,
    claimed,
    released,
    pageErrors
  };
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
