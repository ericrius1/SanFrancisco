// Headless render probe for the busker trio (src/gameplay/buskers/). Boots the
// app in headless Chrome (WebGPU via ANGLE-metal), pins the clock, drives the
// trio's transport to characteristic song moments (strum, handpan groove,
// flute phrase, wind rest) and screenshots each so the figures/instruments/
// animation can be iterated on visually. Also sanity-checks assembly (three
// musicians + platform), transport progress, and phase transitions.
//
//   node tools/buskers-probe.mjs
// Env:
//   SF_PROBE_OUT  out dir (default .data/buskers-probe)
//   SF_PROBE_URL  existing vite (default http://127.0.0.1:5191)
//   SF_TIME       time of day hours (default 15.0)
//   SF_VIEWS      comma list of view names (default all)

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/buskers-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5191";
const TIME = Number(process.env.SF_TIME ?? 15.0);
const ONLY = (process.env.SF_VIEWS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Views are trio-relative: eye = focusPoint + front*dist + right*lateral + up.
// focus "group" = platform centre; otherwise a musician's seat.
// seekBeat drives the transport there before the shot (null = leave alone);
// afterSeconds ticks that much extra time (e.g. into the rest phase).
const VIEWS = [
  // the establishing shot: whole act, mid-groove, everyone playing
  { name: "wide_front", focus: "group", dist: 7.5, lateral: 0.8, up: 1.6, targetUp: 0.9, seekBeat: 22.0 },
  { name: "trio_close", focus: "group", dist: 4.6, lateral: -0.6, up: 1.1, targetUp: 0.95, seekBeat: 42.05 },
  { name: "ukulelist_portrait", focus: "ukulele", dist: 2.4, lateral: 0.7, up: 0.55, targetUp: 0.45, seekBeat: 22.02 },
  { name: "handpanist_portrait", focus: "handpan", dist: 2.4, lateral: -0.6, up: 0.6, targetUp: 0.4, seekBeat: 21.77 },
  { name: "flutist_portrait", focus: "flute", dist: 2.4, lateral: -0.75, up: 0.6, targetUp: 0.5, seekBeat: 38.1 },
  // legs over the edge, from below the front lip
  { name: "dangling_legs", focus: "group", dist: 3.4, lateral: 0, up: -0.1, targetUp: 0.35, seekBeat: 10.0 },
  // song over: instruments down, wind idle
  { name: "rest_wind", focus: "group", dist: 5.0, lateral: 1.2, up: 1.3, targetUp: 0.9, seekBeat: 67.9, afterSeconds: 4 },
  // count-in nod moment
  { name: "countin", focus: "handpan", dist: 2.6, lateral: 0.4, up: 0.7, targetUp: 0.45, seekBeat: 67.9, afterSeconds: 13.5 }
];

async function isFile(p) { try { return existsSync(p); } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
}
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); }
  throw new Error(`timeout ${label}: ${url}`);
}
async function startDevIfNeeded() {
  try { await waitHttp(SERVER_URL, 2500, "existing vite"); return null; } catch {}
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port);
  console.log(`[probe] starting Vite at ${SERVER_URL}`);
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
      if (!m.id) { if (this.onEvent) this.onEvent(m); return; }
      const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { this.#ws.close(); }
}
let ownedDev = null;
let chromeProc = null;
let activeCdp = null;
function cleanup() {
  try { activeCdp?.close(); } catch {}
  try { chromeProc?.kill(); } catch {}
  try { ownedDev?.kill(); } catch {}
  activeCdp = null; chromeProc = null; ownedDev = null;
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(0)); await sleep(60); } }
async function teleport(c, x, z, facing) {
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:${facing},mode:'walk'});return true;})()`);
}

/** advance the trio's transport `seconds` in fixed 30 Hz steps (batched in-page) */
async function advance(c, seconds) {
  const steps = Math.ceil(seconds * 30);
  await ev(c, `(async()=>{for(let i=0;i<${steps};i++){window.__sf.tick(1/30);}await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`);
}

async function checkAssembly(c) {
  const stats = await ev(c, `(()=>{
    const b = window.__sf.buskers;
    if (!b) return { missing: true };
    let meshes = 0;
    b.group.traverse((o) => { if (o.isMesh) meshes++; });
    const beat0 = b.clock.beat;
    window.__sf.tick(1/30); window.__sf.tick(1/30);
    return {
      children: b.group.children.length,
      meshes,
      phase: b.clock.phase,
      beatAdvances: b.clock.beat !== beat0 || b.clock.phase !== "playing",
      pos: [b.group.position.x.toFixed(1), b.group.position.y.toFixed(1), b.group.position.z.toFixed(1)]
    };
  })()`);
  console.log("[probe] assembly:", JSON.stringify(stats));
  if (stats.missing) throw new Error("__sf.buskers missing");
  if (stats.children < 4) throw new Error(`expected platform + 3 musicians, got ${stats.children} children`);
  if (stats.meshes < 30) throw new Error(`suspiciously few meshes (${stats.meshes}) — musicians missing?`);
  // phase machine sanity: seek to the last beat, run 1s → rest
  const phases = await ev(c, `(()=>{
    const b = window.__sf.buskers;
    b.seek(67.9);
    const seen = [b.clock.phase];
    for (let i = 0; i < 30 * 14; i++) { window.__sf.tick(1/30); const p = b.clock.phase; if (seen[seen.length-1] !== p) seen.push(p); }
    return seen;
  })()`);
  console.log("[probe] phase walk:", JSON.stringify(phases));
  if (phases[0] !== "playing" || !phases.includes("rest")) throw new Error(`phase machine broken: ${phases}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  ownedDev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const profile = path.join(OUT, "chrome");
  chromeProc = spawn(chrome, [
    `--user-data-dir=${profile}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`
  ], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);
  let page;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) throw new Error("no app page target");
  const c = new Cdp(page.webSocketDebuggerUrl);
  activeCdp = c;
  const pageErrors = [];
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      pageErrors.push(msg);
      console.log("[page-exception]", String(msg).slice(0, 300));
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const msg = m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300);
      pageErrors.push(msg);
      console.log("[page-error]", msg);
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.player&&window.__sf.buskers)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf (or __sf.buskers) never ready — see [page-exception] above");
  console.log(`[probe] __sf ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${TIME});return true;})()`);
  await settle(c, 12);

  // stream tiles near the trio, then park the avatar out of frame downslope
  await teleport(c, 408, 2744, -Math.PI / 4);
  await settle(c, 16);
  await checkAssembly(c);
  await teleport(c, 340, 2840, Math.PI);
  await settle(c, 2);

  let failedViews = 0;
  for (const v of VIEWS) {
    if (ONLY.length && !ONLY.includes(v.name)) continue;
    try {
      if (v.seekBeat != null) await ev(c, `(window.__sf.buskers.seek(${v.seekBeat}), true)`);
      if (v.afterSeconds) await advance(c, v.afterSeconds);
      const eye = await ev(c, `(()=>{
        const T = window.__sf.THREE, b = window.__sf.buskers;
        const front = new T.Vector3(0, 0, -1).applyQuaternion(b.group.quaternion);
        const right = new T.Vector3(1, 0, 0).applyQuaternion(b.group.quaternion);
        const focus = ${v.focus === "group"
          ? "b.group.position.clone().add(new T.Vector3(0, 0.62, 0))"
          : `b.seatWorld("${v.focus}")`};
        const eye = focus.clone().addScaledVector(front, ${v.dist}).addScaledVector(right, ${v.lateral}).add(new T.Vector3(0, ${v.up}, 0));
        const tgt = focus.clone().add(new T.Vector3(0, ${v.targetUp}, 0));
        window.__sfFreeCam([eye.x, eye.y, eye.z], [tgt.x, tgt.y, tgt.z]);
        return [eye.x, eye.y, eye.z];
      })()`);
      for (let i = 0; i < 180; i++) {
        await tick(c, 0);
        const p = await ev(c, `[window.__sf.camera.position.x,window.__sf.camera.position.y,window.__sf.camera.position.z]`);
        if (Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) < 0.05) break;
        await sleep(40);
      }
      for (let i = 0; i < 6; i++) await tick(c, 1 / 240); // tiny advance: keeps the pose at the seeked moment
      const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
      writeFileSync(path.join(OUT, `${v.name}.jpg`), Buffer.from(shot.data, "base64"));
      console.log(`[probe] shot ${v.name}`);
    } catch (e) {
      failedViews++;
      console.log(`[view-fail] ${v.name}: ${String(e).slice(0, 140)}`);
    }
  }
  console.log(`[probe] screenshots in ${OUT}`);
  const trioErrors = pageErrors.filter((e) => /busker|flut|ukul|handpan/i.test(String(e)));
  cleanup();
  if (trioErrors.length) throw new Error(`trio page errors: ${trioErrors[0]}`);
  if (failedViews > 0) throw new Error(`${failedViews} view(s) failed`);
  process.exit(0);
}
main().catch((e) => { cleanup(); console.error("[probe] FAIL", e); process.exit(1); });
