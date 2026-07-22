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
const CENTER = { x: 1300, z: -1846 };
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
  if (initial.stage.deckBottom - initial.stage.groundHigh < 0.075) {
    throw new Error(`bandstand is buried in the terrain: ${JSON.stringify(initial.stage)}`);
  }
  const pianoLayout = await page.evaluate(() => {
    const sf = window.__sf;
    const piano = sf.fortMasonEnsemble.root.getObjectByName("fort-mason-piano");
    const pianist = piano?.getObjectByName("fort-mason-piano-npc");
    const pianoCase = piano?.getObjectByName("fort-mason-piano-case");
    const keyboard = piano?.getObjectByName("fort-mason-piano-keyboard");
    if (!piano || !pianist || !pianoCase || !keyboard) return null;
    const toPiano = pianoCase.position.clone().sub(pianist.position).normalize();
    const pianistFront = new sf.THREE.Vector3(0, 0, -1).applyQuaternion(pianist.quaternion);
    return {
      pianistZ: pianist.position.z,
      keyboardZ: keyboard.position.z,
      pianoCaseZ: pianoCase.position.z,
      facingDot: pianistFront.dot(toPiano)
    };
  });
  if (
    !pianoLayout ||
    pianoLayout.keyboardZ <= pianoLayout.pianoCaseZ ||
    pianoLayout.keyboardZ >= pianoLayout.pianistZ ||
    pianoLayout.facingDot < 0.9
  ) {
    throw new Error(`pianist is not facing the keyboard/piano: ${JSON.stringify(pianoLayout)}`);
  }

  const ground = await page.evaluate(({ x, z }) => window.__sf.map.groundTop(x, z), CENTER);
  await page.evaluate(({ x, z, ground }) => {
    window.__sfFreeCam([x + 10, ground + 5.4, z + 12], [x, ground + 1.0, z - 0.3]);
    const hud = document.getElementById("hud");
    if (hud) hud.style.display = "none";
  }, { ...CENTER, ground });
  // Manual ticks advance the world state, while WebGPU presents on real
  // animation frames. Interleave both so the just-admitted root reaches the
  // actual camera-facing render before capture.
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.__sf.tick(1 / 30));
    await sleep(30);
  }
  await page.screenshot({ path: path.join(OUT, "ensemble-wide.png") });

  await page.evaluate(() => {
    const sf = window.__sf;
    const root = sf.fortMasonEnsemble.root;
    const eye = root.localToWorld(new sf.THREE.Vector3(-6.2, 3.0, 4.8));
    const target = root.localToWorld(new sf.THREE.Vector3(-2.75, 1.0, -0.12));
    window.__sfFreeCam(eye.toArray(), target.toArray());
  });
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => window.__sf.tick(1 / 30));
    await sleep(30);
  }
  await page.screenshot({ path: path.join(OUT, "ensemble-piano-close.png") });

  // Move beside the piano and use the public interaction seam. Vite's relay can
  // be online, so allow a short claim round trip before checking the local slot.
  await page.evaluate(({ online }) => {
    const sf = window.__sf;
    // By default the shared developer relay on :8787 may belong to another
    // worktree and not know this protocol yet. The online end-to-end pass sets
    // SF_PROBE_ONLINE=1 and points VITE_WS_URL at this worktree's relay.
    if (!online) {
      sf.net.status = "offline";
      sf.net.selfId = 0;
    }
    const pianoSeat = sf.fortMasonEnsemble.debugState().stationWorld[0];
    sf.player.restoreState({
      mode: "walk",
      x: pianoSeat.x,
      y: pianoSeat.y + 0.62,
      z: pianoSeat.z,
      heading: Math.PI
    });
    sf.fortMasonEnsemble.tryInteract(sf.player.renderPosition, "walk");
  }, { online: process.env.SF_PROBE_ONLINE === "1" });
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
    pianoLayout,
    claimed,
    released,
    pageErrors
  };
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
