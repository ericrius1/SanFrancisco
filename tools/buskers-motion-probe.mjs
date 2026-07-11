// Deterministic motion capture for the Corona Heights busker trio.
//
// Captures short, fixed-step portrait clips around the two animation moments
// most useful for pose/motion QA: the ukulele strum and the flute phrase. This
// script intentionally knows nothing about performer implementation files; it
// drives only the dev hooks exposed by the running app.
//
// Default: starts a fresh Vite server at http://127.0.0.1:5273 and refuses to
// reuse an existing listener. To point it at a server intentionally:
//
//   SF_PROBE_URL=http://127.0.0.1:5274 \
//   SF_PROBE_SERVER_MODE=reuse \
//   node tools/buskers-motion-probe.mjs
//
// Env:
//   SF_PROBE_URL          app origin (default http://127.0.0.1:5273)
//   SF_PROBE_SERVER_MODE  fresh | reuse | auto (default fresh)
//   SF_PROBE_OUT          output directory (default timestamped under .data)
//   SF_PROBE_FPS          capture FPS (default 30)
//   SF_PROBE_SECONDS      seconds per clip (default 1.8)
//   SF_PROBE_WIDTH/HEIGHT viewport (default 1280x720)
//   SF_TIME               fixed time of day in hours (default 15)
//   CHROME_BIN            Chrome/Chromium executable override
//   FFMPEG_BIN            ffmpeg executable override

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { constants as fsConstants, existsSync } from "node:fs";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5273";
const SERVER_MODE = (process.env.SF_PROBE_SERVER_MODE ?? "fresh").toLowerCase();
const FPS = Number(process.env.SF_PROBE_FPS ?? 30);
const DURATION = Number(process.env.SF_PROBE_SECONDS ?? 1.8);
const WIDTH = Number(process.env.SF_PROBE_WIDTH ?? 1280);
const HEIGHT = Number(process.env.SF_PROBE_HEIGHT ?? 720);
const TIME_OF_DAY = Number(process.env.SF_TIME ?? 15);
const FRAME_COUNT = Math.round(FPS * DURATION);
const DT = 1 / FPS;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? `.data/buskers-motion-${RUN_ID}`);

// Camera values use the trio's local frame: eye = seat + front*dist +
// right*lateral + up. They match the proven portrait views in buskers-probe.
const CLIPS = [
  {
    id: "ukulele-strum",
    performer: "ukulele",
    startBeat: 21.75,
    camera: { dist: 2.4, lateral: 0.7, up: 0.55, targetUp: 0.45 }
  },
  {
    id: "flute-phrase",
    performer: "flute",
    startBeat: 38.0,
    camera: { dist: 2.4, lateral: -0.75, up: 0.6, targetUp: 0.5 }
  }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rel = (p) => path.relative(ROOT, p) || ".";

function validateConfig() {
  if (!new Set(["fresh", "reuse", "auto"]).has(SERVER_MODE)) {
    throw new Error(`SF_PROBE_SERVER_MODE must be fresh, reuse, or auto (got ${SERVER_MODE})`);
  }
  if (!Number.isFinite(FPS) || FPS <= 0 || FPS > 120) throw new Error(`invalid SF_PROBE_FPS: ${FPS}`);
  if (!Number.isFinite(DURATION) || DURATION <= 0 || DURATION > 10) {
    throw new Error(`invalid SF_PROBE_SECONDS: ${DURATION}`);
  }
  if (!Number.isInteger(WIDTH) || !Number.isInteger(HEIGHT) || WIDTH < 320 || HEIGHT < 240) {
    throw new Error(`invalid viewport: ${WIDTH}x${HEIGHT}`);
  }
  if (!Number.isFinite(TIME_OF_DAY)) throw new Error(`invalid SF_TIME: ${TIME_OF_DAY}`);
  const url = new URL(SERVER_URL);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`SF_PROBE_URL must be http(s): ${SERVER_URL}`);
  if (SERVER_MODE !== "reuse") {
    if (!url.port) throw new Error(`fresh/auto SF_PROBE_URL must include a port: ${SERVER_URL}`);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
      throw new Error(`fresh/auto mode can only start a local URL: ${SERVER_URL}`);
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
        // keep looking
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

async function findFfmpeg() {
  return executable([
    process.env.FFMPEG_BIN,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "ffmpeg"
  ]);
}

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

async function httpReady(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Any HTTP response means the address is owned. In fresh mode even a
      // 404/500 must be refused instead of being mistaken for a free port.
      await fetch(url, { cache: "no-store" });
      return true;
    } catch {
      // keep polling
    }
    await sleep(300);
  }
  return false;
}

