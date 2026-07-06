// GROUND-TRUTH verify of the horse paddock: boots the REAL app in headless
// Chrome with WebGPU (metal), teleports to the Horse Paddock, drives the sim in
// manual mode (deterministic, GPU-speed-independent), and every few ticks reads
// window.__sf.horseHerd.debugStates() — the ACTUAL in-world sim that drives the
// render — plus periodic screenshots. This is the check my Node-only gate could
// not do: it runs the exact browser code path the user sees.
//
//   node tools/paddock-verify.mjs
//
// Env: SF_VERIFY_SECONDS (20), SF_VERIFY_WIDTH/HEIGHT (1280x720), SF_VERIFY_URL
// (auto vite), SF_VERIFY_OUT (.data/paddock), SF_VERIFY_RIDE (0), CHROME_BIN,
// SF_VERIFY_MP4 (0 -> set 1 to also encode a video).

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = Number(process.env.SF_VERIFY_WIDTH ?? 1280);
const HEIGHT = Number(process.env.SF_VERIFY_HEIGHT ?? 720);
const SECONDS = Number(process.env.SF_VERIFY_SECONDS ?? 20);
const RIDE = process.env.SF_VERIFY_RIDE === "1";
const GAIT = process.env.SF_VERIFY_GAIT ? Number(process.env.SF_VERIFY_GAIT) : null; // force all horses to one gait speed (Froude)
const MP4 = process.env.SF_VERIFY_MP4 === "1";
const DT = 1 / 60;
const TICKS = Math.round(SECONDS / DT);
const SERVER_URL = process.env.SF_VERIFY_URL ?? "http://127.0.0.1:5188";
const OUT_DIR = process.env.SF_VERIFY_OUT ? path.resolve(ROOT, process.env.SF_VERIFY_OUT) : path.join(ROOT, ".data", "paddock");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); }
  throw new Error(`timeout ${label}: ${url}`);
}
async function startDevIfNeeded() {
  try { await waitHttp(SERVER_URL, 2000, "existing vite"); return null; } catch {}
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port || 5188);
  console.log(`[verify] starting Vite at ${SERVER_URL}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
}

class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) return;
      const p = this.#p.get(m.id); if (!p) return;
      this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { this.#ws.close(); }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
async function waitEv(c, expr, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (await ev(c, expr)) return; } catch {} await sleep(250); }
  throw new Error(`timeout ${label}`);
}
const tickExpr = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const dev = await startDevIfNeeded();
  const chromePath = await findChrome();
  const dport = await freePort();
  const url = `${SERVER_URL}/?autostart=1&fullfps=1`;
  console.log(`[verify] ${WIDTH}x${HEIGHT}, ${SECONDS}s (${TICKS} ticks) ride=${RIDE} -> ${url}`);
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT_DIR, "chrome")}`,
    "--headless=new", "--no-first-run", "--mute-audio",
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    `--window-size=${WIDTH},${HEIGHT}`, "--force-device-scale-factor=1", "about:blank"
  ], { stdio: "ignore" });

  let client;
  const samples = []; // {t, states:[{upY,tall,down,fallen,speed}]}
  try {
    const t0 = Date.now();
    let ver;
    while (Date.now() - t0 < 15000) { try { ver = await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    if (!ver) throw new Error("no CDP");
    const page = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    client = new Cdp(page.webSocketDebuggerUrl);
    await client.open();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await client.send("Page.navigate", { url });

    await waitEv(client, "Boolean(window.__sf && window.__sf.horseHerd && window.__sf.teleportToTarget && window.__sfManual)", 120000, "app boot");
    // hand us the clock, teleport to the paddock, let tiles + herd settle
    await ev(client, "window.__sfManual(true); true");
    const nHorses = await ev(client, "window.__sf.horseHerd.debugStates().length");
    await ev(client, "(()=>{const c=window.__sf.horseHerd.paddockCenter; window.__sf.teleportToTarget(c.x, c.z, 'Horse Paddock'); return true;})()");
    for (let i = 0; i < 40; i++) { await ev(client, tickExpr(0)); await sleep(40); }
    if (RIDE) await ev(client, "(()=>{const n=window.__sf.horseHerd.nearest(window.__sf.player.position.x, window.__sf.player.position.z, 60); if(n>=0) window.__sf.horseHerd.mount(n); return n;})()");
    if (GAIT != null) await ev(client, `window.__sf.horseHerd.debugForceSpeed(${GAIT}); true`);
    console.log(`[verify] ${nHorses} horses; running ${SECONDS}s… ${GAIT != null ? `(forced gait ${GAIT})` : ""}`);

    let shot = 0;
    for (let i = 0; i < TICKS; i++) {
      await ev(client, tickExpr(DT));
      if (i % 6 === 0) { // ~10 Hz state sampling
        const states = await ev(client, "window.__sf.horseHerd.debugStates()");
        samples.push({ t: +(i * DT).toFixed(2), states });
      }
      if (i % 30 === 0) { // ~2 Hz screenshots
        const s = await client.send("Page.captureScreenshot", { format: "jpeg", quality: 82, fromSurface: true });
        writeFileSync(path.join(OUT_DIR, `frame_${String(shot).padStart(4, "0")}.jpg`), Buffer.from(s.data, "base64"));
        shot++;
      }
      if (i % 300 === 0) console.log(`[verify]   ${(i * DT).toFixed(0)}/${SECONDS}s`);
    }
  } finally {
    client?.close();
    chrome.kill("SIGTERM");
    dev?.kill("SIGTERM");
  }

  // ---- analysis: ground truth from the browser sim ----
  const n = samples[0]?.states.length ?? 0;
  const everFell = new Array(n).fill(false);
  const minUp = new Array(n).fill(1);
  const tallSum = new Array(n).fill(0);
  const upSum = new Array(n).fill(0);
  const spdSum = new Array(n).fill(0);
  let cnt = 0;
  // skip the first 2s (settle) in the aggregate
  const warm = samples.filter((s) => s.t >= 2);
  for (const s of warm) {
    cnt++;
    s.states.forEach((h, k) => {
      if (h.upY < 0.35 && h.down === 0) everFell[k] = true; // tipped over while under control (not the deliberate 10s lie)
      minUp[k] = Math.min(minUp[k], h.upY);
      tallSum[k] += h.tall;
      upSum[k] += h.upY;
      spdSum[k] += h.speed;
    });
  }
  const perHorse = Array.from({ length: n }, (_, k) => ({
    fell: everFell[k], minUp: +minUp[k].toFixed(2), meanTall: +(tallSum[k] / Math.max(1, cnt)).toFixed(2), meanUp: +(upSum[k] / Math.max(1, cnt)).toFixed(2), meanSpeed: +(spdSum[k] / Math.max(1, cnt)).toFixed(2)
  }));
  const nFell = perHorse.filter((h) => h.fell).length;
  const meanTall = +(perHorse.reduce((a, h) => a + h.meanTall, 0) / Math.max(1, n)).toFixed(2);
  const meanUp = +(perHorse.reduce((a, h) => a + h.meanUp, 0) / Math.max(1, n)).toFixed(2);
  const meanSpeed = +(perHorse.reduce((a, h) => a + h.meanSpeed, 0) / Math.max(1, n)).toFixed(2);
  const summary = { horses: n, fell: nFell, fellPct: Math.round((nFell / Math.max(1, n)) * 100), meanTall, meanUp, meanSpeed, seconds: SECONDS, ride: RIDE };
  writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify({ summary, perHorse, samples }, null, 1));

  if (MP4) {
    try {
      await new Promise((res, rej) => { const c = spawn("ffmpeg", ["-y", "-framerate", "12", "-i", path.join(OUT_DIR, "frame_%04d.jpg"), "-vf", "format=yuv420p", "-c:v", "libx264", "-crf", "20", path.join(OUT_DIR, "paddock.mp4")], { stdio: "ignore" }); c.once("exit", (code) => (code === 0 ? res() : rej(new Error("ffmpeg " + code)))); });
      console.log(`[verify] video -> ${path.relative(ROOT, path.join(OUT_DIR, "paddock.mp4"))}`);
    } catch (e) { console.log("[verify] mp4 encode skipped:", e.message); }
  }

  console.log(`\n[verify] === GROUND TRUTH (browser sim) ===`);
  console.log(`[verify] ${n} horses | FELL ${nFell} (${summary.fellPct}%) | meanTall ${meanTall} | meanUp ${meanUp} | meanSpeed ${meanSpeed} m/s`);
  console.log(`[verify] frames + summary.json in ${path.relative(ROOT, OUT_DIR)}`);
  const PASS = nFell === 0 && meanTall > 0.72 && meanUp > 0.7;
  console.log(PASS ? "[verify] PASS — no horse tipped over in-world" : `[verify] FAIL — ${nFell}/${n} tipped over in-world`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
