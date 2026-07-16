// End-to-end verification for the Buena Vista Afterlight quest.
//
// The probe starts an isolated strict-port Vite + relay pair unless
// SF_PROBE_URL points at an existing server. It uses raw CDP (no browser
// package dependency), enters through a real invite URL, waits for the late
// WebGPU warmup, and then drives the public Afterlight gameplay hooks.
//
//   node tools/afterlight-probe.mjs
//   SF_PROBE_URL=http://127.0.0.1:5173 node tools/afterlight-probe.mjs
//
// Env:
//   SF_PROBE_URL     existing app origin; otherwise a fresh free port is used
//   SF_PROBE_OUT     artifact directory (default .data/afterlight-probe)
//   SF_PROBE_WIDTH   viewport width (default 1600)
//   SF_PROBE_HEIGHT  viewport height (default 900)
//   SF_TIME          fixed time of day (default 18.7)
//   CHROME_BIN       Chrome/Chromium executable override

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, mkdirSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/afterlight-probe");
const EXTERNAL_URL = process.env.SF_PROBE_URL?.trim() || null;
const WIDTH = Number(process.env.SF_PROBE_WIDTH ?? 1600);
const HEIGHT = Number(process.env.SF_PROBE_HEIGHT ?? 900);
const TIME_OF_DAY = Number(process.env.SF_TIME ?? 18.7);
const DT = 1 / 30;

// src/gameplay/afterlight/layout.ts, duplicated deliberately so the probe can
// run in plain Node without a TypeScript loader. These are world-space metres.
const AFTERLIGHT_CENTER = Object.freeze({ x: 208, z: 2456 });
const AFTERLIGHT_ARRIVAL = Object.freeze({ x: 208, z: 2472 });
const MARA_INTERACTION = Object.freeze({ x: 204.4, z: 2463.1 });
const PARTICIPANT_INTERACTION = Object.freeze({
  x: AFTERLIGHT_CENTER.x + Math.cos(0.4) * 9.2,
  z: AFTERLIGHT_CENTER.z + Math.sin(0.4) * 9.2
});
const ECHO_LAYOUT = Object.freeze([
  Object.freeze({ x: 171, z: 2444, note: "a low note returns" }),
  Object.freeze({ x: 186, z: 2487, note: "the grove answers" }),
  Object.freeze({ x: 216, z: 2421, note: "a warm note wakes" }),
  Object.freeze({ x: 243, z: 2480, note: "the fog begins to sing" }),
  Object.freeze({ x: 253, z: 2446, note: "the last note finds its way" })
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rel = (file) => path.relative(ROOT, file) || ".";

function validateConfig() {
  if (!Number.isInteger(WIDTH) || !Number.isInteger(HEIGHT) || WIDTH < 360 || HEIGHT < 360) {
    throw new Error(`invalid viewport: ${WIDTH}x${HEIGHT}`);
  }
  if (!Number.isFinite(TIME_OF_DAY)) throw new Error(`invalid SF_TIME: ${TIME_OF_DAY}`);
  if (EXTERNAL_URL) {
    const parsed = new URL(EXTERNAL_URL);
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error(`SF_PROBE_URL must be http(s): ${EXTERNAL_URL}`);
    }
  }
}

async function executable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (candidate.includes(path.sep)) {
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      const full = path.join(dir, candidate);
      try {
        await access(full, fsConstants.X_OK);
        return full;
      } catch {
        // Keep looking.
      }
    }
  }
  return null;
}

async function findChrome() {
  const chrome = await executable([
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome",
    "chromium"
  ]);
  if (!chrome) throw new Error("No Chrome/Chromium found. Set CHROME_BIN.");
  return chrome;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a local port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function httpReady(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return true;
    } catch {
      // Keep polling while Vite imports the config and starts its relay.
    }
    await sleep(250);
  }
  return false;
}

let ownedDev = null;
let chromeProc = null;
let activeCdp = null;
let serverUrl = EXTERNAL_URL;
let relayPort = null;
let serverLogs = "";
let chromeLogs = "";

