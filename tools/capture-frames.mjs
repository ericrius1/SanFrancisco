// Deterministic frame-by-frame render of the reel3 landmark reel.
//
// Instead of a real-time screencast (which drops frames under GPU load), this
// stops the wall-clock loop (window.__sfManual) and advances the sim by exactly
// one fixed dt per frame: __sfReelStep(t) sets the reel to virtual time t, then
// __sf.tick(1/FPS) renders that single frame, then we screenshot it. GPU speed
// only changes how long the capture takes — never the smoothness. Tiles are let
// to stream in at each clip cut (dt=0 settle) so cuts land clean.
//
//   SF_CAPTURE_URL=http://127.0.0.1:5191 node tools/capture-frames.mjs
//
// Env: SF_CAPTURE_FPS (default 60), SF_CAPTURE_SECONDS (25), SF_CAPTURE_DEMO
// (reel3), SF_CAPTURE_OUT, SF_CAPTURE_WIDTH/HEIGHT, CHROME_BIN.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import { access, mkdir, rm, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = Number(process.env.SF_CAPTURE_WIDTH ?? 1920);
const HEIGHT = Number(process.env.SF_CAPTURE_HEIGHT ?? 1080);
const FPS = Number(process.env.SF_CAPTURE_FPS ?? 60);
const DURATION = Number(process.env.SF_CAPTURE_SECONDS ?? 28);
const DEMO = process.env.SF_CAPTURE_DEMO ?? "reel3";
const TOTAL = Math.round(FPS * DURATION);
const DT = 1 / FPS;
// clip boundaries (seconds) where we settle to stream the new scene's tiles
const CUT_SECONDS = (process.env.SF_CAPTURE_CUTS ?? "5,12.8,18,23").split(",").map(Number).filter((n) => Number.isFinite(n));
const SERVER_URL = process.env.SF_CAPTURE_URL ?? "http://127.0.0.1:5179";
const OUT_DIR = path.join(ROOT, "dist", "reel");
const OUT_MP4 = process.env.SF_CAPTURE_OUT
  ? path.resolve(ROOT, process.env.SF_CAPTURE_OUT)
  : path.join(OUT_DIR, `san-francisco-${DEMO}-smooth-${DURATION}s.mp4`);
const OUT_POSTER = OUT_MP4.replace(/\.mp4$/i, ".jpg");
const WORK_DIR = path.join(ROOT, ".data", `${DEMO}-frames`);
const RAW_DIR = path.join(WORK_DIR, "raw");
const CHROME_PROFILE = path.join(WORK_DIR, "chrome");

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
  for (const c of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(350);
  }
  throw new Error(`timeout ${label}: ${url}`);
}
async function startDevIfNeeded() {
  try {
    await waitHttp(SERVER_URL, 2500, "existing vite");
    return null;
  } catch {
    const relay = await freePort();
    const vitePort = Number(new URL(SERVER_URL).port || 5179);
    console.log(`[frames] starting Vite at ${SERVER_URL}`);
    const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
      cwd: ROOT,
      env: { ...process.env, SF_RELAY_PORT: String(relay) },
      stdio: ["ignore", "ignore", "ignore"]
    });
    await waitHttp(SERVER_URL, 45000, "vite");
    return child;
  }
}
function runProcess(cmd, args) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
    c.once("error", rej);
    c.once("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });
}

class Cdp {
  #ws;
  #id = 1;
  #p = new Map();
  constructor(u) {
    this.#ws = new WebSocket(u);
  }
  async open() {
    await new Promise((res, rej) => {
      this.#ws.addEventListener("open", res, { once: true });
      this.#ws.addEventListener("error", rej, { once: true });
    });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) return;
      const p = this.#p.get(m.id);
      if (!p) return;
      this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.#p.set(id, { res, rej, method }));
  }
  close() {
    this.#ws.close();
  }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  return r.result?.value;
}
async function waitEv(c, expr, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if (await ev(c, expr)) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timeout ${label}`);
}

// render one frame at a fixed dt and wait for it to be presented to the canvas
// (async IIFE so the top-level await is legal inside Runtime.evaluate)
const frameExpr = (dt) =>
  `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) {
  await ev(c, frameExpr(dt));
}
// let async tile streaming catch up without advancing sim/reel time (dt 0)
async function settle(c, iters, gapMs) {
  for (let i = 0; i < iters; i++) {
    await ev(c, frameExpr(0));
    await sleep(gapMs);
  }
}

