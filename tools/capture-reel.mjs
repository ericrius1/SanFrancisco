// Headless capture for the 25-second vehicle reel (src/dev/demo.ts `reel`).
//
// Boots a throwaway Vite dev server (its own free relay port so it never
// collides with a human session on 5179), drives a headless WebGPU Chrome to
// /?demo=reel over the DevTools Protocol, records the run as a JPEG screencast,
// then muxes the frames into an MP4 with ffmpeg.
//
//   node tools/capture-reel.mjs
//
// Env overrides: SF_CAPTURE_WIDTH, SF_CAPTURE_HEIGHT, SF_CAPTURE_FPS,
// SF_CAPTURE_URL, SF_CAPTURE_OUT, CHROME_BIN.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import { access, copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = Number(process.env.SF_CAPTURE_WIDTH ?? 1920);
const HEIGHT = Number(process.env.SF_CAPTURE_HEIGHT ?? 1080);
const FPS = Number(process.env.SF_CAPTURE_FPS ?? 30);
// which demo route + how long it runs. Each reel is authored to an exact length
// and flips window.__sfReelDone when its timeline ends: reel=25s, reel2=35s.
const DEMO = process.env.SF_CAPTURE_DEMO ?? "reel";
const DURATION = Number(process.env.SF_CAPTURE_SECONDS ?? 25);
const FRAME_TARGET = FPS * DURATION;
const SERVER_URL = process.env.SF_CAPTURE_URL ?? "http://127.0.0.1:5179";
const OUT_DIR = path.join(ROOT, "dist", "reel");
const OUT_MP4 = process.env.SF_CAPTURE_OUT
  ? path.resolve(ROOT, process.env.SF_CAPTURE_OUT)
  : path.join(OUT_DIR, `san-francisco-${DEMO}-${DURATION}s.mp4`);
const OUT_POSTER = OUT_MP4.replace(/\.mp4$/i, ".jpg");
const WORK_DIR = path.join(ROOT, ".data", "reel-capture");
const RAW_DIR = path.join(WORK_DIR, "raw");
const SELECTED_DIR = path.join(WORK_DIR, "selected");
const CHROME_PROFILE = path.join(WORK_DIR, "chrome-profile");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isFile(p) {
  try {
    await access(p);
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
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome",
    "chromium"
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.includes("/") && !(await isFile(c))) continue;
    return c;
  }
  throw new Error("No Chrome/Chromium found. Set CHROME_BIN.");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {
      // keep polling
    }
    await sleep(350);
  }
  throw new Error(`Timed out waiting for ${label}: ${url}`);
}

async function startDevServerIfNeeded() {
  try {
    await waitForHttp(SERVER_URL, 2500, "existing Vite server");
    return { child: null };
  } catch {
    const relayPort = await freePort();
    console.log(`[reel] starting Vite dev server at ${SERVER_URL}`);
    const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1"], {
      cwd: ROOT,
      env: { ...process.env, SF_RELAY_PORT: String(relayPort) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let logs = "";
    const grab = (c) => (logs = (logs + c.toString()).slice(-8000));
    child.stdout.on("data", grab);
    child.stderr.on("data", grab);
    try {
      await waitForHttp(SERVER_URL, 45000, "Vite dev server");
    } catch (err) {
      throw new Error(`${err.message}\n\nRecent server output:\n${logs}`);
    }
    return { child };
  }
}

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))
    );
  });
}

// --- minimal Chrome DevTools Protocol client over WebSocket -----------------
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
    this.#ws.addEventListener("message", (e) => this.#handle(e));
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, method }));
  }
  on(method, fn) {
    const list = this.#listeners.get(method) ?? [];
    list.push(fn);
    this.#listeners.set(method, list);
  }
  close() {
    this.#ws.close();
  }
  #handle(e) {
    const msg = JSON.parse(e.data.toString());
    if (msg.id) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result ?? {});
      return;
    }
    for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params ?? {});
  }
}

async function waitForCdp(port) {
  const url = `http://127.0.0.1:${port}/json/version`;
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return res.json();
    } catch {
      // keep polling
    }
    await sleep(150);
  }
  throw new Error("Timed out waiting for Chrome DevTools Protocol.");
}

async function newPage(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (!res.ok) throw new Error(`Could not open Chrome target: ${res.status}`);
  return res.json();
}

async function evaluate(client, expression) {
  const r = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result?.value;
}