function appendLog(current, chunk) {
  return (current + chunk.toString()).slice(-32_000);
}

async function startServer() {
  if (EXTERNAL_URL) {
    if (!(await httpReady(EXTERNAL_URL, 30_000))) {
      throw new Error(`SF_PROBE_URL did not respond successfully: ${EXTERNAL_URL}`);
    }
    console.log(`[afterlight] reusing ${EXTERNAL_URL}`);
    return false;
  }

  const vitePort = await freePort();
  do relayPort = await freePort(); while (relayPort === vitePort);
  serverUrl = `http://127.0.0.1:${vitePort}`;
  console.log(`[afterlight] starting strict-port Vite ${serverUrl} (relay ${relayPort})`);
  ownedDev = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    {
      cwd: ROOT,
      env: { ...process.env, SF_RELAY_PORT: String(relayPort) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    }
  );
  ownedDev.stdout.on("data", (chunk) => (serverLogs = appendLog(serverLogs, chunk)));
  ownedDev.stderr.on("data", (chunk) => (serverLogs = appendLog(serverLogs, chunk)));

  if (!(await httpReady(serverUrl, 90_000))) {
    throw new Error(`Vite did not become ready at ${serverUrl}\n${serverLogs.slice(-4000)}`);
  }
  return true;
}

class Cdp {
  #ws;
  #id = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(url) {
    this.#ws = new WebSocket(url);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener("open", resolve, { once: true });
      this.#ws.addEventListener("error", reject, { once: true });
    });
    this.#ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        message.error
          ? pending.reject(new Error(`${pending.method}: ${message.error.message}`))
          : pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) {
        listener(message.params ?? {});
      }
    });
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? [];
    listeners.push(listener);
    this.#listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
    });
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // Already closed.
    }
  }
}

async function waitForCdp(port, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Keep polling.
    }
    await sleep(200);
  }
  throw new Error(`Chrome DevTools endpoint did not open on port ${port}`);
}

async function newPage(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) throw new Error(`could not create Chrome page (${response.status})`);
  return response.json();
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails;
    const message = detail.exception?.description || detail.text || JSON.stringify(detail);
    throw new Error(`browser eval: ${message}`);
  }
  return response.result?.value;
}

