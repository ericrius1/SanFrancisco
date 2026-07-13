// Real-browser arcade-surf acceptance probe.
//
// Boots Ocean Beach in headless Chrome/WebGPU and verifies the player-facing
// contract rather than reaching into Player.trySwitch():
//   - clean boot requests no surf runtime, customizer, or optional board art,
//   - keyboard E starts an already-standing, already-moving surf session,
//   - neutral input survives a deterministic endless-wave run,
//   - mouse and right-stick look cannot move the authored surf camera,
//   - keyboard E and gamepad B exit onto sand without abandoning a board,
//   - standard-gamepad LS/triggers/A map to carve/pump/stall/Flow,
//   - the shaping room and each cosmetic image remain first-use lazy,
//   - desktop active play and the mobile shaping panel render nonblank.
//
// Env: SF_PROBE_URL (default http://127.0.0.1:5241), SF_PROBE_OUT,
//      SF_PROBE_ENDURANCE_SECONDS (default 30, minimum 12).
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/surf-probe");
const PROFILE = path.join(process.env.TMPDIR ?? "/tmp", `sf-surf-probe-${Date.now()}`);
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5241";
const ENDURANCE_SECONDS = Math.max(
  12,
  Math.min(120, Number(process.env.SF_PROBE_ENDURANCE_SECONDS) || 30)
);
const W = 1280;
const H = 800;
const DT = 1 / 60;
const ENDURANCE_BATCH_FRAMES = 180;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pin one explicit cosmetic choice in the probe's disposable Chrome profile.
// This prevents a multiplayer welcome racing the activation gate and gives the
// request-waterfall assertion one exact selected surface and no decal.
const PROBE_SURFBOARD = {
  shape: "shortboard",
  base: 0,
  rail: 1,
  accent: 2,
  baseHex: null,
  railHex: null,
  accentHex: null,
  surface: "kelp-ribbons",
  textureZoom: 46,
  textureRotation: 50,
  textureOffsetX: 50,
  textureOffsetY: 50,
  surfaceMotion: 20,
  surfaceShimmer: 34,
  decal: "none",
  decalScale: 44,
  decalRotation: 50,
  decalX: 50,
  decalY: 35
};

function discoverBuiltSurfChunks() {
  const assets = path.join(ROOT, "dist", "assets");
  const names = new Set();
  if (!existsSync(assets)) return names;
  for (const name of readdirSync(assets)) {
    if (!name.endsWith(".js")) continue;
    try {
      const source = readFileSync(path.join(assets, name), "utf8");
      if (source.includes("ALREADY RIDING") && source.includes("NEXT CLEAN WAVE")) names.add(name);
    } catch {}
  }
  return names;
}

const BUILT_SURF_CHUNKS = discoverBuiltSurfChunks();

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

async function waitUntil(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
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
        this.consoleErrors.push(
          message.params.args?.map((arg) => arg.value ?? arg.description).join(" ") ?? "console.error"
        );
      }
      if (message.method === "Network.requestWillBeSent") this.requests.push(message.params.request.url);
      if (message.method === "Network.loadingFailed") {
        this.failedRequests.push(message.params.errorText ?? "request failed");
      }
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
  if (result.exceptionDetails) {
    throw new Error(`evaluate: ${JSON.stringify(result.exceptionDetails).slice(0, 1200)}`);
  }
  return result.result?.value;
}

async function waitEval(cdp, expression, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(cdp, expression)) return;
    } catch {}
    await sleep(200);
  }
  let pageState = null;
  try {
    pageState = await evaluate(cdp, `({
      title:document.title,
      bodyClass:document.body?.className??'',
      hasHooks:Boolean(window.__sf),
      renderIdle:window.__sf?.renderIdle?.()??null,
      loadingText:document.querySelector('#loading')?.textContent?.trim().slice(0,240)??null
    })`);
  } catch {}
  throw new Error(
    `Timed out waiting for ${label}; page=${JSON.stringify(pageState)}; ` +
    `runtime=${JSON.stringify(cdp.errors.slice(-4))}; console=${JSON.stringify(cdp.consoleErrors.slice(-4))}`
  );
}

async function capture(cdp, filename) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });
  const buffer = Buffer.from(result.data, "base64");
  writeFileSync(path.join(OUT, filename), buffer);
  const image = sharp(buffer);
  const [stats, metadata] = await Promise.all([image.stats(), image.metadata()]);
  return {
    file: path.join(OUT, filename),
    width: metadata.width,
    height: metadata.height,
    entropy: Number(stats.entropy.toFixed(3)),
    channels: stats.channels.map((channel) => Number(channel.stdev.toFixed(2)))
  };
}