let ownedDev = null;
let chromeProc = null;
let activeCdp = null;
let serverLogs = "";
let chromeLogs = "";

async function startServer() {
  const alreadyReady = await httpReady(SERVER_URL, 1200);
  if (SERVER_MODE === "reuse") {
    if (!alreadyReady && !(await httpReady(SERVER_URL, 9000))) {
      throw new Error(`reuse requested but no server responded at ${SERVER_URL}`);
    }
    console.log(`[motion] reusing ${SERVER_URL}`);
    return false;
  }
  if (SERVER_MODE === "fresh" && alreadyReady) {
    throw new Error(`fresh mode refuses to reuse ${SERVER_URL}; choose a free URL or set SF_PROBE_SERVER_MODE=reuse`);
  }
  if (SERVER_MODE === "auto" && alreadyReady) {
    console.log(`[motion] reusing ${SERVER_URL}`);
    return false;
  }

  const parsed = new URL(SERVER_URL);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const relayPort = await freePort();
  console.log(`[motion] starting fresh Vite at ${SERVER_URL}`);
  ownedDev = spawn(
    "npm",
    ["run", "dev", "--", "--host", host, "--port", parsed.port, "--strictPort"],
    {
      cwd: ROOT,
      env: { ...process.env, SF_RELAY_PORT: String(relayPort) },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const append = (chunk) => {
    serverLogs = (serverLogs + chunk.toString()).slice(-24_000);
  };
  ownedDev.stdout.on("data", append);
  ownedDev.stderr.on("data", append);
  if (!(await httpReady(SERVER_URL, 60_000))) {
    throw new Error(`Vite did not become ready at ${SERVER_URL}\n${serverLogs.slice(-4000)}`);
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
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params ?? {});
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
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, method }));
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // already closed
    }
  }
}

async function waitForCdp(port, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // keep polling
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
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    const message = detail.exception?.description || detail.text || JSON.stringify(detail);
    throw new Error(`browser eval: ${message}`);
  }
  return result.result?.value;
}

