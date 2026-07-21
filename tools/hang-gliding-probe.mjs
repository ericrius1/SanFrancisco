// Skyline Glide end-to-end probe.
//
// Verifies the optional quest stays off the clean-boot waterfall, loads on
// demand, starts from Sutro Tower, owns the hang-glider flight profile and HUD,
// completes its course/result loop, and fits desktop + narrow viewports.

// Usage:
//   SF_PROBE_URL=http://127.0.0.1:5240 node tools/hang-gliding-probe.mjs

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/hang-gliding-probe");
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "");
const OPTIONAL_CODE = /\/src\/(?:gameplay\/hangGliding\/(?:index|experience|ui|mesh|world|oceanLights|audio|style|canopyMaterial)|vehicles\/plane\/hangGliderPhysics)\.ts(?:\?|$)/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function waitHttp(url, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function fitReport(page, selectors) {
  return page.evaluate((wanted) => {
    const viewport = { width: innerWidth, height: innerHeight };
    return {
      viewport,
      elements: wanted.map((selector) => {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) return { selector, present: false };
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          selector,
          present: true,
          visible: style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.9,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          inside:
            rect.left >= -1 && rect.top >= -1 &&
            rect.right <= viewport.width + 1 && rect.bottom <= viewport.height + 1
        };
      })
    };
  }, selectors);
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
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  const checks = [];
  const check = (id, pass, detail) => checks.push({ id, pass, detail });
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(`page: ${error}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  let activeDesktop;
  let activeMobile;
  let customizerDesktop;
  let customizerMobile;
  let customizerLandscape;
  let resultMobile;
  try {
    await page.goto(
      `${BASE_URL}/?autostart=1&fullfps=1&profile=1&j=0,50,-2000,0,walk&via=hang-gliding-probe`,
      { waitUntil: "domcontentloaded", timeout: 120_000 }
    );
    await page.waitForFunction(
      () => window.__sf?.player && document.body.classList.contains("started"),
      undefined,
      { timeout: 180_000 }
    );
    await page.waitForFunction(
      () => window.__sf?.renderIdle?.() === true,
      undefined,
      { timeout: 180_000 }
    );

    const bootOptional = requests.filter((url) => OPTIONAL_CODE.test(url));
    check("clean-boot-has-no-quest-code", bootOptional.length === 0, bootOptional);
    const registry = await page.evaluate(() =>
      window.__sf.optionalWorldSites.find((site) => site.id === "hang-gliding")?.state
    );
    check("quest-starts-dormant", registry === "dormant", registry);

    const beforeActivation = requests.length;
    await page.evaluate(() => window.__sf.ensureOptionalWorldSite("hang-gliding"));
    await page.waitForFunction(() => window.__sf?.hangGliding?.phase === "idle", undefined, { timeout: 90_000 });
    const activationRequests = requests.slice(beforeActivation);
    const loadedQuestCode = activationRequests.filter((url) => OPTIONAL_CODE.test(url));
    check("activation-loads-quest-code", loadedQuestCode.length >= 5, loadedQuestCode);

    await page.evaluate(() => {
      const sf = window.__sf;
      const quest = sf.hangGliding;
      const access = quest.course.access;
      quest.setAwake(true);
      sf.player.respawn({
        x: access.x,
        y: access.y + 1.45,
        z: access.z,
        heading: access.heading
      });
      sf.chase.cutTo(sf.player);
    });
    await page.waitForFunction(() => document.querySelector(".hg-prompt")?.classList.contains("show"), undefined, {
      timeout: 15_000
    });
    const liftPrompt = await page.locator(".hg-prompt").textContent();
    check("service-lift-prompt-visible-at-sutro", /service lift/.test(liftPrompt ?? ""), liftPrompt);
    await page.keyboard.press("KeyE");
    await page.waitForFunction(
      () => Math.abs(window.__sf.player.position.y - window.__sf.hangGliding.course.deck.y) < 3,
      undefined,
      { timeout: 15_000 }
    );
    await page.waitForFunction(
      () => /launch the Skyline Glide/.test(document.querySelector(".hg-prompt")?.textContent ?? ""),
      undefined,
      { timeout: 15_000 }
    );
    check("service-lift-reaches-upper-flight-deck", true, null);
    const parkedGlider = await page.evaluate(() => {
      const quest = window.__sf.hangGliding;
      const glider = quest.root.getObjectByName("sutro_hang_glider");
      return {
        present: !!glider,
        visible: glider?.visible,
        parkedUnderSite: glider?.parent === quest.root,
        distanceFromLaunch: glider ? glider.position.distanceTo(quest.course.launch) : null,
        rootInScene: quest.debugState.rootInScene
      };
    });
    check(
      "glider-visible-on-upper-platform-before-launch",
      parkedGlider.present && parkedGlider.visible && parkedGlider.parkedUnderSite && parkedGlider.rootInScene,
      parkedGlider
    );
    await page.screenshot({ path: path.join(OUT, "launch-platform.png"), fullPage: false });

    const beforeLaunch = requests.length;
    await page.keyboard.press("KeyE");
    await page.waitForFunction(() => window.__sf?.hangGliding?.phase === "flying", undefined, { timeout: 15_000 });
    await sleep(500);
    const flight = await page.evaluate(() => {
      const sf = window.__sf;
      const plane = sf.player.meshes.plane;
      const glider = plane.getObjectByName("sutro_hang_glider");
      const canopy = glider?.getObjectByName("hang_glider_canopy");
      const geometry = canopy?.geometry;
      geometry?.computeBoundingBox();
      const size = geometry?.boundingBox?.getSize(new canopy.position.constructor());
      const siblingVisibility = plane.children
        .filter((child) => child !== glider)
        .map((child) => ({ name: child.name, visible: child.visible }));
      return {
        mode: sf.player.mode,
        hangGliding: sf.player.hangGliding,
        questActive: sf.hangGliding.active,
        gliderPresent: !!glider,
        gliderAttached: glider?.parent === plane,
        normalPlaneHidden: siblingVisibility.filter((child) => child.visible).length === 1,
        siblingVisibility,
        courseVisible: sf.hangGliding.debugState.courseVisible,
        telemetryActive: sf.player.hangGliderTelemetry.active,
        airspeed: sf.player.hangGliderTelemetry.airspeed,
        canopyVertices: geometry?.getAttribute("position")?.count ?? 0,
        canopySpan: size?.x ?? 0,
        canopyChord: size?.z ?? 0,
        canopyNodeMaterial: Boolean(canopy?.material?.isNodeMaterial)
      };
    });
    check("flight-enters-special-plane-mode", flight.mode === "plane" && flight.hangGliding && flight.questActive, flight);
    check("authored-glider-replaces-plane", flight.gliderPresent && flight.gliderAttached && flight.normalPlaneHidden, flight);
    check("course-and-flight-telemetry-active", flight.courseVisible && flight.telemetryActive, flight);
    check(
      "curved-gpu-canopy-is-high-resolution-and-large",
      flight.canopyVertices >= 800 && flight.canopySpan >= 12 && flight.canopyChord >= 5 && flight.canopyNodeMaterial,
      flight
    );
    const launchRequests = requests.slice(beforeLaunch);
    check("launch-needs-no-new-quest-fetches", launchRequests.filter((url) => OPTIONAL_CODE.test(url)).length === 0, launchRequests);

    await page.evaluate(() => {
      const sf = window.__sf;
      sf.sky.cycleEnabled = false;
      sf.sky.setTimeOfDay(22);
    });
    await page.waitForFunction(
      () => window.__sf.hangGliding.debugState.oceanLights.nightWeight > 0.95 &&
        window.__sf.hangGliding.debugState.oceanLights.visible,
      undefined,
      { timeout: 15_000 }
    );
    const oceanLightsNight = await page.evaluate(() => {
      const sf = window.__sf;
      const root = sf.hangGliding.root.getObjectByName("hang_gliding_ocean_lights");
      const surfaceCores = root?.getObjectByName("hang_gliding_ocean_surface_cores");
      const submergedCores = root?.getObjectByName("hang_gliding_ocean_submerged_cores");
      return {
        ...sf.hangGliding.debugState.oceanLights,
        rootPresent: Boolean(root),
        surfaceInstances: surfaceCores?.count ?? 0,
        submergedInstances: submergedCores?.count ?? 0,
        surfaceDepthTest: surfaceCores?.material?.depthTest,
        submergedDepthTest: submergedCores?.material?.depthTest
      };
    });
    check(
      "twilight-ocean-lights-show-only-during-flight",
      oceanLightsNight.visible && oceanLightsNight.rootPresent &&
        oceanLightsNight.surfaceInstances === oceanLightsNight.surfaceCount &&
        oceanLightsNight.submergedInstances === oceanLightsNight.submergedCount,
      oceanLightsNight
    );
    check(
      "submerged-ocean-lights-diffuse-through-water",
      oceanLightsNight.surfaceDepthTest === true && oceanLightsNight.submergedDepthTest === false,
      oceanLightsNight
    );

    await page.evaluate(() => {
      window.__sfFreeCam([-5750, 190, 3100], [-7050, 22, 3100]);
      window.__sf.hud.message("", 0);
    });
    await page.evaluate(async () => {
      for (let i = 0; i < 8; i++) window.__sf.tick(1 / 30);
      await window.__sf.renderer.backend.device.queue.onSubmittedWorkDone();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({ path: path.join(OUT, "ocean-lights-night.png"), fullPage: false });
    await page.evaluate(() => {
      window.__sfFreeCam(null);
      window.__sf.chase.cutTo(window.__sf.player);
      window.__sf.sky.setTimeOfDay(12);
    });
    await page.waitForFunction(
      () => !window.__sf.hangGliding.debugState.oceanLights.visible,
      undefined,
      { timeout: 15_000 }
    );
    const oceanLightsDay = await page.evaluate(() => ({
      ...window.__sf.hangGliding.debugState.oceanLights,
      flightActive: window.__sf.hangGliding.active
    }));
    check(
      "ocean-lights-hide-in-daylight-while-still-flying",
      oceanLightsDay.visible === false && oceanLightsDay.nightWeight < 0.002 && oceanLightsDay.flightActive,
      oceanLightsDay
    );
    await page.evaluate(() => window.__sf.sky.setTimeOfDay(22));
    await page.waitForFunction(
      () => window.__sf.hangGliding.debugState.oceanLights.visible,
      undefined,
      { timeout: 15_000 }
    );

    const beforeDive = flight.airspeed;
    await page.evaluate(() => window.__sfManual(true));
    await page.keyboard.down("KeyW");
    await page.evaluate(() => {
      for (let i = 0; i < 90; i++) window.__sf.tick(1 / 60);
    });
    await page.keyboard.up("KeyW");
    const afterDive = await page.evaluate(() => window.__sf.player.hangGliderTelemetry.airspeed);
    check("nose-down-builds-airspeed", afterDive > beforeDive + 0.25, { beforeDive, afterDive });

    const beforeBankHeading = await page.evaluate(() => window.__sf.player.heading);
    await page.keyboard.down("KeyD");
    await page.evaluate(() => {
      for (let i = 0; i < 72; i++) window.__sf.tick(1 / 60);
    });
    await page.keyboard.up("KeyD");
    const bankCue = await page.evaluate((headingBefore) => {
      const player = window.__sf.player;
      const Vector3 = player.position.constructor;
      const heading = player.heading - Math.PI;
      const forward = new Vector3(-Math.sin(heading), 0, -Math.cos(heading));
      const worldUp = new Vector3(0, 1, 0);
      const right = forward.clone().cross(worldUp).normalize();
      const visualUp = worldUp.clone().applyQuaternion(player.quaternion);
      return {
        bank: player.hangGliderTelemetry.bank,
        headingDelta: player.heading - headingBefore,
        visualRightLean: visualUp.dot(right)
      };
    }, beforeBankHeading);
    check(
      "right-turn-bank-leans-right",
      bankCue.bank > 0.25 && bankCue.headingDelta < -0.02 && bankCue.visualRightLean > 0.08,
      bankCue
    );

    const spikeCamera = await page.evaluate(() => {
      const sf = window.__sf;
      const player = sf.player;
      const Vector3 = player.position.constructor;
      const Quaternion = player.quaternion.constructor;
      const before = sf.camera.getWorldDirection(new Vector3());
      const renderQuaternion = player.renderQuaternion.clone();
      const flyForward = player.flyForward.clone();
      const yaw = sf.chase.yaw;
      const pitch = sf.chase.pitch;
      const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
      player.renderQuaternion.premultiply(turn);
      player.flyForward.applyQuaternion(turn);
      sf.chase.update(0.25, player, sf.input);
      const after = sf.camera.getWorldDirection(new Vector3());
      const angularStep = before.angleTo(after);
      player.renderQuaternion.copy(renderQuaternion);
      player.flyForward.copy(flyForward);
      sf.chase.yaw = yaw;
      sf.chase.pitch = pitch;
      sf.chase.cutTo(player);
      return { angularStep };
    });
    check("hang-glider-camera-spike-is-bounded", spikeCamera.angularStep < 0.38, spikeCamera);

    await page.evaluate(() => {
      window.__sfManual(true);
      const sf = window.__sf;
      const plane = sf.player.meshes.plane;
      plane.updateMatrixWorld(true);
      const eye = plane.localToWorld(plane.position.clone().set(0, 4, 11));
      const target = plane.localToWorld(plane.position.clone().set(0, -0.4, 0));
      window.__sfFreeCam([eye.x, eye.y, eye.z], [target.x, target.y, target.z]);
      sf.hud.message("", 0);
    });
    await page.evaluate(async () => {
      for (let i = 0; i < 3; i++) window.__sf.tick(1 / 30);
      await window.__sf.renderer.backend.device.queue.onSubmittedWorkDone();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    activeDesktop = await fitReport(page, [".hg-objective.show", ".hg-score.show", ".hg-instruments.show", ".hg-prompt.show"]);
    check("desktop-flight-hud-fits", activeDesktop.elements.every((entry) => entry.present && entry.visible && entry.inside), activeDesktop);
    await page.screenshot({ path: path.join(OUT, "flight-desktop.png"), fullPage: false });

    await page.evaluate(() => document.querySelector(".hg-customizer-toggle")?.click());
    await page.waitForFunction(() => document.querySelector(".hg-customizer")?.classList.contains("open"));
    const liveEdit = await page.evaluate(() => {
      const span = document.querySelector('input[aria-label^="Span:"]');
      if (!(span instanceof HTMLInputElement)) throw new Error("span control missing");
      span.value = "1.17";
      span.dispatchEvent(new Event("input", { bubbles: true }));
      const aurora = document.querySelector('button[aria-label="Aurora canopy dye"]');
      if (!(aurora instanceof HTMLButtonElement)) throw new Error("aurora dye missing");
      aurora.click();
      const sf = window.__sf;
      const wing = sf.player.meshes.plane.getObjectByName("hang_glider_wing");
      return {
        style: sf.hangGliding.debugState.style,
        wingScaleX: wing?.scale.x,
        stored: Boolean(localStorage.getItem("sf.hang-glider-style")),
        pointerReleased: document.pointerLockElement === null
      };
    });
    await page.evaluate(async () => {
      window.__sf.tick(1 / 30);
      await window.__sf.renderer.backend.device.queue.onSubmittedWorkDone();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await sleep(250);
    check(
      "atelier-edits-live-wing-and-persists",
      liveEdit.style.palette === "aurora" && Math.abs(liveEdit.style.span - 1.17) < 0.001 &&
        Math.abs(liveEdit.wingScaleX - 1.17) < 0.001 && liveEdit.stored && liveEdit.pointerReleased,
      liveEdit
    );
    customizerDesktop = await fitReport(page, [".hg-customizer-toggle", ".hg-customizer-panel"]);
    check(
      "desktop-wing-atelier-fits",
      customizerDesktop.elements.every((entry) => entry.present && entry.visible && entry.inside),
      customizerDesktop
    );
    await page.screenshot({ path: path.join(OUT, "customizer-desktop.png"), fullPage: false });
    await page.evaluate(() => document.querySelector(".hg-customizer-toggle")?.click());

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.__sf.tick(1 / 30));
    await sleep(250);
    activeMobile = await fitReport(page, [".hg-objective.show", ".hg-score.show", ".hg-instruments.show", ".hg-prompt.show"]);
    const objective = activeMobile.elements.find((entry) => entry.selector.startsWith(".hg-objective"));
    const score = activeMobile.elements.find((entry) => entry.selector.startsWith(".hg-score"));
    const topCardsSeparate = objective && score
      ? objective.rect.x + objective.rect.width <= score.rect.x + 1
      : false;
    check("mobile-flight-hud-fits", activeMobile.elements.every((entry) => entry.present && entry.visible && entry.inside), activeMobile);
    check("mobile-top-cards-do-not-overlap", topCardsSeparate, { objective, score });
    await page.screenshot({ path: path.join(OUT, "flight-mobile.png"), fullPage: false });

    await page.evaluate(() => document.querySelector(".hg-customizer-toggle")?.click());
    await page.waitForFunction(() => document.querySelector(".hg-customizer")?.classList.contains("open"));
    await sleep(250);
    customizerMobile = await fitReport(page, [".hg-customizer-toggle", ".hg-customizer-panel"]);
    const touchTargets = await page.evaluate(() =>
      [...document.querySelectorAll(".hg-palette-choice, .hg-frame-choice, .hg-customizer-reset")]
        .map((node) => node.getBoundingClientRect().height)
    );
    check(
      "mobile-wing-atelier-fits",
      customizerMobile.elements.every((entry) => entry.present && entry.visible && entry.inside),
      customizerMobile
    );
    check("mobile-atelier-touch-targets", touchTargets.every((height) => height >= 43), touchTargets);
    await page.screenshot({ path: path.join(OUT, "customizer-mobile.png"), fullPage: false });

    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.__sf.tick(1 / 30));
    await sleep(250);
    customizerLandscape = await fitReport(page, [".hg-customizer-toggle", ".hg-customizer-panel"]);
    check(
      "landscape-wing-atelier-fits-and-scrolls",
      customizerLandscape.elements.every((entry) => entry.present && entry.visible && entry.inside),
      customizerLandscape
    );
    await page.screenshot({ path: path.join(OUT, "customizer-landscape.png"), fullPage: false });
    await page.evaluate(() => document.querySelector(".hg-customizer-toggle")?.click());

    await page.setViewportSize({ width: 1440, height: 960 });
    const finish = await page.evaluate(() => {
      const sf = window.__sf;
      const quest = sf.hangGliding;
      const player = sf.player;
      for (const gate of quest.course.gates) {
        player.position.set(gate.x, gate.y, gate.z);
        player.renderPosition.copy(player.position);
        quest.update(1 / 60, performance.now() / 1000, player, sf.hud, sf.input, sf.chase);
      }
      const landing = quest.course.landing;
      player.position.set(landing.x, landing.y + 0.4, landing.z);
      player.renderPosition.copy(player.position);
      const telemetry = player.hangGliderTelemetry;
      telemetry.landed = true;
      telemetry.touchdownSink = 1.4;
      telemetry.touchdownSpeed = 19;
      quest.update(1 / 60, performance.now() / 1000, player, sf.hud, sf.input, sf.chase);
      sf.tick(1 / 30);
      return {
        phase: quest.phase,
        mode: player.mode,
        hangGliding: player.hangGliding,
        gate: quest.debugState.gate,
        resultVisible: document.querySelector(".hg-result")?.classList.contains("show"),
        resultText: document.querySelector(".hg-result")?.textContent,
        resultRank: document.querySelector(".hg-rank")?.textContent
      };
    });
    check("full-course-opens-result", finish.phase === "result" && finish.resultVisible, finish);
    check("landing-restores-walk-mode", finish.mode === "walk" && finish.hangGliding === false, finish);
    check("soft-centered-flight-earns-s-rank", finish.resultRank === "S", finish);
    await sleep(1500);
    await page.screenshot({ path: path.join(OUT, "result-desktop.png"), fullPage: false });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.__sf.tick(1 / 30));
    await sleep(250);
    resultMobile = await fitReport(page, [".hg-result.show"]);
    check("mobile-result-fits", resultMobile.elements.every((entry) => entry.present && entry.visible && entry.inside), resultMobile);
    await page.screenshot({ path: path.join(OUT, "result-mobile.png"), fullPage: false });

    check("runtime-no-errors", errors.length === 0, errors);
  } finally {
    const report = {
      ok: checks.length > 0 && checks.every((entry) => entry.pass),
      url: BASE_URL,
      checks,
      errors,
      requestCount: requests.length,
      activeDesktop,
      activeMobile,
      customizerDesktop,
      customizerMobile,
      customizerLandscape,
      resultMobile,
      screenshots: [
        "launch-platform.png",
        "ocean-lights-night.png",
        "flight-desktop.png",
        "customizer-desktop.png",
        "flight-mobile.png",
        "customizer-mobile.png",
        "customizer-landscape.png",
        "result-desktop.png",
        "result-mobile.png"
      ]
    };
    await writeFile(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await browser.close();
    for (const entry of checks) console.log(`${entry.pass ? "PASS" : "FAIL"} ${entry.id}`);
    if (errors.length) console.log(errors.join("\n"));
    if (!report.ok) process.exitCode = 1;
  }
}

await main();