async function renderCurrentFrame(cdp) {
  await evaluate(cdp, `(async()=>{const s=window.__sf;
    s.chase.update(0,s.player,s.input);
    s.pipeline.render();
    await s.renderer.backend.device.queue.onSubmittedWorkDone();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return true;})()`);
}

function uniqueMatching(urls, predicate) {
  return [...new Set(urls.filter(predicate))];
}

function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0];
  }
}

function surfImageRequests(urls) {
  return uniqueMatching(urls, (url) => /\/surfboards\/(textures|art|decals)\//.test(pathnameOf(url)));
}

function selectorRequests(urls) {
  return uniqueMatching(urls, (url) => /surfboardSelector[^/]*\.(?:js|ts)$/.test(pathnameOf(url)));
}

function surfRuntimeRequests(urls) {
  return uniqueMatching(urls, (url) => {
    const pathname = pathnameOf(url);
    const basename = path.basename(pathname);
    return (
      /\/src\/gameplay\/surfing\/(?:index|game|waves)\.(?:js|ts)$/.test(pathname) ||
      BUILT_SURF_CHUNKS.has(basename)
    );
  });
}

function moduleRequests(urls) {
  return uniqueMatching(urls, (url) => /\.(?:js|ts)$/.test(pathnameOf(url)));
}

async function pressKey(cdp, code, key, windowsVirtualKeyCode) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    code,
    key,
    windowsVirtualKeyCode
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code,
    key,
    windowsVirtualKeyCode
  });
}

async function tickFrames(cdp, frames, dt = DT) {
  return evaluate(cdp, `(()=>{
    const s=window.__sf;
    for(let i=0;i<${Math.max(0, Math.floor(frames))};i++)s.tick(${Number(dt)});
    const t=s.player.surfTelemetry;
    return {mode:s.player.mode,phase:t.phase,grounded:t.grounded,airborne:t.airborne,
      speed:t.speed,flow:t.flow,flowReady:t.flowReady,flowActive:t.flowActive,
      flowSerial:t.flowSerial,riderMotionRate:t.riderMotionRate,waveSerial:t.waveSerial};
  })()`);
}

