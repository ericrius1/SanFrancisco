// Real-browser surfing acceptance probe.
//
// Boots the game in headless Chrome/WebGPU and verifies:
//   - no surfboard art or surfboard customizer chunk loads at boot,
//   - entering surf loads only the selected surface + optional selected decal,
//   - the live controller stays above the sampled water surface,
//   - pumping/carving produces automatic takeoffs and landings,
//   - a charged flow state activates with local rider slowdown,
//   - choosing one new surface requests one new image (not the whole catalog),
//   - the shaping room remains reachable on a phone viewport.
//
// Env: SF_PROBE_URL (default http://127.0.0.1:5241), SF_PROBE_OUT
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/surf-probe");
const PROFILE = path.join(process.env.TMPDIR ?? "/tmp", `sf-surf-probe-${Date.now()}`);
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5241";
const W = 1280;
const H = 800;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`HTTP timeout: ${url}`);
}

function findChrome() {
  for (const candidate of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (!candidate.includes("/") || existsSync(candidate)) return candidate;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}

class Cdp {
  #socket;
  #id = 1;
  #pending = new Map();
  errors = [];
  consoleErrors = [];
  requests = [];
  failedRequests = [];

  constructor(url) {
    this.#socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.#socket.addEventListener("open", resolve, { once: true });
      this.#socket.addEventListener("error", reject, { once: true });
    });
    this.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.method === "Runtime.exceptionThrown") {
        this.errors.push(
          message.params?.exceptionDetails?.exception?.description ??
          message.params?.exceptionDetails?.text ??
          "unknown runtime exception"
        );
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        this.consoleErrors.push(message.params.args?.map((arg) => arg.value ?? arg.description).join(" ") ?? "console.error");
      }
      if (message.method === "Network.requestWillBeSent") this.requests.push(message.params.request.url);
      if (message.method === "Network.loadingFailed") this.failedRequests.push(message.params.errorText ?? "request failed");
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
    });
  }

  send(method, params = {}) {
    const id = this.#id++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 45_000);
      this.#pending.set(id, { resolve, reject, method, timeout });
    });
  }

  close() {
    this.#socket.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(`evaluate: ${JSON.stringify(result.exceptionDetails).slice(0, 1200)}`);
  return result.result?.value;
}

async function waitEval(cdp, expression, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(cdp, expression)) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function capture(cdp, filename) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const buffer = Buffer.from(result.data, "base64");
  writeFileSync(path.join(OUT, filename), buffer);
  const stats = await sharp(buffer).stats();
  return {
    file: path.join(OUT, filename),
    entropy: Number(stats.entropy.toFixed(3)),
    channels: stats.channels.map((channel) => Number(channel.stdev.toFixed(2)))
  };
}

