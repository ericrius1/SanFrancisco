// Headless render probe for the Corona Heights summit crags. Boots the app in
// headless Chrome (WebGPU via ANGLE-metal), pins the clock, walks a set of
// summit viewpoints and screenshots each so the chert crags can be iterated on
// visually. Also sanity-checks that the crag meshes exist and that the hero
// crag's collider answers raycasts (paint / grab / walker parity).
//
//   node tools/corona-summit-probe.mjs
// Env:
//   SF_PROBE_OUT  out dir (default .data/corona-summit-probe)
//   SF_PROBE_URL  existing vite (default http://127.0.0.1:5190)
//   SF_TIME       time of day hours (default 13.5; also try 17.8 golden hour)
//   SF_VIEWS      comma list of view names to render (default all)

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/corona-summit-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5190";
const TIME = Number(process.env.SF_TIME ?? 13.5);
const ONLY = (process.env.SF_VIEWS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// viewpoints: [name, x, z, facing(rad), backDist, upHeight].
// world frame: +x=east, -x=west, -z=north, +z=south.
// facing: dx=sin(f), dz=cos(f) — the eye is pulled `back` behind the target.
const VIEWS = [
  // The cinematic: from the platform SW corner, past the main crag, downtown behind.
  ["classic_ne", 412, 2748, 2.3, 22, 6],
  // Straight-on portrait of the main crag's south face from the platform.
  ["crag_portrait", 412, 2748, Math.PI, 10, 2.6],
  // Along the bedding spine: NW mass in front, main crag behind.
  ["spine_se", 403.5, 2740.5, 0.79, 16, 5],
  // Wide aerial of the whole summit treatment.
  ["platform_wide", 412, 2760, 2.0, 34, 14],
  // Walker's reveal arriving from the south approach.
  ["south_arrival", 408, 2775, Math.PI, 20, 3]
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
  activeCdp = null;
  chromeProc = null;
  ownedDev = null;
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

async function checkSummitAssets(c) {
  const stats = await ev(c, `(()=>{
    const scene = window.__sf.scene;
    const names = ["corona_summit_chert_crags", "corona_summit_platform", "corona_summit_scree"];
    const out = {};
    for (const n of names) {
      const m = scene.getObjectByName(n);
      out[n] = m ? (m.geometry.getAttribute("position")?.count ?? 0) : -1;
    }
    const scree = scene.getObjectByName("corona_summit_scree");
    out.screeCount = scree ? scree.count : -1;
    return out;
  })()`);
  console.log("[probe] summit assets:", JSON.stringify(stats));
  for (const [k, v] of Object.entries(stats)) {
    if (v === -1) throw new Error(`missing summit object: ${k}`);
    if (v === 0) throw new Error(`empty geometry: ${k}`);
  }
  // Hero crag collider: a level ray from the platform toward the main crag must
  // hit the query world well before the crag centre (i.e. the box is there).
  const ray = await ev(c, `(()=>{
    const m = window.__sf.map; const T = window.__sf.THREE;
    const gy = m.groundTop(412, 2756);
    const hit = window.__sf.physics.raycastWorld(new T.Vector3(412, gy + 1.2, 2756), new T.Vector3(0, 0, -1), 12);
    return hit ? { d: hit.point.distanceTo(new T.Vector3(412, gy + 1.2, 2756)), kind: hit.kind } : null;
  })()`);
  console.log("[probe] hero collider ray:", JSON.stringify(ray));
  if (!ray || ray.d > 8.5) throw new Error(`hero crag collider missing or too far: ${JSON.stringify(ray)}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  ownedDev = dev;
  const chrome = await findChrome();
  const port = await freePort();
  const profile = path.join(OUT, "chrome");
  const proc = spawn(chrome, [
    `--user-data-dir=${profile}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`
  ], { cwd: ROOT, stdio: "ignore" });
  chromeProc = proc;
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
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${TIME});return true;})()`);
  await settle(c, 12);

  await checkSummitAssets(c);

  let consecutiveFails = 0;
  let failedViews = 0;
  for (const [name, x, z, facing, back, up] of VIEWS) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    try {
      await teleport(c, x, z, facing);
      await settle(c, 16); // stream tiles + colliders + hero foliage
      await teleport(c, 340, 2840, facing); // park the avatar downslope, out of frame
      await settle(c, 2);
      const eye = await freeCam(c, x, z, facing, back, up);
      await settleCamera(c, eye);
      await ev(c, `window.__sf.sky.setTimeOfDay(${TIME})`);
      for (let i = 0; i < 8; i++) await tick(c, 1 / 30);
      const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
      writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(shot.data, "base64"));
      console.log(`[probe] shot ${name}`);
      consecutiveFails = 0;
    } catch (e) {
      failedViews++;
      console.log(`[view-fail] ${name}: ${String(e).slice(0, 140)}`);
      if (++consecutiveFails >= 2) { console.log("[probe] tab unstable, stopping early"); break; }
    }
  }
  console.log(`[probe] screenshots in ${OUT}`);
  cleanup();
  if (failedViews > 0) throw new Error(`${failedViews} summit view(s) failed`);
  process.exit(0);
}
main().catch((e) => { cleanup(); console.error("[probe] FAIL", e); process.exit(1); });
