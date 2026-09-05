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
const SPAWN = process.env.SF_PROBE_SPAWN ?? "botanicalGarden";
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
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1&spawn=${encodeURIComponent(SPAWN)}`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
    await page.waitForFunction(
      () => window.__sf?.player && document.body.classList.contains("started") && !window.__sf.worldArrival.active,
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
      icons.length >= 5 && new Set(icons.map((icon) => icon.src)).size === icons.length && icons.every((icon) => icon.complete && icon.width > 0 && icon.height > 0),
      icons
    );

    phase = "activate";
    await page.keyboard.press("Digit2");
    await page.waitForFunction(() => window.__sf.player.mode === "drive" && !window.__sf.worldArrival.active && !window.__sf.player.worldArrivalHeld, undefined, { timeout: 120_000 });
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

    const groundingSnapshot = async (label) => page.evaluate((snapshotLabel) => {
      const sf = window.__sf;
      const player = sf.player;
      const mesh = player.meshes.drive;
      const p = player.renderPosition;
      const transform = sf.physics.world.getBodyTransform(player.body);
      const velocity = sf.physics.world.getBodyVelocity(player.body);
      const q = mesh.quaternion;
      const meshPitch = Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.x - q.y * q.z))));
      const meshRoll = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.x * q.x + q.z * q.z));
      const wheels = ["fl", "fr", "rl", "rr"].map((corner) => {
        const wheel = mesh.getObjectByName(`car_wheel_${corner}`);
        const center = wheel.getWorldPosition(p.clone());
        const radius = 0.43; // CAR_WHEEL_RADIUS; diagnostic only
        const ground = sf.map.rideGround(center.x, center.z, center.y);
        return { corner, center: center.toArray(), radius, ground, tireGap: center.y - radius - ground };
      });
      const ground = sf.map.rideGround(p.x, p.z, p.y);
      return {
        label: snapshotLabel,
        mode: player.mode,
        worldArrivalActive: sf.worldArrival.active,
        worldArrivalHeld: player.worldArrivalHeld,
        renderPosition: p.toArray(),
        bodyPosition: transform.position,
        bodyRotation: transform.rotation,
        linearVelocity: velocity.linear,
        angularVelocity: velocity.angular,
        meshPitch,
        meshRoll,
        contactY: mesh.userData.contactY,
        rideHeight: player.driveSpec.rideHeight,
        centerGround: ground,
        centerVerticalGap: p.y + mesh.userData.contactY - ground,
        wheels
      };
    }, label);

    // Record the authored/random spawn because steep or uneven terrain makes a
    // centre-point gap depend on chassis pitch. Assert the contact contract at a
    // fixed, flat downtown street fixture so this probe is deterministic.
    const spawnGrounding = [];
    for (let i = 0; i < 12; i++) {
      spawnGrounding.push(await groundingSnapshot(`spawn-${i * 250}ms`));
      await sleep(250);
    }
    await page.evaluate(async () => {
      const sf = window.__sf;
      const x = 4117;
      const z = 130;
      const ground = sf.map.rideGround(x, z, sf.player.renderPosition.y);
      await sf.player.teleportTo({ x, y: ground + sf.player.driveSpec.rideHeight, z, facing: 0, mode: "drive" });
    });
    await page.waitForFunction(() => {
      const sf = window.__sf, p = sf.player.renderPosition;
      const velocity = sf.physics.world.getBodyVelocity(sf.player.body);
      const gap = p.y + sf.player.meshes.drive.userData.contactY - sf.map.rideGround(p.x, p.z, p.y);
      return !sf.player.worldArrivalHeld && Math.abs(velocity.linear[1]) < 0.15 && Math.abs(gap) < 0.24;
    }, undefined, { timeout: 30_000 });
    const parked = await groundingSnapshot("flat-downtown-settled");
    check("car-visually-grounded-at-rest", Math.abs(parked.centerVerticalGap) < 0.24, {
      spawn: spawnGrounding,
      fixture: parked
    });
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
    // Moving suspension can be airborne; car-jump/grounding fixtures cover it.
    await page.screenshot({ path: path.join(OUT, "car-road-desktop.png"), fullPage: false, timeout: 120_000 });

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
    await page.screenshot({ path: path.join(OUT, "car-atelier-desktop.png"), fullPage: false, timeout: 120_000 });

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
      mobileIcons.length >= 1 && mobileIcons.some(icon => icon.src.endsWith("/car.webp")) && !iconsOverlap && mobileIcons.every((icon) => icon.left >= 0 && icon.right <= mobile.viewport.width),
      mobileIcons
    );
    await page.screenshot({ path: path.join(OUT, "car-atelier-mobile.png"), fullPage: false, timeout: 120_000 });

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