async function waitEval(cdp, expression, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evaluate(cdp, expression)) return;
    } catch {
      // app may still be importing
    }
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const frameExpression = (dt) =>
  `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;

async function tick(cdp, dt) {
  await evaluate(cdp, frameExpression(dt));
}

async function settle(cdp, iterations, gapMs = 55) {
  for (let i = 0; i < iterations; i++) {
    await tick(cdp, 0);
    await sleep(gapMs);
  }
}

async function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function encodeClip(ffmpeg, clip, frameDir) {
  if (!ffmpeg) return { available: false, encoded: false, reason: "ffmpeg not found; PNG/JPEG frames retained" };
  const output = path.join(OUT, `${clip.id}.mp4`);
  await runProcess(ffmpeg, [
    "-y",
    "-loglevel", "error",
    "-framerate", String(FPS),
    "-i", path.join(frameDir, "frame_%04d.jpg"),
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", "medium",
    "-crf", "17",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-r", String(FPS),
    output
  ]);
  return { available: true, encoded: true, path: rel(output) };
}

function cleanup() {
  activeCdp?.close();
  activeCdp = null;
  if (chromeProc && chromeProc.exitCode == null) chromeProc.kill("SIGTERM");
  chromeProc = null;
  if (ownedDev && ownedDev.exitCode == null) ownedDev.kill("SIGTERM");
  ownedDev = null;
}

const problems = [];
const problemKeys = new Set();
function recordProblem(kind, level, message, extra = {}) {
  const clean = String(message ?? "").trim().slice(0, 4000);
  if (!clean) return;
  const key = `${kind}|${level}|${clean}`;
  if (problemKeys.has(key)) return;
  problemKeys.add(key);
  problems.push({ kind, level, message: clean, ...extra });
  const prefix = level === "error" ? "error" : "warning";
  console.log(`[page-${prefix}] ${kind}: ${clean.split("\n")[0].slice(0, 300)}`);
}

let manifest = {
  schema: 1,
  createdAt: new Date().toISOString(),
  status: "running",
  url: SERVER_URL,
  serverMode: SERVER_MODE,
  output: rel(OUT),
  viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
  capture: {
    fps: FPS,
    requestedSeconds: DURATION,
    frameCount: FRAME_COUNT,
    fixedStepSeconds: DT,
    timeOfDay: TIME_OF_DAY
  },
  assembly: null,
  renderer: null,
  clips: [],
  problems
};

let outputPrepared = false;

async function writeManifest() {
  await mkdir(OUT, { recursive: true });
  if (serverLogs) await writeFile(path.join(OUT, "server.log"), serverLogs);
  if (chromeLogs) await writeFile(path.join(OUT, "chrome.log"), chromeLogs);
  await writeFile(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  validateConfig();
  if (existsSync(OUT) && (await readdir(OUT)).length > 0) {
    throw new Error(`output directory is not empty: ${OUT}; choose a fresh SF_PROBE_OUT`);
  }
  await mkdir(path.join(OUT, "frames"), { recursive: true });
  outputPrepared = true;
  manifest.serverOwned = await startServer();

  const chrome = await findChrome();
  const ffmpeg = await findFfmpeg();
  const debugPort = await freePort();
  const profile = path.join(OUT, "chrome-profile");
  const url = `${SERVER_URL}/?autostart=1&fullfps=1`;
  manifest.chrome = chrome;
  manifest.ffmpeg = ffmpeg ? { available: true, executable: ffmpeg } : { available: false };

  console.log(`[motion] launching Chrome ${WIDTH}x${HEIGHT} -> ${url}`);
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
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures",
      "--use-angle=metal",
      `--window-size=${WIDTH},${HEIGHT}`,
      "--force-device-scale-factor=1",
      "about:blank"
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );
  chromeProc.stdout.on("data", (chunk) => (chromeLogs = (chromeLogs + chunk.toString()).slice(-24_000)));
  chromeProc.stderr.on("data", (chunk) => (chromeLogs = (chromeLogs + chunk.toString()).slice(-24_000)));

  await waitForCdp(debugPort);
  const page = await newPage(debugPort);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  activeCdp = cdp;
  await cdp.open();

  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    const message = exceptionDetails?.exception?.description || exceptionDetails?.text || JSON.stringify(exceptionDetails);
    recordProblem("runtime-exception", "error", message);
  });
  cdp.on("Runtime.consoleAPICalled", ({ type, args = [] }) => {
    if (!["error", "warning", "assert"].includes(type)) return;
    const message = args.map((arg) => arg.value ?? arg.unserializableValue ?? arg.description ?? "").join(" ");
    recordProblem("console", type === "warning" ? "warning" : "error", message, { consoleType: type });
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    if (!entry || !["error", "warning"].includes(entry.level)) return;
    recordProblem("browser-log", entry.level, entry.text, { url: entry.url || undefined });
  });
  cdp.on("Network.loadingFailed", ({ errorText, type, canceled, blockedReason }) => {
    if (canceled) return;
    recordProblem("network-failed", "error", errorText || blockedReason || "resource load failed", { resourceType: type });
  });
  cdp.on("Network.responseReceived", ({ response, type }) => {
    if (!response || response.status < 400) return;
    recordProblem("http-response", "error", `${response.status} ${response.statusText || ""} ${response.url}`, {
      status: response.status,
      resourceType: type,
      url: response.url
    });
  });

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: WIDTH,
    screenHeight: HEIGHT
  });
  await cdp.send("Page.navigate", { url });

  console.log("[motion] waiting for busker debug hooks...");
  await waitEval(
    cdp,
    `Boolean(window.__sf?.buskers && window.__sf?.player && window.__sf?.renderer && window.__sf?.sky && window.__sfManual && window.__sfFreeCam)`,
    150_000,
    "window.__sf busker/free-camera hooks"
  );
  await evaluate(cdp, "window.__sfManual(true); true");
  await evaluate(
    cdp,
    `(()=>{const sky=window.__sf.sky;sky.cycleEnabled=false;sky.setTimeOfDay(${TIME_OF_DAY});return true;})()`
  );
  await settle(cdp, 12);

  // Stream the trio's neighborhood before framing it, then park the player
  // downslope so their avatar cannot enter either portrait clip.
  await evaluate(
    cdp,
    `(()=>{const s=window.__sf,y=s.map.groundHeight(408,2744);s.player.teleportTo({x:408,y:y+1.5,z:2744,facing:${-Math.PI / 4},mode:'walk'});return true;})()`
  );
  await settle(cdp, 18);
  manifest.assembly = await evaluate(
    cdp,
    `(()=>{const b=window.__sf.buskers;let meshes=0;b.group.traverse(o=>{if(o.isMesh)meshes++});return {children:b.group.children.length,meshes,position:[b.group.position.x,b.group.position.y,b.group.position.z]};})()`
  );
  if (manifest.assembly.children < 4 || manifest.assembly.meshes < 30) {
    throw new Error(`busker assembly looks incomplete: ${JSON.stringify(manifest.assembly)}`);
  }
  await evaluate(
    cdp,
    `(()=>{const s=window.__sf,y=s.map.groundHeight(340,2840);s.player.teleportTo({x:340,y:y+1.5,z:2840,facing:${Math.PI},mode:'walk'});return true;})()`
  );
  await settle(cdp, 3);

  for (const clip of CLIPS) {
    const frameDir = path.join(OUT, "frames", clip.id);
    await mkdir(frameDir, { recursive: true });
    const camera = clip.camera;
    const eye = await evaluate(
      cdp,
      `(()=>{const s=window.__sf,T=s.THREE,b=s.buskers;const front=new T.Vector3(0,0,-1).applyQuaternion(b.group.quaternion);const right=new T.Vector3(1,0,0).applyQuaternion(b.group.quaternion);const focus=b.seatWorld('${clip.performer}');const eye=focus.clone().addScaledVector(front,${camera.dist}).addScaledVector(right,${camera.lateral}).add(new T.Vector3(0,${camera.up},0));const target=focus.clone().add(new T.Vector3(0,${camera.targetUp},0));window.__sfFreeCam([eye.x,eye.y,eye.z],[target.x,target.y,target.z]);return [eye.x,eye.y,eye.z];})()`
    );
    // Let the cine hook take ownership and compile the close-up before seeking.
    for (let i = 0; i < 120; i++) {
      await tick(cdp, 0);
      const position = await evaluate(cdp, "[window.__sf.camera.position.x,window.__sf.camera.position.y,window.__sf.camera.position.z]");
      if (Math.hypot(position[0] - eye[0], position[1] - eye[1], position[2] - eye[2]) < 0.03) break;
      await sleep(20);
    }
    await settle(cdp, 4, 35);
    await evaluate(cdp, `window.__sf.buskers.seek(${clip.startBeat}); true`);
    await tick(cdp, 0);

    const samples = [];
    console.log(`[motion] ${clip.id}: ${FRAME_COUNT} frames from beat ${clip.startBeat}`);
    for (let i = 0; i < FRAME_COUNT; i++) {
      if (i > 0) await tick(cdp, DT);
      const clock = await evaluate(
        cdp,
        `(()=>{const b=window.__sf.buskers.clock;return {phase:b.phase,beat:b.beat,songTime:b.songTime};})()`
      );
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 92,
        fromSurface: true
      });
      const framePath = path.join(frameDir, `frame_${String(i).padStart(4, "0")}.jpg`);
      await writeFile(framePath, Buffer.from(screenshot.data, "base64"));
      samples.push(clock);
      if (i % FPS === 0) console.log(`[motion]   ${clip.id} frame ${i}/${FRAME_COUNT}`);
    }

    const encoded = await encodeClip(ffmpeg, clip, frameDir);
    const monotonic = samples.every((sample, i) => i === 0 || sample.beat + 1e-9 >= samples[i - 1].beat);
    manifest.clips.push({
      id: clip.id,
      performer: clip.performer,
      startBeat: clip.startBeat,
      camera,
      frameDirectory: rel(frameDir),
      capturedFrames: samples.length,
      simulatedSeconds: (samples.length - 1) * DT,
      firstClock: samples[0] ?? null,
      lastClock: samples.at(-1) ?? null,
      beatMonotonic: monotonic,
      video: encoded
    });
    if (!monotonic) recordProblem("clock", "error", `${clip.id} transport beat moved backward`);
  }

  manifest.renderer = await evaluate(
    cdp,
    `(()=>{const s=window.__sf,r=s.renderer,c=r.domElement,i=r.info;return {canvas:{clientWidth:c.clientWidth,clientHeight:c.clientHeight,width:c.width,height:c.height},backend:r.backend?.constructor?.name||null,render:{calls:i.render?.calls??null,triangles:i.render?.triangles??null,points:i.render?.points??null,lines:i.render?.lines??null},memory:{geometries:i.memory?.geometries??null,textures:i.memory?.textures??null},webgpu:Boolean(navigator.gpu)};})()`
  );

  const errorCount = problems.filter((problem) => problem.level === "error").length;
  manifest.status = errorCount ? "captured-with-errors" : "pass";
  manifest.finishedAt = new Date().toISOString();
  await writeManifest();
  console.log(`[motion] artifacts: ${OUT}`);
  console.log(`[motion] manifest: ${path.join(OUT, "manifest.json")}`);
  if (errorCount) throw new Error(`${errorCount} page/network error(s); see manifest.json`);
}

process.once("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

main()
  .catch(async (error) => {
    manifest.status = "failed";
    manifest.finishedAt = new Date().toISOString();
    manifest.failure = String(error?.stack || error);
    if (outputPrepared) {
      try {
        await writeManifest();
      } catch {
        // Preserve the original failure.
      }
    }
    console.error("[motion] FAIL", error);
    process.exitCode = 1;
  })
  .finally(cleanup);