async function waitEval(cdp, expression, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evaluate(cdp, expression)) return;
    } catch {
      // Navigation/import may temporarily destroy the execution context.
    }
    await sleep(350);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const frameExpression = (dt) =>
  `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;

async function tick(cdp, dt = DT) {
  await evaluate(cdp, frameExpression(dt));
}

async function pressKeyboardE(cdp) {
  await evaluate(cdp, "window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyE',key:'e',bubbles:true}));true");
  await tick(cdp, DT);
  await evaluate(cdp, "window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyE',key:'e',bubbles:true}));true");
}

async function settle(cdp, frames, dt = 0, gapMs = 25) {
  for (let i = 0; i < frames; i++) {
    await tick(cdp, dt);
    if (gapMs > 0) await sleep(gapMs);
  }
}

async function teleport(cdp, x, z, facing = 0) {
  return evaluate(
    cdp,
    `(()=>{const s=window.__sf,p=s.player;const y=s.map.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:${facing},mode:'walk'});return {x:p.position.x,y:p.position.y,z:p.position.z,ground:y};})()`
  );
}

async function setCamera(cdp, preset) {
  const presets = {
    idle: { eye: [-46, 24, 48], targetY: 4.5 },
    active: { eye: [-58, 30, 52], targetY: 5.5 },
    complete: { eye: [48, 28, 54], targetY: 14 }
  };
  const selected = presets[preset];
  if (!selected) throw new Error(`unknown camera preset: ${preset}`);
  const pose = await evaluate(
    cdp,
    `(()=>{const s=window.__sf,c=s.camera;const y=s.map.groundTop(${AFTERLIGHT_CENTER.x},${AFTERLIGHT_CENTER.z});const eye=[${AFTERLIGHT_CENTER.x + selected.eye[0]},y+${selected.eye[1]},${AFTERLIGHT_CENTER.z + selected.eye[2]}];const target=[${AFTERLIGHT_CENTER.x},y+${selected.targetY},${AFTERLIGHT_CENTER.z}];
      window.__afterlightProbeCamera={eye,target};
      if(window.__sfFreeCam) window.__sfFreeCam(eye,target);
      else {
        if(!window.__afterlightProbeCameraPatched){window.__afterlightProbeCameraPatched=true;s.chase.update=()=>{const p=window.__afterlightProbeCamera;c.position.set(...p.eye);c.up.set(0,1,0);c.lookAt(...p.target);c.updateMatrixWorld();};}
        c.position.set(...eye);c.up.set(0,1,0);c.lookAt(...target);c.updateMatrixWorld();
      }
      return {eye,target,freeCamera:Boolean(window.__sfFreeCam)};})()`
  );
  for (let i = 0; i < 90; i++) {
    await tick(cdp, 0);
    const position = await evaluate(cdp, "[window.__sf.camera.position.x,window.__sf.camera.position.y,window.__sf.camera.position.z]");
    if (Math.hypot(...position.map((value, index) => value - pose.eye[index])) < 0.04) return pose;
    await sleep(20);
  }
  throw new Error(`camera did not acquire ${preset} pose`);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Minimal decoder for the non-interlaced 8-bit PNGs emitted by CDP. */
function pngMetrics(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) throw new Error("capture was not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!width || !height || bitDepth !== 8 || !channels || interlace !== 0) {
    throw new Error(`unsupported PNG ${width}x${height}, depth=${bitDepth}, color=${colorType}, interlace=${interlace}`);
  }
  const packed = inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  const pixels = Buffer.allocUnsafe(rowBytes * height);
  let source = 0;
  for (let y = 0; y < height; y++) {
    const filter = packed[source++];
    const row = y * rowBytes;
    const previous = row - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = packed[source++];
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[previous + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[previous + x - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paeth(left, up, upperLeft);
      else throw new Error(`unsupported PNG filter ${filter}`);
      pixels[row + x] = value & 255;
    }
  }

  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 180_000)));
  let count = 0;
  let mean = 0;
  let m2 = 0;
  let min = 255;
  let max = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const p = y * rowBytes + x * channels;
      const r = pixels[p];
      const g = colorType === 0 || colorType === 4 ? r : pixels[p + 1];
      const b = colorType === 0 || colorType === 4 ? r : pixels[p + 2];
      const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
      count++;
      const delta = luma - mean;
      mean += delta / count;
      m2 += delta * (luma - mean);
      min = Math.min(min, luma);
      max = Math.max(max, luma);
    }
  }
  const variance = count > 1 ? m2 / (count - 1) : 0;
  return {
    width,
    height,
    colorType,
    samples: count,
    lumaMean: Number(mean.toFixed(3)),
    lumaVariance: Number(variance.toFixed(3)),
    lumaStdDev: Number(Math.sqrt(variance).toFixed(3)),
    lumaMin: Number(min.toFixed(3)),
    lumaMax: Number(max.toFixed(3))
  };
}

const screenshots = new Map();

async function capture(cdp, name) {
  const response = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  const buffer = Buffer.from(response.data, "base64");
  let pixels = null;
  let pixelMetricError = null;
  try {
    pixels = pngMetrics(buffer);
  } catch (error) {
    pixelMetricError = String(error?.message || error);
  }
  screenshots.set(`${name}.png`, buffer);
  console.log(`[afterlight] captured ${name}.png (${Math.round(buffer.length / 1024)} KiB)`);
  return {
    path: rel(path.join(OUT, `${name}.png`)),
    byteLength: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    pixels,
    pixelMetricError
  };
}

function killOwned(child) {
  if (!child || child.exitCode != null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function cleanup() {
  activeCdp?.close();
  activeCdp = null;
  killOwned(chromeProc);
  chromeProc = null;
  killOwned(ownedDev);
  ownedDev = null;
}

const pageErrors = [];
const consoleErrors = [];
const errorKeys = new Set();

function recordError(bucket, kind, message) {
  const clean = String(message ?? "").trim().slice(0, 4000);
  if (!clean) return;
  const key = `${kind}|${clean}`;
  if (errorKeys.has(key)) return;
  errorKeys.add(key);
  bucket.push({ kind, message: clean });
  console.log(`[afterlight] page error (${kind}): ${clean.split("\n")[0].slice(0, 300)}`);
}

const result = {
  schema: 1,
  createdAt: new Date().toISOString(),
  status: "running",
  server: { url: null, owned: false, relayPort: null },
  bootUrl: null,
  viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
  timeOfDay: TIME_OF_DAY,
  layout: { center: AFTERLIGHT_CENTER, echoes: ECHO_LAYOUT },
  renderer: null,
  checks: [],
  states: {},
  collections: [],
  screenshots: {},
  errors: { page: pageErrors, console: consoleErrors }
};

function check(name, passed, details) {
  const entry = { name, passed: Boolean(passed), details };
  result.checks.push(entry);
  console.log(`[afterlight] ${entry.passed ? "PASS" : "FAIL"} ${name}`);
  if (!entry.passed) throw new Error(`${name}: ${JSON.stringify(details)}`);
  return details;
}

async function rendererInfo(cdp) {
  return evaluate(
    cdp,
    `(async()=>{const s=window.__sf,r=s.renderer,c=r.domElement,i=r.info,d=r.backend?.device;let queried=null;try{const a=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});const q=a?.info||(a?.requestAdapterInfo?await a.requestAdapterInfo():null);if(q)queried={vendor:q.vendor||null,architecture:q.architecture||null,device:q.device||null,description:q.description||null};}catch{}
      const current=d?.adapterInfo;return {
        webgpu:Boolean(navigator.gpu),backend:r.backend?.constructor?.name||null,renderer:r.constructor?.name||null,
        canvas:{clientWidth:c.clientWidth,clientHeight:c.clientHeight,width:c.width,height:c.height,devicePixelRatio:devicePixelRatio},
        adapter:current?{vendor:current.vendor||null,architecture:current.architecture||null,device:current.device||null,description:current.description||null}:queried,
        preferredCanvasFormat:navigator.gpu?.getPreferredCanvasFormat?.()||null,
        render:{calls:i.render?.calls??null,triangles:i.render?.triangles??null,points:i.render?.points??null,lines:i.render?.lines??null},
        memory:{geometries:i.memory?.geometries??null,textures:i.memory?.textures??null},
        limits:d?{maxTextureDimension2D:d.limits.maxTextureDimension2D,maxBufferSize:d.limits.maxBufferSize}:null
      };})()`
  );
}

async function main() {
  validateConfig();
  result.server.owned = await startServer();
  result.server.url = serverUrl;
  result.server.relayPort = relayPort;

  const chrome = await findChrome();
  const debugPort = await freePort();
  const profile = path.join(tmpdir(), `sf-afterlight-probe-${process.pid}-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  chromeProc = spawn(
    chrome,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--hide-scrollbars",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures",
      "--enable-gpu",
      "--use-angle=metal",
      `--window-size=${WIDTH},${HEIGHT}`,
      "--force-device-scale-factor=1",
      "about:blank"
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    }
  );
  chromeProc.stdout.on("data", (chunk) => (chromeLogs = appendLog(chromeLogs, chunk)));
  chromeProc.stderr.on("data", (chunk) => (chromeLogs = appendLog(chromeLogs, chunk)));

  await waitForCdp(debugPort);
  const page = await newPage(debugPort);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  activeCdp = cdp;
  await cdp.open();

  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    const message = exceptionDetails?.exception?.description || exceptionDetails?.text || JSON.stringify(exceptionDetails);
    recordError(pageErrors, "runtime-exception", message);
  });
  cdp.on("Runtime.consoleAPICalled", ({ type, args = [] }) => {
    if (!['error', 'assert'].includes(type)) return;
    const message = args.map((arg) => arg.value ?? arg.unserializableValue ?? arg.description ?? "").join(" ");
    recordError(consoleErrors, `console-${type}`, message);
  });

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: WIDTH,
    screenHeight: HEIGHT
  });

  // The invite deliberately boots inside Buena Vista instead of teleporting
  // there only after startup. Its Y only seeds the first pose; every subsequent
  // probe teleport resolves the live terrain height.
  const boot = new URL(serverUrl);
  boot.searchParams.set("autostart", "1");
  boot.searchParams.set("fullfps", "1");
  boot.searchParams.set("profile", "1");
  boot.searchParams.set("j", `${AFTERLIGHT_CENTER.x},175,${AFTERLIGHT_CENTER.z},0,walk`);
  boot.searchParams.set("via", "afterlight-probe");
  result.bootUrl = boot.toString();
  console.log(`[afterlight] navigating invite ${result.bootUrl}`);
  await cdp.send("Page.navigate", { url: result.bootUrl });

  const bootStarted = Date.now();
  await waitEval(
    cdp,
    "Boolean(window.__sf?.afterlight && window.__sf?.siteGate && window.__sf?.player && window.__sf?.renderer && window.__sf?.renderIdle && window.__sfManual)",
    180_000,
    "window.__sf.afterlight"
  );
  await evaluate(cdp, "window.__sf.afterlight.ready.then(()=>true)");
  await waitEval(cdp, "window.__sf.renderIdle()", 120_000, "renderIdle() === true");
  result.bootReadyMs = Date.now() - bootStarted;
  await evaluate(cdp, "window.__sfManual(true); true");
  await evaluate(
    cdp,
    `(()=>{const sky=window.__sf.sky;sky.cycleEnabled=false;sky.setTimeOfDay(${TIME_OF_DAY});document.body.classList.add('started');return true;})()`
  );

  // Re-ground after the invite's intentionally approximate Y and let the site
  // gate publish its first awake transition before inspecting idle state.
  await teleport(cdp, AFTERLIGHT_ARRIVAL.x, AFTERLIGHT_ARRIVAL.z, 0);
  await settle(cdp, 12, DT, 20);
  result.renderer = await rendererInfo(cdp);
  check("WebGPU renderer and canvas are live", result.renderer.webgpu && result.renderer.canvas.width > 0 && result.renderer.canvas.height > 0, result.renderer);

  const idle = await evaluate(
    cdp,
    `(()=>{const s=window.__sf,a=s.afterlight,d=a.debugState();return {debug:d,gateAwake:s.siteGate.awake('afterlight'),rootVisible:a.root.visible,rootInScene:Boolean(a.root.parent),promptVisible:Boolean(document.querySelector('.afterlight-prompt.show')),rootName:a.root.name,player:{x:s.player.position.x,y:s.player.position.y,z:s.player.position.z,mode:s.player.mode}};})()`
  );
  result.states.idle = idle;
  check(
    "nearby idle site is awake and visible",
    idle.debug.phase === "idle" && idle.debug.awake && idle.gateAwake && idle.rootVisible && idle.rootInScene,
    idle
  );
  check("map arrival has no dead E affordance", !idle.promptVisible, idle);

  // Claim a real participant through the shared keyboard event path, then
  // replace navigator.getGamepads with a standard-mapping test pad. Both sticks
  // must move hands while locomotion and right-stick camera look stay captured;
  // controller Y then releases through the same KeyE rail as production input.
  await teleport(cdp, PARTICIPANT_INTERACTION.x, PARTICIPANT_INTERACTION.z, Math.PI);
  await settle(cdp, 3, DT, 15);
  const takeoverPrompt = await evaluate(
    cdp,
    `(()=>({visible:Boolean(document.querySelector('.afterlight-prompt.show')),copy:document.querySelector('.afterlight-prompt-copy')?.textContent||'',state:window.__sf.afterlight.debugState()}))()`
  );
  check(
    "participant proximity exposes takeover prompt",
    takeoverPrompt.visible &&
      takeoverPrompt.copy.includes("take over") &&
      takeoverPrompt.state.takeover.index == null &&
      takeoverPrompt.state.takeover.beaconVisible,
    takeoverPrompt
  );
  await pressKeyboardE(cdp);
  await settle(cdp, 10, DT, 12);
  const claimed = await evaluate(
    cdp,
    `(()=>{const s=window.__sf;return {state:s.afterlight.debugState(),player:[s.player.position.x,s.player.position.z],yaw:s.chase.yaw,localEmbodimentVisible:s.player.meshes.walk.visible};})()`
  );
  result.states.takeoverClaimed = claimed;
  check(
    "real E input claims the nearest participant",
    claimed.state.takeover.index === 0 &&
      claimed.state.takeover.playerEmbodied &&
      claimed.state.takeover.observerOffset > 1.5 &&
      claimed.state.takeover.beaconVisible &&
      !claimed.localEmbodimentVisible &&
      claimed.state.takeover.web?.solver === "verlet" &&
      claimed.state.takeover.web?.nodes >= 2132 &&
      claimed.state.takeover.web?.detailMultiplier >= 4,
    claimed
  );
  await evaluate(
    cdp,
    `(()=>{window.__afterlightOriginalGetGamepads=navigator.getGamepads?.bind(navigator);window.__afterlightPad={axes:[-0.82,-0.62,0.76,-0.55],buttons:Array.from({length:16},()=>({pressed:false,value:0}))};Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[{id:'Afterlight QA pad',index:0,connected:true,mapping:'standard',timestamp:performance.now(),axes:window.__afterlightPad.axes,buttons:window.__afterlightPad.buttons,vibrationActuator:null,hapticActuators:[]}]});return true;})()`
  );
  await settle(cdp, 18, DT, 0);
  const padDriven = await evaluate(
    cdp,
    `(()=>{const s=window.__sf;return {state:s.afterlight.debugState(),player:[s.player.position.x,s.player.position.z],yaw:s.chase.yaw,device:s.input.device};})()`
  );
  result.states.takeoverPadDriven = padDriven;
  check(
    "controller sticks drive hands while body and camera stay captured",
    padDriven.device === "pad" &&
      padDriven.state.takeover.index === 0 &&
      padDriven.state.takeover.motion > 0.04 &&
      Math.hypot(padDriven.player[0] - claimed.player[0], padDriven.player[1] - claimed.player[1]) < 0.08 &&
      Math.abs(padDriven.yaw - claimed.yaw) < 0.002,
    { claimed, padDriven }
  );
  await evaluate(cdp, "window.__afterlightPad.axes=[0,0,0,0];window.__afterlightPad.buttons[3]={pressed:true,value:1};true");
  await tick(cdp, DT);
  const released = await evaluate(
    cdp,
    `(()=>{const s=window.__sf;return {state:s.afterlight.debugState(),localEmbodimentVisible:s.player.meshes.walk.visible};})()`
  );
  result.states.takeoverReleased = released;
  check(
    "controller Y releases and restores the exploring avatar",
    released.state.takeover.index == null &&
      !released.state.takeover.playerEmbodied &&
      released.localEmbodimentVisible,
    released
  );
  await evaluate(
    cdp,
    `(()=>{window.__afterlightPad.buttons[3]={pressed:false,value:0};if(window.__afterlightOriginalGetGamepads)Object.defineProperty(navigator,'getGamepads',{configurable:true,value:window.__afterlightOriginalGetGamepads});delete window.__afterlightPad;delete window.__afterlightOriginalGetGamepads;return true;})()`
  );

  await teleport(cdp, MARA_INTERACTION.x, MARA_INTERACTION.z, 0);
  await settle(cdp, 3, DT, 15);
  const maraPrompt = await evaluate(
    cdp,
    `(()=>({visible:Boolean(document.querySelector('.afterlight-prompt.show')),phase:window.__sf.afterlight.phase}))()`
  );
  check("Mara interaction affordance is actionable", maraPrompt.visible && maraPrompt.phase === "idle", maraPrompt);
  await setCamera(cdp, "idle");
  await settle(cdp, 8, DT, 25);
  result.screenshots.idle = await capture(cdp, "idle");

  await teleport(cdp, MARA_INTERACTION.x, MARA_INTERACTION.z, 0);
  await settle(cdp, 2, DT, 15);
  const started = await evaluate(
    cdp,
    `(()=>{const s=window.__sf,a=s.afterlight;const consumed=a.tryInteract(s.player,s.hud);const state=a.debugState();return {consumed,state};})()`
  );
  result.states.started = started;
  check(
    "tryInteract starts a fresh active quest",
    started.consumed && started.state.phase === "active" && started.state.collected.every(v=>!v) && started.state.arrived.every(v=>!v) && started.state.remainingSeconds > 80,
    started
  );
  await setCamera(cdp, "active");
  await settle(cdp, 10, DT, 25);
  result.screenshots.active = await capture(cdp, "active");

  // Collect through the real proximity path: each teleport is followed by a
  // regular app tick, allowing #collectNearby to discover only that echo.
  for (let i = 0; i < ECHO_LAYOUT.length; i++) {
    const echo = ECHO_LAYOUT[i];
    const player = await teleport(cdp, echo.x, echo.z, 0);
    await tick(cdp, DT);
    const state = await evaluate(cdp, "window.__sf.afterlight.debugState()");
    const collectedCount = state.collected.filter(Boolean).length;
    const sample = { index: i, echo, player, collectedCount, state };
    result.collections.push(sample);
    check(
      `proximity collection ${i + 1}/5`,
      state.phase === "active" && collectedCount === i + 1 && state.collected[i] === true,
      sample
    );
  }

  // 1.6 simulated seconds clears the authored 1.15-second return flights. The
  // calls still use the app's manual frame driver and public tick function.
  await settle(cdp, 48, DT, 0);
  const finale = await evaluate(cdp, "window.__sf.afterlight.debugState()");
  result.states.finale = finale;
  check("all five return flights arrive", finale.arrived.every(Boolean), finale);
  check("finale completes with the sky whale active", finale.phase === "complete" && finale.whaleActive, finale);

  // Let the completion reveal and whale orbit breathe before its visual proof.
  await setCamera(cdp, "complete");
  await settle(cdp, 120, DT, 0);
  result.states.completeReveal = await evaluate(cdp, "window.__sf.afterlight.debugState()");
  result.screenshots.complete = await capture(cdp, "complete");

  await teleport(cdp, AFTERLIGHT_CENTER.x, AFTERLIGHT_CENTER.z, 0);
  await settle(cdp, 2, DT, 10);
  const heldReplay = await evaluate(
    cdp,
    `(()=>{const s=window.__sf,a=s.afterlight;const consumed=a.tryInteract(s.player,s.hud);return {consumed,state:a.debugState()};})()`
  );
  result.states.heldReplay = heldReplay;
  check(
    "completion hold protects the finale from E mashing",
    heldReplay.consumed && heldReplay.state.phase === "complete" && heldReplay.state.whaleActive,
    heldReplay
  );
  await settle(cdp, 100, DT, 0);
  const replay = await evaluate(
    cdp,
    `(()=>{const s=window.__sf,a=s.afterlight;const consumed=a.tryInteract(s.player,s.hud);return {consumed,state:a.debugState()};})()`
  );
  result.states.replay = replay;
  check(
    "completed quest interaction starts a replay",
    replay.consumed && replay.state.phase === "active" && replay.state.collected.every(v=>!v) && replay.state.arrived.every(v=>!v) && !replay.state.whaleActive,
    replay
  );

  // Avoid hundreds of redundant WebGPU submissions while retaining the exact
  // public update path: simulate 83 seconds directly, then render one app frame.
  const timedOut = await evaluate(
    cdp,
    `(()=>{const s=window.__sf,a=s.afterlight;for(let i=0;i<830&&a.phase==='active';i++)a.update(0.1,i*0.1,s.player,s.hud);return a.debugState();})()`
  );
  await tick(cdp, 0);
  result.states.timedOut = timedOut;
  check("simulated quest timeout reaches failed", timedOut.phase === "failed" && timedOut.remainingSeconds === 0 && !timedOut.whaleActive, timedOut);

  const retry = await evaluate(
    cdp,
    `(()=>{const s=window.__sf,a=s.afterlight;const consumed=a.tryInteract(s.player,s.hud);return {consumed,state:a.debugState()};})()`
  );
  result.states.retry = retry;
  check(
    "failed quest interaction retries from a clean state",
    retry.consumed && retry.state.phase === "active" && retry.state.remainingSeconds > 80 && retry.state.collected.every(v=>!v) && retry.state.arrived.every(v=>!v) && !retry.state.whaleActive,
    retry
  );

  // End the retry, then move well outside the site's deactivate ellipse. A
  // normal app tick drives siteGate.update and must hide the dormant root.
  const retryTimeout = await evaluate(
    cdp,
    `(()=>{const s=window.__sf,a=s.afterlight;for(let i=0;i<830&&a.phase==='active';i++)a.update(0.1,i*0.1,s.player,s.hud);return a.debugState();})()`
  );
  result.states.retryTimeout = retryTimeout;
  await teleport(cdp, 0, 0, 0);
  await settle(cdp, 3, DT, 15);
  const sleeping = await evaluate(
    cdp,
    `(()=>{const s=window.__sf,a=s.afterlight;return {debug:a.debugState(),gateAwake:s.siteGate.awake('afterlight'),rootVisible:a.root.visible,rootInScene:Boolean(a.root.parent),player:{x:s.player.position.x,z:s.player.position.z}};})()`
  );
  result.states.sleeping = sleeping;
  check(
    "far-away inactive site sleeps and detaches",
    retryTimeout.phase === "failed" && !sleeping.debug.awake && !sleeping.gateAwake && !sleeping.rootVisible && !sleeping.rootInScene,
    sleeping
  );

  // Give any queued exception/console events one final event-loop turn before
  // treating a clean run as proof that the page stayed error-free.
  await sleep(250);
  check("page exceptions are empty", pageErrors.length === 0, pageErrors);
  check("console errors are empty", consoleErrors.length === 0, consoleErrors);

  for (const [name, shot] of Object.entries(result.screenshots)) {
    if (!shot.pixels) continue;
    check(`${name} screenshot has visible pixel variance`, shot.pixels.lumaVariance > 20, shot.pixels);
  }

  result.status = "pass";
  result.finishedAt = new Date().toISOString();
}