function surfImageRequests(urls) {
  return [...new Set(urls.filter((url) => /\/surfboards\/(textures|art|decals)\//.test(url)))];
}

function selectorRequests(urls) {
  return [...new Set(urls.filter((url) => /surfboardSelector[^/]*\.(?:js|ts)(?:\?|$)/.test(url)))];
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });
  await waitHttp(SERVER_URL, 90_000);

  const chromePort = await freePort();
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${PROFILE}`,
    "--headless=new",
    "--no-first-run",
    "--mute-audio",
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--use-angle=metal",
    "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
    `--window-size=${W},${H}`,
    "--force-device-scale-factor=1",
    "about:blank"
  ], { stdio: "ignore" });

  let cdp;
  const checks = [];
  const check = (pass, label, evidence) => {
    checks.push({ pass: Boolean(pass), label, evidence });
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}${evidence === undefined ? "" : ` — ${JSON.stringify(evidence)}`}`);
  };

  try {
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      try {
        await (await fetch(`http://127.0.0.1:${chromePort}/json/version`)).json();
        break;
      } catch {}
      await sleep(200);
    }
    const page = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1&profile=1` });
    await waitEval(cdp, "Boolean(window.__sf && window.__sf.player && window.__sf.renderIdle?.())", 150_000, "render-ready game");
    await sleep(1500);

    const bootImages = surfImageRequests(cdp.requests);
    const bootSelector = selectorRequests(cdp.requests);
    check(bootImages.length === 0, "boot loads zero surfboard images", bootImages);
    check(bootSelector.length === 0, "boot does not load the surfboard customizer chunk", bootSelector);

    const entered = await evaluate(cdp, `(()=>{
      const s=window.__sf,p=s.player;
      s.input.suspended=false;
      p.position.set(-6070,0,3370);
      p.renderPosition.copy(p.position);
      p.trySwitch('surf');
      s.input.keys.clear();
      s.input.keys.add('KeyW');
      return {mode:p.mode,config:s.getSurfboardConfig()};
    })()`);
    check(entered.mode === "surf", "player enters surfing through the real mode switch", entered);
    await waitEval(cdp, "Boolean(document.querySelector('.surfboard-toggle'))", 20_000, "lazy customizer UI");
    await sleep(1800);

    const firstImages = surfImageRequests(cdp.requests);
    const expectedFirst = 1 + (entered.config.decal === "none" ? 0 : 1);
    check(firstImages.length === expectedFirst, "surf entry loads only the selected surface and selected decal", firstImages);
    check(selectorRequests(cdp.requests).length === 1, "surf entry lazy-loads one customizer chunk", selectorRequests(cdp.requests));

    let minClearance = Infinity;
    let minPositionDelta = Infinity;
    let maxLaunchSerial = 0;
    let maxLandingSerial = 0;
    let maxSplashSerial = 0;
    let maxFlow = 0;
    let flowActivated = false;
    let flowRate = 1;
    let flowShot = null;
    let lastDirectionChange = 0;
    let direction = 1;
    const rideStarted = Date.now();
    while (Date.now() - rideStarted < 55_000) {
      const elapsed = Date.now() - rideStarted;
      if (elapsed - lastDirectionChange > 1700) {
        lastDirectionChange = elapsed;
        direction *= -1;
        await evaluate(cdp, `(()=>{const k=window.__sf.input.keys;k.delete('KeyA');k.delete('KeyD');k.add('${direction > 0 ? "KeyD" : "KeyA"}');})()`);
      }
      const state = await evaluate(cdp, `(()=>{const s=window.__sf,p=s.player,t=p.surfTelemetry;
        return {mode:p.mode,y:p.position.y,surface:t.surfaceY,clearance:t.clearance,phase:t.phase,
          launch:t.launchSerial,landing:t.landingSerial,splash:t.splashSerial,
          flow:t.flow,ready:t.flowReady,active:t.flowActive,rate:t.riderMotionRate,speed:t.speed};})()`);
      if (state.mode !== "surf") throw new Error(`Surf mode changed unexpectedly to ${state.mode}`);
      minClearance = Math.min(minClearance, state.clearance);
      minPositionDelta = Math.min(minPositionDelta, state.y - state.surface);
      maxLaunchSerial = Math.max(maxLaunchSerial, state.launch);
      maxLandingSerial = Math.max(maxLandingSerial, state.landing);
      maxSplashSerial = Math.max(maxSplashSerial, state.splash);
      maxFlow = Math.max(maxFlow, state.flow);

      if (state.ready && !flowActivated) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyX", key: "x", windowsVirtualKeyCode: 88 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyX", key: "x", windowsVirtualKeyCode: 88 });
      }
      if (state.active) {
        flowActivated = true;
        flowRate = Math.min(flowRate, state.rate);
        if (!flowShot) flowShot = await capture(cdp, "surf-flow-desktop.png");
      }
      if (maxLaunchSerial > 0 && maxLandingSerial > 0 && flowActivated) break;
      await sleep(180);
    }
    await evaluate(cdp, "window.__sf.input.keys.clear()");

    check(minClearance >= -0.001, "telemetry clearance never falls below the live surface", { minClearance });
    check(minPositionDelta >= -0.001, "player transform never falls below the live surface", { minPositionDelta });
    check(maxLaunchSerial > 0, "speed and lip energy trigger an automatic launch", { maxLaunchSerial });
    check(maxLandingSerial > 0, "automatic launch returns to a surfaced landing", { maxLandingSerial });
    check(maxSplashSerial > 0, "surfing emits launch/landing splash events", { maxSplashSerial });
    check(flowActivated && flowRate > 0 && flowRate < 1, "earned flow state applies local rider slow motion", { flowActivated, flowRate, maxFlow });
    if (flowShot) check(flowShot.entropy > 2 && flowShot.channels.some((value) => value > 15), "flow-state screenshot contains a nonblank rendered scene", flowShot);

    await evaluate(cdp, "document.querySelector('.surfboard-toggle')?.click()");
    await waitEval(cdp, "document.querySelector('.surfboard-ui')?.classList.contains('open')", 10_000, "open shaping room");
    const choice = await evaluate(cdp, `(()=>{
      const current=window.__sf.getSurfboardConfig().surface;
      const labels=['kelp ribbons','sunset caustics','fog topography','tidepool terrazzo','moon jelly dream','golden gate bloom','pacific postcard'];
      const buttons=[...document.querySelectorAll('.surfboard-panel .avatar-choice')];
      const button=buttons.find((item)=>labels.includes(item.textContent.trim()) && item.textContent.trim().replaceAll(' ','-')!==current);
      if(!button) return null;
      const label=button.textContent.trim();button.click();return label;
    })()`);
    check(Boolean(choice), "customizer exposes another selectable surface", choice);
    await sleep(1800);
    const afterChoiceImages = surfImageRequests(cdp.requests);
    check(afterChoiceImages.length === firstImages.length + 1, "choosing one surface lazy-loads exactly one new image", { before: firstImages, after: afterChoiceImages });

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(500);
    const mobile = await evaluate(cdp, `(()=>{const panel=document.querySelector('.surfboard-panel');const toggle=document.querySelector('.surfboard-toggle');
      if(!panel||!toggle)return null;const p=panel.getBoundingClientRect(),t=toggle.getBoundingClientRect(),cs=getComputedStyle(panel);
      const last=panel.querySelector('.avatar-random')||panel.lastElementChild;last?.scrollIntoView({block:'end'});
      const l=last?.getBoundingClientRect();
      return {viewport:[innerWidth,innerHeight],panel:{left:p.left,top:p.top,right:p.right,bottom:p.bottom,client:panel.clientHeight,scroll:panel.scrollHeight,overflowY:cs.overflowY},
        toggle:{left:t.left,top:t.top,right:t.right,bottom:t.bottom},lastReachable:!!l&&l.bottom<=innerHeight+2};})()`);
    const mobileShot = await capture(cdp, "surf-customizer-mobile.png");
    check(Boolean(mobile) && mobile.panel.left >= -1 && mobile.panel.right <= 391 && mobile.panel.top >= -1 && mobile.panel.bottom <= 845, "surfboard panel fits a phone viewport", mobile);
    check(Boolean(mobile) && (!mobile.panel.scroll || mobile.panel.client >= mobile.panel.scroll || /auto|scroll/.test(mobile.panel.overflowY)), "overflowing surfboard controls are scrollable", mobile?.panel);
    check(mobileShot.entropy > 2, "mobile customizer screenshot is nonblank", mobileShot);

    const renderer = await evaluate(cdp, `(()=>{const r=window.__sf.renderer;return {calls:r.info.render.calls,triangles:r.info.render.triangles,textures:r.info.memory?.textures??null};})()`);
    check(renderer.calls > 0 && renderer.triangles > 0, "WebGPU renderer remains live after the full test", renderer);
    check(cdp.errors.length === 0, "no uncaught runtime exceptions", [...new Set(cdp.errors)].slice(0, 6));
    check(cdp.failedRequests.length === 0, "no failed network requests", [...new Set(cdp.failedRequests)].slice(0, 6));

    const report = {
      url: `${SERVER_URL}/?autostart=1`,
      checks,
      bootImages,
      firstImages,
      afterChoiceImages,
      selectorRequests: selectorRequests(cdp.requests),
      runtimeErrors: cdp.errors,
      consoleErrors: cdp.consoleErrors,
      failedRequests: cdp.failedRequests
    };
    writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
    const failures = checks.filter((entry) => !entry.pass);
    console.log(`\n${failures.length ? "SURF PROBE FAILED" : "SURF PROBE PASSED"}: ${checks.length - failures.length}/${checks.length}`);
    if (failures.length) process.exitCode = 1;
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
    rmSync(PROFILE, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