async function encode() {
  await runProcess("ffmpeg", [
    "-y",
    "-framerate", String(FPS),
    "-i", path.join(RAW_DIR, "frame_%05d.jpg"),
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", String(DURATION),
    "-vf", `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", "slow",
    "-crf", "16",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-r", String(FPS),
    "-shortest",
    OUT_MP4
  ]);
  await runProcess("ffmpeg", ["-y", "-ss", "00:00:02", "-i", OUT_MP4, "-frames:v", "1", "-update", "1", "-q:v", "2", OUT_POSTER]);
}

async function main() {
  // Partial re-render: overwrite only frames [FROM,TO) and keep the rest, so a
  // single clip can be re-shot and stitched back into the existing frame set.
  const FROM = Math.max(0, Number(process.env.SF_CAPTURE_FROM ?? 0));
  const TO = Math.min(TOTAL, Number(process.env.SF_CAPTURE_TO ?? TOTAL));
  const partial = FROM > 0 || TO < TOTAL;
  if (!partial) await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  const dev = await startDevIfNeeded();
  const chromePath = await findChrome();
  const dport = await freePort();
  const url = `${SERVER_URL}/?demo=${DEMO}&hold=1&manual=1&autostart=1&fullfps=1`;
  console.log(`[frames] ${WIDTH}x${HEIGHT} @ ${FPS}fps, ${TOTAL} frames -> ${url}`);
  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${dport}`,
      `--user-data-dir=${CHROME_PROFILE}`,
      "--headless=new",
      "--no-first-run",
      "--mute-audio",
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures",
      "--use-angle=metal",
      `--window-size=${WIDTH},${HEIGHT}`,
      "--force-device-scale-factor=1",
      "about:blank"
    ],
    { stdio: "ignore" }
  );
  let client;
  try {
    const t0 = Date.now();
    let ver;
    while (Date.now() - t0 < 15000) {
      try {
        ver = await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json();
        break;
      } catch {
        await sleep(200);
      }
    }
    if (!ver) throw new Error("no CDP");
    const page = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    client = new Cdp(page.webSocketDebuggerUrl);
    await client.open();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await client.send("Page.navigate", { url });
    await waitEv(client, "Boolean(window.__sfReelArmed && window.__sf && window.__sfReelStep && window.__sfManual)", 120000, "reel arm");

    // hand the clock to us, fast-forward the reel to the start frame, then let
    // that scene stream in before we begin screenshotting
    await ev(client, "window.__sfManual(true); true");
    await ev(client, `window.__sfReelStep(${FROM * DT}); true`);
    await settle(client, partial ? 34 : 55, 55);

    const cutFrames = new Set(CUT_SECONDS.map((s) => Math.round(s * FPS)));
    console.log(`[frames] rendering ${FROM}..${TO}${partial ? " (partial)" : ""}…`);
    for (let i = FROM; i < TO; i++) {
      const t = i * DT;
      await ev(client, `window.__sfReelStep(${t}); true`);
      await tick(client, DT);
      if (cutFrames.has(i)) await settle(client, 40, 45); // new clip — stream it in
      const shot = await client.send("Page.captureScreenshot", { format: "jpeg", quality: 92, fromSurface: true });
      writeFileSync(path.join(RAW_DIR, `frame_${String(i).padStart(5, "0")}.jpg`), Buffer.from(shot.data, "base64"));
      if (i % 120 === 0) console.log(`[frames]   ${i}/${TOTAL} (${(t).toFixed(1)}s)`);
    }
  } catch (err) {
    throw err;
  } finally {
    client?.close();
    chrome.kill("SIGTERM");
    dev?.kill("SIGTERM");
  }

  const n = (await readdir(RAW_DIR)).length;
  if (n < TOTAL * 0.9) throw new Error(`only ${n}/${TOTAL} frames`);
  console.log(`[frames] captured ${n} frames; encoding ${FPS}fps MP4`);
  await encode();
  console.log(`[frames] wrote ${path.relative(ROOT, OUT_MP4)}`);
  if (existsSync(OUT_POSTER)) console.log(`[frames] poster ${path.relative(ROOT, OUT_POSTER)}`);
  await writeFile(path.join(WORK_DIR, "done.txt"), `frames ${n}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