function writeArtifacts() {
  mkdirSync(OUT, { recursive: true });
  for (const [name, buffer] of screenshots) writeFileSync(path.join(OUT, name), buffer);
  writeFileSync(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (serverLogs) writeFileSync(path.join(OUT, "server.log"), serverLogs);
  if (chromeLogs) writeFileSync(path.join(OUT, "chrome.log"), chromeLogs);
}

let interrupted = false;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    interrupted = true;
    result.status = "interrupted";
    result.finishedAt = new Date().toISOString();
    result.failure = signal;
    cleanup();
    try {
      writeArtifacts();
    } catch {
      // Signal handling is best effort.
    }
    process.exit(code);
  });
}

main()
  .then(() => {
    cleanup();
    writeArtifacts();
    console.log(`[afterlight] PASS — ${result.checks.length} checks`);
    console.log(`[afterlight] artifacts: ${OUT}`);
  })
  .catch((error) => {
    if (interrupted) return;
    result.status = "failed";
    result.finishedAt = new Date().toISOString();
    result.failure = String(error?.stack || error);
    cleanup();
    try {
      writeArtifacts();
    } catch (writeError) {
      console.error("[afterlight] could not write failure artifacts", writeError);
    }
    console.error("[afterlight] FAIL", error);
    process.exitCode = 1;
  });
