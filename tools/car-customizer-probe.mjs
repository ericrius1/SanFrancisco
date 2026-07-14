// End-to-end car customizer and selected-only asset-loading probe.
//
// Usage:
//   SF_PROBE_URL=http://127.0.0.1:5243 node tools/car-customizer-probe.mjs

// The isolated profile starts with one known saved car so the expected request
// set is deterministic: zero car art/editor code at boot, exactly its selected
// finish + decal on car activation, the UI chunk on editor open, then exactly
// one newly chosen finish.

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/car-customizer-probe");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5243").replace(/\/$/, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SAVED_CAR = {
  form: "coast-coupe",
  surface: "fogline-graphite",
  decal: "coastal-gull",
  wheel: "split-five",
  paint: 1,
  trim: 1,
  interior: 0,
  rim: 0,
  paintHex: null,
  trimHex: null,
  interiorHex: null,
  rimHex: null,
  surfaceScale: 48,
  decalScale: 50,
  decalPosition: 52,
  clearcoat: 72
};

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error("Chrome/Chromium not found; set CHROME_BIN");
}

async function waitHttp(url, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function featureKind(url) {
  const pathname = new URL(url).pathname;
  if (pathname.startsWith("/cars/textures/")) return "texture";
  if (pathname.startsWith("/cars/decals/")) return "decal";
  if (pathname.includes("/src/ui/carSelector.ts") || /carSelector-[\w-]+\.js$/.test(pathname)) return "ui-chunk";
  return null;
}

async function waitFor(predicate, message, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(message);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await waitHttp(BASE_URL);
  const browser = await chromium.launch({
    executablePath: await findChrome(),
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-gpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      `--use-angle=${process.env.SF_ANGLE ?? (process.platform === "darwin" ? "metal" : "swiftshader")}`,
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--hide-scrollbars",
      "--mute-audio"
    ]
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  await context.addInitScript((car) => localStorage.setItem("sf-car-v1", JSON.stringify(car)), SAVED_CAR);
  const page = await context.newPage();
  const records = [];
  const errors = [];
  const checks = [];
  let phase = "boot";
  const check = (id, pass, detail) => checks.push({ id, pass, detail });
  page.on("request", (request) => {
    const kind = featureKind(request.url());
    if (kind) records.push({ phase, kind, url: request.url(), status: null });
  });
  page.on("response", (response) => {
    const record = [...records].reverse().find((entry) => entry.url === response.url() && entry.status === null);
    if (record) record.status = response.status();
  });
  page.on("pageerror", (error) => errors.push(`page: ${error}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  try {
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
    await page.waitForFunction(
      () => window.__sf?.player && document.body.classList.contains("started"),
      undefined,
      { timeout: 180_000 }
    );
    await sleep(2500);
    const boot = records.filter((entry) => entry.phase === "boot");
    check("clean-boot-no-car-art", !boot.some((entry) => entry.kind === "texture" || entry.kind === "decal"), boot);
    check("clean-boot-no-editor-chunk", !boot.some((entry) => entry.kind === "ui-chunk"), boot);
    const icons = await page.evaluate(() => [...document.querySelectorAll(".customizer-icon")].map((icon) => ({
      src: icon.getAttribute("src"),
      complete: icon.complete,
      width: icon.naturalWidth,
      height: icon.naturalHeight
    })));
    check(
      "generated-customizer-icons-ready",
      icons.length === 5 && new Set(icons.map((icon) => icon.src)).size === 5 && icons.every((icon) => icon.complete && icon.width === 256 && icon.height === 256),
      icons
    );

    phase = "activate";
    await page.keyboard.press("Digit2");
    await page.waitForFunction(() => window.__sf.player.mode === "drive", undefined, { timeout: 15_000 });
    await waitFor(
      () => records.some((entry) => entry.phase === "activate" && entry.url.includes("fogline-graphite.webp")) &&
        records.some((entry) => entry.phase === "activate" && entry.url.includes("coastal-gull.webp")),
      "selected finish/decal did not load on car activation"
    );
    await sleep(500);
    const activated = records.filter((entry) => entry.phase === "activate");
    const activatedArt = activated.filter((entry) => entry.kind === "texture" || entry.kind === "decal");
    check(
      "activation-selected-only",
      activatedArt.length === 2 && activatedArt.every((entry) => entry.status === 200),
      activatedArt
    );
    check("activation-keeps-editor-cold", !activated.some((entry) => entry.kind === "ui-chunk"), activated);

    const beforeSpin = await page.evaluate(() => {
      const wheel = window.__sf.player.meshes.drive.getObjectByName("car_wheel_fl");
      return wheel?.rotation.x ?? 0;
    });
    await page.keyboard.down("KeyW");
    await sleep(1200);
    await page.keyboard.up("KeyW");
    const motion = await page.evaluate((before) => {
      const sf = window.__sf;
      const mesh = sf.player.meshes.drive;
      const wheel = mesh.getObjectByName("car_wheel_fl");
      let spokeCount = 0;
      mesh.traverse((object) => { if (object.name.startsWith("car_spoke_")) spokeCount++; });
      const ground = sf.map.rideGround(sf.player.renderPosition.x, sf.player.renderPosition.z, sf.player.renderPosition.y);
      return {
        rotationDelta: Math.abs((wheel?.rotation.x ?? 0) - before),
        spokeCount,
        contactContract: Math.abs(sf.player.driveSpec.rideHeight + mesh.userData.contactY),
        visualGroundDelta: sf.player.renderPosition.y + mesh.userData.contactY - ground,
        speed: sf.player.speed
      };
    }, beforeSpin);
    check("spokes-present", motion.spokeCount === 40, motion);
    check("spokes-rotate", motion.rotationDelta > 0.2, motion);
    check("tire-contact-contract", motion.contactContract < 1e-6, motion);
    check("car-visually-grounded", Math.abs(motion.visualGroundDelta) < 0.24, motion);
    await page.screenshot({ path: path.join(OUT, "car-road-desktop.png"), fullPage: false });

    phase = "editor";
    await page.locator(".car-launcher-ui .car-toggle").click({ force: true });
    await page.locator(".car-panel").waitFor({ state: "visible", timeout: 20_000 });
    await waitFor(
      () => records.some((entry) => entry.phase === "editor" && entry.kind === "ui-chunk"),
      "car editor chunk did not load"
    );
    await sleep(300);
    const editor = records.filter((entry) => entry.phase === "editor");
    check("editor-chunk-on-demand", editor.filter((entry) => entry.kind === "ui-chunk").length === 1, editor);
    check("editor-does-not-refetch-selected-art", !editor.some((entry) => entry.kind === "texture" || entry.kind === "decal"), editor);
    check("abstract-car-preview-removed", await page.locator(".car-preview, .car-preview-frame").count() === 0, null);

    const clearcoat = page.locator('input[aria-label="Clearcoat"]');
    const previewBefore = await page.evaluate(() => ({
      mesh: window.__sf.player.meshes.drive.userData.carConfig.clearcoat,
      saved: JSON.parse(localStorage.getItem("sf-car-v1")).clearcoat
    }));
    await clearcoat.evaluate((input) => {
      input.value = "91";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => window.__sf.player.meshes.drive.userData.carConfig.clearcoat === 91, undefined, { timeout: 10_000 });
    const previewHeld = await page.evaluate(() => ({
      mesh: window.__sf.player.meshes.drive.userData.carConfig.clearcoat,
      saved: JSON.parse(localStorage.getItem("sf-car-v1")).clearcoat
    }));
    check(
      "held-slider-previews-live-car-only",
      previewBefore.mesh === 72 && previewBefore.saved === 72 && previewHeld.mesh === 91 && previewHeld.saved === 72,
      { before: previewBefore, held: previewHeld }
    );
    await clearcoat.evaluate((input) => input.dispatchEvent(new Event("change", { bubbles: true })));
    await page.waitForFunction(() => window.__sf.getCarConfig().clearcoat === 91, undefined, { timeout: 10_000 });

    phase = "choice";
    await page.getByRole("button", { name: "sunset terrazzo", exact: true }).click();
    await waitFor(
      () => records.some((entry) => entry.phase === "choice" && entry.url.includes("sunset-terrazzo.webp")),
      "newly selected finish did not load"
    );
    await page.getByRole("button", { name: /trail box/i }).click();
    await page.waitForFunction(() => window.__sf.getCarConfig().form === "trail-box", undefined, { timeout: 10_000 });
    await sleep(500);
    const choice = records.filter((entry) => entry.phase === "choice" && (entry.kind === "texture" || entry.kind === "decal"));
    check("choice-loads-one-new-asset", choice.length === 1 && choice[0].url.includes("sunset-terrazzo.webp") && choice[0].status === 200, choice);
    const committed = await page.evaluate(() => ({
      config: window.__sf.getCarConfig(),
      meshConfig: window.__sf.player.meshes.drive.userData.carConfig,
      stored: JSON.parse(localStorage.getItem("sf-car-v1"))
    }));
    check(
      "shape-and-persistence-commit",
      committed.config.form === "trail-box" && committed.meshConfig.form === "trail-box" && committed.stored.form === "trail-box" && committed.stored.surface === "sunset-terrazzo",
      committed
    );
    await page.screenshot({ path: path.join(OUT, "car-atelier-desktop.png"), fullPage: false });

    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(300);
    const mobile = await page.locator(".car-panel").evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      const controls = [...panel.querySelectorAll("button, input")].map((node) => node.getBoundingClientRect());
      return {
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
        viewport: { width: innerWidth, height: innerHeight },
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        minControlHeight: Math.min(...controls.map((rect) => rect.height))
      };
    });
    check(
      "mobile-panel-fits-and-scrolls",
      mobile.rect.left >= 0 && mobile.rect.right <= mobile.viewport.width && mobile.rect.top >= 0 && mobile.rect.height <= mobile.viewport.height && mobile.scrollHeight >= mobile.clientHeight,
      mobile
    );
    check("mobile-controls-remain-usable", mobile.minControlHeight >= 24, mobile);
    const mobileIcons = await page.evaluate(() => [...document.querySelectorAll(".customizer-icon")]
      .filter((icon) => icon.offsetParent !== null)
      .map((icon) => {
        const rect = icon.closest("button").getBoundingClientRect();
        return { src: icon.getAttribute("src"), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }));
    const iconsOverlap = mobileIcons.some((a, index) => mobileIcons.slice(index + 1).some((b) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
    ));
    check(
      "mobile-icon-grid-has-no-overlap",
      mobileIcons.length === 5 && !iconsOverlap && mobileIcons.every((icon) => icon.left >= 0 && icon.right <= mobile.viewport.width),
      mobileIcons
    );
    await page.screenshot({ path: path.join(OUT, "car-atelier-mobile.png"), fullPage: false });

    check("runtime-no-errors", errors.length === 0, errors);
    const report = {
      ok: checks.every((entry) => entry.pass),
      url: BASE_URL,
      checks,
      requests: records,
      errors,
      artifacts: [
        path.join(OUT, "car-road-desktop.png"),
        path.join(OUT, "car-atelier-desktop.png"),
        path.join(OUT, "car-atelier-mobile.png")
      ]
    };
    await writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

await main();
