// Headless render probe for the marine-layer fog. Boots the app in headless
// Chrome (WebGPU via ANGLE-metal), freezes the wall clock, teleports to a set of
// fog-showcase viewpoints across the city, and screenshots each so the fog can be
// iterated on visually.
//
//   node tools/fog-probe.mjs
// Env:
//   SF_PROBE_OUT  out dir (default .data/fog-probe)
//   SF_PROBE_URL  existing vite (default http://127.0.0.1:5190)
//   SF_TIME       time of day hours (default 13.5; also try 17.8 golden hour)
//   SF_FOG        JSON of WORLD_TUNING fog overrides, e.g. '{"fog":0.0007,"fogBank":2}'
//   SF_VIEWS      comma list of view names to render (default all)
//   SF_MOTION_SECONDS  optional second capture after this simulated duration

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/fog-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5190";
const TIME = Number(process.env.SF_TIME ?? 13.5);
const FOG = process.env.SF_FOG ?? "";
const MOTION_SECONDS = Math.max(0, Number(process.env.SF_MOTION_SECONDS ?? 0));
const ONLY = (process.env.SF_VIEWS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// viewpoints: [name, x, z, facing(rad), backDist, upHeight].
// world frame: +x=east, -x=west, -z=north, +z=south.
// facing: dx=sin(f), dz=cos(f) — the eye is pulled `back` behind the target.
const E = Math.PI / 2, N = Math.PI, S = 0, NE = 2.36, SE = 0.79;
const VIEWS = [
  // Ocean Beach / outer Sunset coast, looking east into the city — must fog out.
  ["oceanbeach_east", -3500, 1400, 1.95, 60, 55],
  // Sunset district valley, low, looking north up toward the Presidio/Gate.
  ["sunset_valley", -2600, 1200, N, 45, 22],
  // Twin Peaks overlook (high) looking north over the fogged basin toward downtown.
  ["twinpeaks_north", -560, 4060, 2.2, 130, 120],
  // Golden Gate bridge deck looking south over the Presidio.
  ["gg_presidio", -2982, -2600, 0.4, 120, 70],
  // Marin headlands (north) looking south at the Gate + city behind fog.
  ["marin_south", -2760, -4200, 0.15, 200, 130],
  // Downtown looking west — near streets clear, hills/west melting into haze.
  ["downtown_west", 3400, 100, 4.6, 90, 60],
  // Coit Tower hill looking west/southwest across the city toward the fog wall.
  ["coit_westward", 3366, -1405, 4.0, 120, 90]
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
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(0)); await sleep(60); } }
async function settleWorld(c) {
  let idleFrames = 0;
  for (let i = 0; i < 240; i++) {
    // A small real simulation step is required: some citygen follow-up batches
    // intentionally drain from update(), not from render-only dt=0 frames.
    await tick(c, 1 / 30);
    const [cityReady, tileBusy, pending, waiting] = await ev(c,
      `[!!window.__sf.citygenRing.current,window.__sf.tiles.busy,window.__sf.scheduler.pending,window.__sf.scheduler.waiting]`);
    idleFrames = cityReady && tileBusy === 0 && pending - waiting <= 0 ? idleFrames + 1 : 0;
    // Require a minimum drain window as citygen can enqueue a follow-up batch
    // immediately after the tile ring itself reports idle.
    if (i >= 60 && idleFrames >= 20) return;
    await sleep(50);
  }
  throw new Error("world streaming never reached a stable idle state");
}
async function teleport(c, x, z, facing) {
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:${facing},mode:'walk'});return true;})()`);
}
async function freeCam(c, x, z, facing, back, up) {
  return ev(c, `(()=>{const m=window.__sf.map;const gy=m.groundHeight(${x},${z});
    const dx=Math.sin(${facing}),dz=Math.cos(${facing});
    const eye=[${x}-dx*${back}, gy+${up}, ${z}-dz*${back}];
    window.__sfFreeCam(eye,[${x}+dx*60, gy+${Math.max(4, up * 0.35)}, ${z}+dz*60]);return eye;})()`);
}
async function settleCamera(c, eye) {
  for (let i = 0; i < 180; i++) {
    await tick(c, 0);
    const p = await ev(c, `[window.__sf.camera.position.x,window.__sf.camera.position.y,window.__sf.camera.position.z]`);
    if (Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) < 0.05) return;
    await sleep(50);
  }
  throw new Error("free camera never acquired the render pose");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const profile = path.join(OUT, "chrome");
  const proc = spawn(chrome, [
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
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      console.log("[page-exception]", (d.exception && (d.exception.description || d.exception.value)) || d.text);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      console.log("[page-error]", m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300));
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.player)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready (see [page-exception]/[page-error] above)");
  console.log(`[probe] __sf ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`); // freeze wall clock

  // stop the day/night cycle and pin the time so screenshots are comparable
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${TIME});return true;})()`);
  // apply fog param overrides live
  if (FOG) {
    await ev(c, `(()=>{const v=window.__sf.WORLD_TUNING.values;Object.assign(v,${FOG});window.__sf.sky.applyFogParams();return true;})()`);
    console.log("[probe] fog overrides:", FOG);
  }
  await settle(c, 12);

  let fails = 0;
  for (const [name, x, z, facing, back, up] of VIEWS) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    try {
      await teleport(c, x, z, facing);
      await settle(c, 16); // stream tiles + colliders + hero foliage
      const eye = await freeCam(c, x, z, facing, back, up);
      await settleCamera(c, eye); // also waits out any covered late-warmup frames
      // keep time pinned (settle ticks with dt=0 don't advance, but be safe)
      await ev(c, `window.__sf.sky.setTimeOfDay(${TIME})`);
      for (let i = 0; i < 8; i++) await tick(c, 1 / 30); // let fog drift settle a bit
      if (MOTION_SECONDS > 0) await settleWorld(c); // finish streaming before the timed A/B pair
      const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88, fromSurface: true });
      writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(shot.data, "base64"));
      console.log(`[probe] shot ${name}`);
      if (MOTION_SECONDS > 0) {
        // Advance a deterministic 30 fps interval. The fog reads the app's
        // elapsed seconds, so this measures its true motion without letting a
        // chase/cinematic controller contaminate the fixed-camera comparison.
        const motionFrames = Math.max(1, Math.round(MOTION_SECONDS * 30));
        for (let i = 0; i < motionFrames; i++) await tick(c, 1 / 30);
        const movedEye = await freeCam(c, x, z, facing, back, up);
        await settleCamera(c, movedEye);
        await ev(c, `window.__sf.sky.setTimeOfDay(${TIME})`);
        for (let i = 0; i < 4; i++) await tick(c, 1 / 30);
        const moved = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88, fromSurface: true });
        writeFileSync(path.join(OUT, `${name}_motion.jpg`), Buffer.from(moved.data, "base64"));
        console.log(`[probe] shot ${name} +${MOTION_SECONDS}s`);
      }
      fails = 0;
    } catch (e) {
      console.log(`[view-fail] ${name}: ${String(e).slice(0, 140)}`);
      if (++fails >= 2) { console.log("[probe] tab unstable, stopping early"); break; }
    }
  }
  console.log(`[probe] screenshots in ${OUT}`);
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