async function setProbePad(cdp, { axes = [0, 0, 0, 0], buttons = {} } = {}) {
  return evaluate(cdp, `(()=>{
    const pad=window.__sfProbePad;
    if(!pad)return false;
    pad.axes.splice(0,pad.axes.length,...${JSON.stringify(axes)});
    for(let i=0;i<pad.buttons.length;i++){
      const value=Number((${JSON.stringify(buttons)})[i]??0);
      pad.buttons[i].value=value;
      pad.buttons[i].pressed=value>0.5;
      pad.buttons[i].touched=value>0;
    }
    pad.timestamp=performance.now();
    return true;
  })()`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });
  await waitHttp(SERVER_URL, 90_000);
  const serverHtml = await (await fetch(SERVER_URL, { cache: "no-store" })).text();
  const viteDev = serverHtml.includes("/@vite/client");
  // DEV already exposes __sf; adding profile there forces the massive app to
  // compile every retained render variant before renderIdle. Production hides
  // hooks unless profile is explicit, so keep it on for the packaged preview.
  const pageUrl = `${SERVER_URL}/?autostart=1&fullfps=1&spawn=oceanBeach${viteDev ? "" : "&profile=1"}`;

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
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${label}${evidence === undefined ? "" : ` — ${JSON.stringify(evidence)}`}`
    );
  };

  let bootImages = [];
  let bootRuntime = [];
  let bootSelector = [];
  let activationImages = [];
  let activationRuntime = [];
  let activationModules = [];
  let selectorModules = [];
  let afterChoiceImages = [];
  let entryShot = null;
  let desktopShot = null;
  let mobileShot = null;

  try {
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      try {
        await (await fetch(`http://127.0.0.1:${chromePort}/json/version`)).json();
        break;
      } catch {}
      await sleep(200);
    }
    const page = await (
      await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: "PUT" })
    ).json();
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try{localStorage.setItem("sf-surfboard-v1",${JSON.stringify(JSON.stringify(PROBE_SURFBOARD))})}catch{}`
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: W,
      height: H,
      deviceScaleFactor: 1,
      mobile: false
    });
    await cdp.send("Page.navigate", { url: pageUrl });
    // Gameplay/input is live once the started shell and debug hooks exist. The
    // massive app's retained render-variant warmup can legitimately outlast the
    // old 150 s gate, so functional assertions must not be blocked behind it;
    // screenshots below submit and await one explicit current-state frame.
    await waitEval(
      cdp,
      "Boolean(document.body.classList.contains('started') && window.__sf?.player)",
      180_000,
      "started Ocean Beach"
    );
    // The feature probe is not a render-variant warmup benchmark. Once the
    // covered boot warmup has completed and the playable shell is started,
    // replace only the deferred second pass so it cannot monopolize tick() for
    // minutes on a headless GPU. The first live frame will mark modules ready.
    const warmupBypassed = await evaluate(cdp, `(()=>{const s=window.__sf;
      if(s.renderIdle?.())return false;
      s.pipeline.warmup=async()=>{};
      return true;})()`);
    await waitEval(cdp, "window.__sf.renderIdle?.()===true", 25_000, "playable frame loop");
    await sleep(1200);

    const bootState = await evaluate(cdp, `(()=>{const s=window.__sf,p=s.player;
      return {mode:p.mode,isWater:s.map.isWater(p.position.x,p.position.z),
        oceanBeachWaves:s.oceanBeachWaves===null,surfExperience:s.surfExperience===null,
        surfHudAbsent:!document.querySelector('.surf-hud'),
        launcherHidden:document.querySelector('.surfboard-launcher-ui')?.hidden===true,
        config:s.getSurfboardConfig()};})()`);
    bootImages = surfImageRequests(cdp.requests);
    bootRuntime = surfRuntimeRequests(cdp.requests);
    bootSelector = selectorRequests(cdp.requests);
    check(bootState.mode === "walk", "Ocean Beach boots outside the minigame", bootState);
    check(
      bootState.oceanBeachWaves && bootState.surfExperience && bootState.surfHudAbsent,
      "surf runtime hooks and HUD are null before first activation",
      bootState
    );
    check(bootImages.length === 0, "clean boot requests zero optional surfboard images", bootImages);
    check(bootRuntime.length === 0, "clean boot requests zero surfing runtime chunks", bootRuntime);
    check(bootSelector.length === 0, "clean boot requests zero shaping-room chunks", bootSelector);

    // Player-facing activation: no direct position write and no trySwitch call.
    const activationRequestStart = cdp.requests.length;
    await pressKey(cdp, "KeyE", "e", 69);
    await waitEval(
      cdp,
      `(()=>{const s=window.__sf,t=s.player.surfTelemetry;
        return s.player.mode==='surf'&&t.phase==='ride'&&t.grounded&&!t.airborne&&t.speed>7;})()`,
      12_000,
      "keyboard-E immediate ride"
    );
    await waitEval(
      cdp,
      "Boolean(window.__sf.oceanBeachWaves && window.__sf.surfExperience)",
      20_000,
      "lazy surf runtime"
    );
    await waitUntil(
      () => surfImageRequests(cdp.requests.slice(activationRequestStart)).length >= 1,
      10_000,
      "selected surfboard image"
    );
    await sleep(300);
    entryShot = await capture(cdp, "surf-entry-desktop.png");

    const activationUrls = cdp.requests.slice(activationRequestStart);
    activationImages = surfImageRequests(activationUrls);
    activationRuntime = surfRuntimeRequests(activationUrls);
    activationModules = moduleRequests(activationUrls).filter(
      (url) => !selectorRequests([url]).length
    );
    const entered = await evaluate(cdp, `(()=>{const s=window.__sf,p=s.player,t=p.surfTelemetry;
      return {mode:p.mode,phase:t.phase,grounded:t.grounded,airborne:t.airborne,speed:t.speed,
        clearance:t.clearance,waveSerial:t.waveSerial,assistSerial:t.assistSerial,
        camera:s.chase.surfCameraDiagnostics(),cameraLookLocked:s.input.cameraLookLocked,
        runtime:Boolean(s.oceanBeachWaves&&s.surfExperience),
        hudActive:s.surfExperience?.debugState.active??false,
        launcherVisible:document.querySelector('.surfboard-launcher-ui')?.hidden===false,
        config:s.getSurfboardConfig()};})()`);
    check(
      entered.mode === "surf" && entered.phase === "ride" && entered.grounded &&
        !entered.airborne && entered.speed > 7,
      "real keyboard E starts standing, grounded, and already moving",
      entered
    );
    check(
      entered.runtime && entered.hudActive && entered.launcherVisible,
      "surf runtime appears only after activation",
      entered
    );
    check(
      activationRuntime.length > 0 || activationModules.length > 0,
      "activation requests a separate surfing runtime module",
      { matchedRuntime: activationRuntime, activationModules }
    );
    check(
      selectorRequests(activationUrls).length === 0,
      "surf activation does not request the shaping-room chunk",
      selectorRequests(activationUrls)
    );
    const expectedActivationImages = 1 + (entered.config.decal === "none" ? 0 : 1);
    check(
      activationImages.length === expectedActivationImages &&
        activationImages.every((url) =>
          url.includes(`/${entered.config.surface}.png`) ||
          (entered.config.decal !== "none" && url.includes(`/${entered.config.decal}.png`))
        ),
      "activation requests only the selected surface and selected decal",
      { expected: expectedActivationImages, config: entered.config, requests: activationImages }
    );

    await evaluate(cdp, "window.__sfManual(true)");
    await sleep(100);
    await evaluate(cdp, "window.__sf.input.keys.clear();window.__sf.input.endFrame()");

    const mouseLock = await evaluate(cdp, `(()=>{const s=window.__sf,i=s.input;
      const originalLocked=i.locked;i.locked=true;i.mouseDX=0;i.mouseDY=0;
      const event=new MouseEvent('mousemove',{bubbles:true,clientX:400,clientY:300});
      try{Object.defineProperties(event,{movementX:{value:900},movementY:{value:-700}})}catch{}
      window.dispatchEvent(event);
      const mouseEventDelta={x:i.mouseDX,y:i.mouseDY};
      const before=s.chase.surfCameraDiagnostics();
      i.mouseDX=800;i.mouseDY=-600;i.wheel=1400;
      s.chase.update(0,s.player,i);
      const after=s.chase.surfCameraDiagnostics();
      const values=[
        before.viewYaw-after.viewYaw,before.viewPitch-after.viewPitch,before.fov-after.fov,
        before.position.x-after.position.x,before.position.y-after.position.y,before.position.z-after.position.z,
        before.target.x-after.target.x,before.target.y-after.target.y,before.target.z-after.target.z
      ];
      i.locked=originalLocked;i.endFrame();
      return {cameraLookLocked:i.cameraLookLocked,mouseEventDelta,maxCameraDelta:Math.max(...values.map(Math.abs)),before,after};
    })()`);
    check(
      mouseLock.cameraLookLocked && mouseLock.mouseEventDelta.x === 0 &&
        mouseLock.mouseEventDelta.y === 0 && mouseLock.maxCameraDelta < 1e-6,
      "mouse motion and injected orbit deltas cannot swivel the surf camera",
      mouseLock
    );

    const enduranceFrames = Math.ceil(ENDURANCE_SECONDS / DT);
    let framesRemaining = enduranceFrames;
    const endurance = {
      seconds: enduranceFrames * DT,
      frames: 0,
      phases: new Set(),
      modeStable: true,
      forbiddenState: false,
      minClearance: Infinity,
      minSpeed: Infinity,
      minCameraShoreClearance: Infinity,
      minCameraWaterClearance: Infinity,
      cameraInitialized: true,
      maxWaveSerial: 0,
      maxAssistSerial: 0,
      maxLaunchSerial: 0,
      maxLandingSerial: 0,
      maxFlow: 0
    };
    while (framesRemaining > 0) {
      const frames = Math.min(ENDURANCE_BATCH_FRAMES, framesRemaining);
      const batch = await evaluate(cdp, `(()=>{const s=window.__sf,p=s.player;
        let minClearance=Infinity,minSpeed=Infinity,minShore=Infinity,minWater=Infinity;
        let modeStable=true,forbiddenState=false,cameraInitialized=true;
        let maxWaveSerial=0,maxAssistSerial=0,maxLaunchSerial=0,maxLandingSerial=0,maxFlow=0;
        const phases=new Set();
        for(let frame=0;frame<${frames};frame++){
          s.tick(${DT});
          const t=p.surfTelemetry,c=s.chase.surfCameraDiagnostics();
          phases.add(t.phase);
          modeStable&&=p.mode==='surf';
          forbiddenState||=t.phase==='paddle'||t.phase==='wipeout'||('wipeoutSerial' in t)||('beached' in t);
          minClearance=Math.min(minClearance,t.clearance);
          minSpeed=Math.min(minSpeed,t.speed);
          cameraInitialized&&=c.initialized;
          minShore=Math.min(minShore,c.position.x-p.renderPosition.x);
          minWater=Math.min(minWater,c.waterClearance);
          maxWaveSerial=Math.max(maxWaveSerial,t.waveSerial);
          maxAssistSerial=Math.max(maxAssistSerial,t.assistSerial);
          maxLaunchSerial=Math.max(maxLaunchSerial,t.launchSerial);
          maxLandingSerial=Math.max(maxLandingSerial,t.landingSerial);
          maxFlow=Math.max(maxFlow,t.flow);
        }
        return {phases:[...phases],modeStable,forbiddenState,minClearance,minSpeed,
          minShore,minWater,cameraInitialized,maxWaveSerial,maxAssistSerial,
          maxLaunchSerial,maxLandingSerial,maxFlow};})()`);
      endurance.frames += frames;
      framesRemaining -= frames;
      for (const phase of batch.phases) endurance.phases.add(phase);
      endurance.modeStable &&= batch.modeStable;
      endurance.forbiddenState ||= batch.forbiddenState;
      endurance.minClearance = Math.min(endurance.minClearance, batch.minClearance);
      endurance.minSpeed = Math.min(endurance.minSpeed, batch.minSpeed);
      endurance.minCameraShoreClearance = Math.min(
        endurance.minCameraShoreClearance,
        batch.minShore
      );
      endurance.minCameraWaterClearance = Math.min(
        endurance.minCameraWaterClearance,
        batch.minWater
      );
      endurance.cameraInitialized &&= batch.cameraInitialized;
      endurance.maxWaveSerial = Math.max(endurance.maxWaveSerial, batch.maxWaveSerial);
      endurance.maxAssistSerial = Math.max(endurance.maxAssistSerial, batch.maxAssistSerial);
      endurance.maxLaunchSerial = Math.max(endurance.maxLaunchSerial, batch.maxLaunchSerial);
      endurance.maxLandingSerial = Math.max(endurance.maxLandingSerial, batch.maxLandingSerial);
      endurance.maxFlow = Math.max(endurance.maxFlow, batch.maxFlow);
      await sleep(30);
    }
    const enduranceEvidence = { ...endurance, phases: [...endurance.phases] };
    check(
      endurance.modeStable && !endurance.forbiddenState &&
        [...endurance.phases].every((phase) => ["ride", "air", "recover"].includes(phase)),
      "neutral input remains in the endless ride/air/auto-save loop with no paddle or wipeout",
      enduranceEvidence
    );
    check(
      endurance.minClearance >= -0.001 && endurance.minSpeed >= 5,
      "neutral surfing never sinks or stalls to a failure state",
      { minClearance: endurance.minClearance, minSpeed: endurance.minSpeed }
    );
    check(
      endurance.cameraInitialized && endurance.minCameraShoreClearance >= 0.74 &&
        endurance.minCameraWaterClearance >= 0.49,
      "authored camera stays shore-side and above the live water",
      {
        initialized: endurance.cameraInitialized,
        minShoreClearance: endurance.minCameraShoreClearance,
        minWaterClearance: endurance.minCameraWaterClearance
      }
    );
    check(
      endurance.maxWaveSerial > 0,
      "neutral endurance advances automatically to a clean next wave",
      { maxWaveSerial: endurance.maxWaveSerial, seconds: endurance.seconds }
    );

    // Manual endurance advances simulation time much faster than wall time.
    // Let the short CSS whitewater handoff finish before judging the stable view.
    await sleep(700);
    await renderCurrentFrame(cdp);
    desktopShot = await capture(cdp, "surf-arcade-desktop.png");
    check(
      desktopShot.entropy > 2 && desktopShot.channels.some((value) => value > 15),
      "active-surf desktop screenshot is nonblank and visually varied",
      desktopShot
    );

    // Keyboard exit/re-entry must use the same E path the player sees.
    const keyboardExitCount = await evaluate(cdp, "window.__sf.abandonedMounts.count");
    await pressKey(cdp, "KeyE", "e", 69);
    await tickFrames(cdp, 3);
    const keyboardExit = await evaluate(cdp, `(()=>{const s=window.__sf,p=s.player;
      return {mode:p.mode,x:p.position.x,y:p.position.y,z:p.position.z,
        onWater:s.map.isWater(p.position.x,p.position.z),abandoned:s.abandonedMounts.count,
        wavesDisposed:s.oceanBeachWaves===null};})()`);
    check(
      keyboardExit.mode === "walk" && !keyboardExit.onWater &&
        keyboardExit.abandoned === keyboardExitCount && keyboardExit.wavesDisposed,
      "keyboard E exits atomically onto dry beach with no abandoned surfboard",
      { beforeAbandoned: keyboardExitCount, ...keyboardExit }
    );
    await pressKey(cdp, "KeyE", "e", 69);
    await tickFrames(cdp, 1); // consume the edge; camera readiness resolves asynchronously
    await waitEval(cdp, "window.__sf.player.mode==='surf'", 5000,
      "keyboard surf re-entry");
    const keyboardReentry = await tickFrames(cdp, 4);
    check(
      keyboardReentry.mode === "surf" && keyboardReentry.phase === "ride" &&
        keyboardReentry.grounded && keyboardReentry.speed > 7,
      "keyboard E re-entry immediately resumes a moving ride",
      keyboardReentry
    );

    // Install one mutable standard-mapping pad in the disposable browser. The
    // app still owns polling and maps it through the same Input path as hardware.
    const padInstalled = await evaluate(cdp, `(()=>{
      const button=()=>({pressed:false,touched:false,value:0});
      window.__sfProbePad={id:'SF acceptance pad',index:0,connected:true,mapping:'standard',
        timestamp:performance.now(),axes:[0,0,0,0],buttons:Array.from({length:17},button)};
      try{Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[window.__sfProbePad]})}
      catch{return false}
      return navigator.getGamepads()[0]===window.__sfProbePad;
    })()`);
    check(padInstalled, "synthetic standard gamepad is visible to the real Input poller", padInstalled);

    // Right stick: poll directly before endFrame clears deltas, then ask the
    // surf camera to update with dt=0 at the same rider pose.
    await evaluate(cdp, `(()=>{const s=window.__sf;
      s.chase.update(0,s.player,s.input);return s.player.mode;})()`);
    await setProbePad(cdp, { axes: [0, 0, 0.95, -0.9] });
    const padLookLock = await evaluate(cdp, `(()=>{const s=window.__sf,i=s.input;
      i.mouseDX=0;i.mouseDY=0;
      const before=s.chase.surfCameraDiagnostics();
      i.pollPad(${DT});
      const deltas={x:i.mouseDX,y:i.mouseDY};
      s.chase.update(0,s.player,i);
      const after=s.chase.surfCameraDiagnostics();
      const values=[before.viewYaw-after.viewYaw,before.viewPitch-after.viewPitch,
        before.position.x-after.position.x,before.position.y-after.position.y,before.position.z-after.position.z,
        before.target.x-after.target.x,before.target.y-after.target.y,before.target.z-after.target.z];
      i.endFrame();
      return {cameraLookLocked:i.cameraLookLocked,deltas,maxCameraDelta:Math.max(...values.map(Math.abs))};
    })()`);
    check(
      padLookLock.cameraLookLocked && padLookLock.deltas.x === 0 &&
        padLookLock.deltas.y === 0 && padLookLock.maxCameraDelta < 1e-6,
      "gamepad right stick cannot orbit the authored surf camera",
      padLookLock
    );

    // LS + RT: carve and pump through standard analog axes.
    await setProbePad(cdp, { axes: [0.85, 0, 0, 0], buttons: { 7: 1 } });
    await tickFrames(cdp, 90);
    const padPump = await evaluate(cdp, `(()=>{const s=window.__sf,t=s.player.surfTelemetry;
      return {connected:s.input.padConnected,device:s.input.device,
        steerAxis:s.input.axis('KeyA','KeyD'),throttleAxis:s.input.axis('KeyS','KeyW'),
        lean:t.lean,pump:t.pump,speed:t.speed,phase:t.phase};})()`);
    check(
      padPump.connected && padPump.device === "pad" && padPump.steerAxis > 0.6 &&
        padPump.throttleAxis > 0.8 && Math.abs(padPump.lean) > 0.08 && padPump.pump > 0.35,
      "standard-gamepad left stick carves and RT pumps",
      padPump
    );

    // Settle any automatic air first; holding LT then prevents a new launch.
    await setProbePad(cdp);
    await evaluate(cdp, `(()=>{const s=window.__sf;for(let i=0;i<300&&s.player.surfTelemetry.phase==='air';i++)s.tick(${DT});return true})()`);
    await setProbePad(cdp, { buttons: { 6: 1 } });
    await tickFrames(cdp, 120);
    const padStall = await evaluate(cdp, `(()=>{const s=window.__sf,t=s.player.surfTelemetry;
      return {throttleAxis:s.input.axis('KeyS','KeyW'),stalling:t.stalling,speed:t.speed,
        phase:t.phase,pump:t.pump};})()`);
    check(
      padStall.throttleAxis < -0.8 && (padStall.stalling || padStall.speed < padPump.speed - 2),
      "standard-gamepad LT stalls without stopping the ride",
      { pumpState: padPump, stallState: padStall }
    );

    // Earn the remaining meter with RT if neutral endurance did not quite fill
    // it, then press physical A (standard button 0 => logical Space) for Flow.
    await setProbePad(cdp, { buttons: { 7: 1 } });
    const flowCharge = await evaluate(cdp, `(()=>{const s=window.__sf;
      for(let i=0;i<900&&!s.player.surfTelemetry.flowReady;i++)s.tick(${DT});
      const t=s.player.surfTelemetry;return {ready:t.flowReady,flow:t.flow,serial:t.flowSerial};})()`);
    await setProbePad(cdp);
    await tickFrames(cdp, 2);
    const flowSerialBefore = await evaluate(cdp, "window.__sf.player.surfTelemetry.flowSerial");
    await setProbePad(cdp, { buttons: { 0: 1 } });
    await tickFrames(cdp, 2);
    await setProbePad(cdp);
    const padFlow = await tickFrames(cdp, 2);
    check(
      flowCharge.ready && padFlow.flowSerial > flowSerialBefore && padFlow.flowActive &&
        padFlow.riderMotionRate > 0 && padFlow.riderMotionRate < 1,
      "standard-gamepad A spends a ready meter on Flow",
      { flowCharge, flowSerialBefore, padFlow }
    );

    // Physical B maps to the exact E exit action; release and press it again to
    // prove the full controller-only leave/retry loop.
    const padExitCount = await evaluate(cdp, "window.__sf.abandonedMounts.count");
    await setProbePad(cdp, { buttons: { 1: 1 } });
    await tickFrames(cdp, 2);
    await setProbePad(cdp);
    await tickFrames(cdp, 2);
    const padExit = await evaluate(cdp, `(()=>{const s=window.__sf,p=s.player;
      return {mode:p.mode,onWater:s.map.isWater(p.position.x,p.position.z),
        abandoned:s.abandonedMounts.count,x:p.position.x,z:p.position.z};})()`);
    check(
      padExit.mode === "walk" && !padExit.onWater && padExit.abandoned === padExitCount,
      "standard-gamepad B exits onto the beach without abandoning the board",
      { beforeAbandoned: padExitCount, ...padExit }
    );
    await setProbePad(cdp, { buttons: { 1: 1 } });
    await tickFrames(cdp, 1); // poll B and consume its synthetic KeyE edge
    await waitEval(cdp, "window.__sf.player.mode==='surf'", 5000,
      "gamepad surf re-entry");
    await setProbePad(cdp);
    const padReentry = await tickFrames(cdp, 2);
    check(
      padReentry.mode === "surf" && padReentry.phase === "ride" &&
        padReentry.grounded && padReentry.speed > 7,
      "standard-gamepad B re-entry immediately resumes surfing",
      padReentry
    );

    // Customizer remains absent through both keyboard and pad surf sessions.
    check(
      selectorRequests(cdp.requests).length === 0,
      "shaping-room code remains absent until its launcher is clicked",
      selectorRequests(cdp.requests)
    );
    const selectorRequestStart = cdp.requests.length;
    const launcherClicked = await evaluate(cdp, `(()=>{const button=document.querySelector('.surfboard-launcher-ui .surfboard-toggle');
      if(!button||button.closest('.surfboard-launcher-ui')?.hidden)return false;button.click();return true})()`);
    check(launcherClicked, "surf launcher accepts the explicit shaping-room click", launcherClicked);
    await waitEval(
      cdp,
      "Boolean(document.querySelector('.surfboard-ui.open .surfboard-panel'))",
      15_000,
      "open shaping room"
    );
    await sleep(400);
    selectorModules = selectorRequests(cdp.requests.slice(selectorRequestStart));
    check(
      selectorModules.length === 1,
      "one shaping-room chunk loads on first click",
      selectorModules
    );
    const imagesBeforeChoice = surfImageRequests(cdp.requests);
    check(
      imagesBeforeChoice.length === activationImages.length,
      "opening the shaping room does not fetch a cosmetic catalog",
      imagesBeforeChoice
    );
    const choice = await evaluate(cdp, `(()=>{const current=window.__sf.getSurfboardConfig().surface;
      const labels=['kelp ribbons','sunset caustics','fog topography','tidepool terrazzo',
        'moon jelly dream','golden gate bloom','pacific postcard'];
      const button=[...document.querySelectorAll('.surfboard-panel .avatar-choice')]
        .find((item)=>labels.includes(item.textContent.trim())&&item.textContent.trim().replaceAll(' ','-')!==current);
      if(!button)return null;const label=button.textContent.trim();button.click();return {from:current,to:label};})()`);
    check(Boolean(choice), "shaping room exposes another selectable surface", choice);
    await waitUntil(
      () => surfImageRequests(cdp.requests).length >= imagesBeforeChoice.length + 1,
      10_000,
      "one newly selected surface"
    );
    await sleep(300);
    afterChoiceImages = surfImageRequests(cdp.requests);
    check(
      afterChoiceImages.length === imagesBeforeChoice.length + 1,
      "choosing one surface requests exactly one new image",
      { before: imagesBeforeChoice, after: afterChoiceImages }
    );

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true
    });
    await tickFrames(cdp, 2);
    await sleep(300);
    const mobile = await evaluate(cdp, `(()=>{const panel=document.querySelector('.surfboard-ui.open .surfboard-panel');
      const toggle=document.querySelector('.surfboard-ui.open .surfboard-toggle');
      if(!panel||!toggle)return null;
      const p=panel.getBoundingClientRect(),t=toggle.getBoundingClientRect(),cs=getComputedStyle(panel);
      const last=panel.querySelector('.avatar-random')||panel.lastElementChild;
      last?.scrollIntoView({block:'end'});const l=last?.getBoundingClientRect();
      return {viewport:[innerWidth,innerHeight],
        panel:{left:p.left,top:p.top,right:p.right,bottom:p.bottom,clientHeight:panel.clientHeight,
          scrollHeight:panel.scrollHeight,overflowY:cs.overflowY},
        toggle:{left:t.left,top:t.top,right:t.right,bottom:t.bottom,width:t.width,height:t.height},
        lastReachable:!!l&&l.bottom<=innerHeight+2};})()`);
    await renderCurrentFrame(cdp);
    mobileShot = await capture(cdp, "surf-customizer-mobile.png");
    check(
      Boolean(mobile) && mobile.panel.left >= -1 && mobile.panel.right <= 391 &&
        mobile.panel.top >= -1 && mobile.panel.bottom <= 845,
      "surfboard panel fits a phone viewport",
      mobile
    );
    check(
      Boolean(mobile) &&
        (mobile.panel.clientHeight >= mobile.panel.scrollHeight || /auto|scroll/.test(mobile.panel.overflowY)) &&
        mobile.lastReachable,
      "overflowing mobile shaping controls remain scrollable and reachable",
      mobile?.panel
    );
    check(
      mobileShot.entropy > 2 && mobileShot.channels.some((value) => value > 10),
      "mobile shaping-room screenshot is nonblank",
      mobileShot
    );

    const renderer = await evaluate(cdp, `(()=>{const r=window.__sf.renderer,c=r.domElement;
      return {calls:r.info.render.calls,triangles:r.info.render.triangles,
        textures:r.info.memory?.textures??null,canvas:[c.clientWidth,c.clientHeight,c.width,c.height]};})()`);
    check(
      renderer.calls > 0 && renderer.canvas.every((value) => value > 0),
      "WebGPU renderer and drawing buffer remain live after the full loop",
      renderer
    );
    check(
      cdp.errors.length === 0,
      "no uncaught runtime exceptions",
      [...new Set(cdp.errors)].slice(0, 8)
    );
    check(
      cdp.consoleErrors.length === 0,
      "no console.error output",
      [...new Set(cdp.consoleErrors)].slice(0, 8)
    );
    check(
      cdp.failedRequests.length === 0,
      "no failed network requests",
      [...new Set(cdp.failedRequests)].slice(0, 8)
    );

    const report = {
      url: pageUrl,
      viteDev,
      warmupBypassed,
      enduranceSeconds: ENDURANCE_SECONDS,
      builtSurfChunks: [...BUILT_SURF_CHUNKS],
      checks,
      bootImages,
      bootRuntime,
      bootSelector,
      activationImages,
      activationRuntime,
      activationModules,
      selectorModules,
      afterChoiceImages,
      screenshots: { entry: entryShot, desktop: desktopShot, mobile: mobileShot },
      runtimeErrors: cdp.errors,
      consoleErrors: cdp.consoleErrors,
      failedRequests: cdp.failedRequests
    };
    writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
    const failures = checks.filter((entry) => !entry.pass);
    console.log(
      `\n${failures.length ? "SURF PROBE FAILED" : "SURF PROBE PASSED"}: ${checks.length - failures.length}/${checks.length}`
    );
    if (failures.length) process.exitCode = 1;
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
    await sleep(350);
    try {
      rmSync(PROFILE, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 });
    } catch {}
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