async function waitForEval(client, expression, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evaluate(client, expression)) return;
    } catch {
      // page may still be navigating
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

// Resample the raw frames onto an even FPS grid using screencast timestamps.
async function selectFrames(frames) {
  await rm(SELECTED_DIR, { recursive: true, force: true });
  await mkdir(SELECTED_DIR, { recursive: true });
  if (frames.length < 120) throw new Error(`Only captured ${frames.length} frames.`);

  const first = frames.find((f) => Number.isFinite(f.timestamp))?.timestamp;
  const last = [...frames].reverse().find((f) => Number.isFinite(f.timestamp))?.timestamp;
  const useTs = Number.isFinite(first) && Number.isFinite(last) && last - first > DURATION * 0.75;

  const timed = frames.map((f, i) => ({
    ...f,
    t: useTs ? Math.max(0, f.timestamp - first) : (i / Math.max(1, frames.length - 1)) * DURATION
  }));

  let cursor = 0;
  for (let i = 0; i < FRAME_TARGET; i++) {
    const target = i / FPS;
    while (cursor < timed.length - 2 && timed[cursor + 1].t < target) cursor++;
    const next = timed[Math.min(cursor + 1, timed.length - 1)];
    const prev = timed[cursor];
    const src = Math.abs(next.t - target) < Math.abs(prev.t - target) ? next : prev;
    await copyFile(src.path, path.join(SELECTED_DIR, `frame_${String(i).padStart(4, "0")}.jpg`));
  }
}

async function encodeVideo() {
  await runProcess("ffmpeg", [
    "-y",
    "-framerate", String(FPS),
    "-i", path.join(SELECTED_DIR, "frame_%04d.jpg"),
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", String(DURATION),
    "-vf", `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", "slow",
    "-crf", "18",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-shortest",
    OUT_MP4
  ]);
  await runProcess("ffmpeg", [
    "-y",
    "-ss", "00:00:02",
    "-i", OUT_MP4,
    "-frames:v", "1",
    "-update", "1",
    "-q:v", "2",
    OUT_POSTER
  ]);
}

async function main() {
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const dev = await startDevServerIfNeeded();
  const chromePath = await findChrome();
  const debugPort = await freePort();
  const url = `${SERVER_URL}/?demo=reel&hold=1&autostart=1&fullfps=1`;

  console.log(`[reel] launching headless Chrome ${WIDTH}x${HEIGHT}`);
  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${CHROME_PROFILE}`,
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
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let chromeLogs = "";
  chrome.stdout.on("data", (d) => (chromeLogs += d.toString()));
  chrome.stderr.on("data", (d) => (chromeLogs += d.toString()));

  let client;
  const frames = [];
  const consoleLines = [];
  try {
    await waitForCdp(debugPort);
    const page = await newPage(debugPort);
    client = new Cdp(page.webSocketDebuggerUrl);
    await client.open();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: WIDTH,
      screenHeight: HEIGHT
    });

    client.on("Runtime.consoleAPICalled", (e) => {
      const line = e.args?.map((a) => a.value ?? a.description ?? "").join(" ");
      if (line) consoleLines.push(line);
    });
    client.on("Log.entryAdded", (e) => {
      if (e.entry?.level === "error") consoleLines.push(e.entry.text);
    });
    client.on("Page.screencastFrame", (e) => {
      const file = path.join(RAW_DIR, `frame_${String(frames.length).padStart(5, "0")}.jpg`);
      writeFileSync(file, Buffer.from(e.data, "base64"));
      frames.push({ path: file, timestamp: e.metadata?.timestamp ?? null });
      void client.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
    });

    await client.send("Page.navigate", { url });
    await waitForEval(client, "Boolean(window.__sfReelArmed)", 120000, "reel route to arm");
    await sleep(500); // let the first tiles stream in before rolling

    console.log("[reel] recording 25-second reel");
    await client.send("Page.startScreencast", {
      format: "jpeg",
      quality: 94,
      maxWidth: WIDTH,
      maxHeight: HEIGHT,
      everyNthFrame: 1
    });
    await evaluate(client, "window.__sfStartReel && window.__sfStartReel(); true");
    await waitForEval(client, "window.__sfReelDone === true", (DURATION + 10) * 1000, "reel completion");
    await sleep(350);
    await client.send("Page.stopScreencast");

    if (consoleLines.some((l) => /\b(error|exception|uncaught)\b/i.test(l))) {
      await writeFile(path.join(WORK_DIR, "browser-console.log"), consoleLines.join("\n"));
      console.warn("[reel] browser console had errors; see .data/reel-capture/browser-console.log");
    }
  } catch (err) {
    if (chromeLogs) await writeFile(path.join(WORK_DIR, "chrome.log"), chromeLogs);
    throw err;
  } finally {
    client?.close();
    chrome.kill("SIGTERM");
    dev.child?.kill("SIGTERM");
  }

  if (!frames.length && !(await readdir(RAW_DIR)).length) throw new Error("No screencast frames captured.");

  console.log(`[reel] captured ${frames.length} frames; resampling to ${FRAME_TARGET} @ ${FPS}fps`);
  await selectFrames(frames);
  console.log("[reel] encoding MP4");
  await encodeVideo();

  console.log(`[reel] wrote ${path.relative(ROOT, OUT_MP4)}`);
  if (existsSync(OUT_POSTER)) console.log(`[reel] poster ${path.relative(ROOT, OUT_POSTER)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
