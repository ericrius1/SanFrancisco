// Isolated GPU cost of the Exploratorium exhibits, with the CAMERA HELD FIXED so
// the rendered view is identical in both states — only the exhibit toggles.
//
// Room gating follows the PLAYER, not the camera. So we pin a free-cam framing an
// exhibit, then teleport the PLAYER between that room (sims live: compute on,
// sprites drawn) and the lobby (same building, sims setActive(false): compute off,
// sprites hidden). The frame-ms delta at the identical viewpoint is the true
// marginal cost of that live exhibit. Timed with a GPU fence (onSubmittedWorkDone),
// which also catches FluidSim's own direct queue.submit.
//
//   node tools/exploratorium-isolate-probe.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/explo-perf");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5196";
const W = 900, H = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CX = 4084.7, CZ = -1271.5, YAW = -2.523, FLOOR = 3.78;
const COS = Math.cos(YAW), SIN = Math.sin(YAW);
const pierWorld = (u, v) => ({ x: CX + u * COS + v * SIN, z: CZ - u * SIN + v * COS });
const eye3 = (u, v, y) => { const p = pierWorld(u, v); return [p.x, y, p.z]; };

const LOBBY = pierWorld(108, 0); // sims-off spot, same building (group stays visible)

// Each case: a fixed cam framing the exhibit, the in-room player spot that turns it on.
const CASES = [
  {
    name: "WATER: SPH 48k tank + ripple pool",
    eye: eye3(-20, -20.5, FLOOR + 2.6), tgt: eye3(-20, -28.72, FLOOR + 2.1),
    player: pierWorld(-20, -21.7), room: "water"
  },
  {
    name: "GALLERY: sand 5k + star table 14k",
    eye: eye3(92, 2, FLOOR + 6.5), tgt: eye3(48, -6, FLOOR + 1.2),
    player: pierWorld(50, -8), room: "gallery"
  }
];

async function isFile(p) { try { return existsSync(p); } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue; return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); } throw new Error(`timeout ${label}: ${url}`); }
async function startDevIfNeeded() {
  try { await waitHttp(SERVER_URL, 2500, "existing vite"); return null; } catch {}
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port);
  console.log(`[probe] starting Vite at ${SERVER_URL}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"] });
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
}
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (!m.id) { if (this.onEvent) this.onEvent(m); return; } const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {}); });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { this.#ws.close(); }
}
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`); return r.result?.value; }

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [`--user-data-dir=${path.join(OUT, "chrome2")}`, "--headless=new", `--remote-debugging-port=${port}`, "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal", "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);
  let page;
  for (let i = 0; i < 60; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl); if (page) break; } catch {} await sleep(400); }
  if (!page) throw new Error("no app page target");
  const c = new Cdp(page.webSocketDebuggerUrl);
  c.onEvent = (m) => { if (m.method === "Runtime.exceptionThrown") { const d = m.params.exceptionDetails; console.log("[page-exception]", (d.exception && (d.exception.description || d.exception.value)) || d.text); } };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for __sf.exploratorium...");
  const t0 = Date.now(); let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.exploratorium&&window.__sf.player&&window.__sf.renderer.backend.device)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf.exploratorium never ready");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);

  const settle = async (n) => { for (let i = 0; i < n; i++) await ev(c, `window.__sf.tick(${1 / 60})`); };
  const tp = async (x, z) => ev(c, `(()=>{const p=window.__sf.player;p.teleportTo({x:${x},y:${FLOOR + 1.2},z:${z},facing:0,mode:'walk'});return true;})()`);
  const state = async () => ev(c, `(()=>{const s=window.__sf.exploratorium.state();return {room:s.room,inside:s.inside,sph:s.dispatches.sph,sand:s.dispatches.sand,stars:s.dispatches.stars,pool:s.dispatches.pool};})()`);
  const setCam = async (eye, tgt) => ev(c, `window.__sfFreeCam([${eye.join(",")}],[${tgt.join(",")}]);true`);
  // GPU-fenced timer; N frames, median/mean/p90 ms
  const time = async (n) => ev(c, `(async()=>{const dev=window.__sf.renderer.backend.device;const ts=[];for(let i=0;i<${n};i++){const a=performance.now();window.__sf.tick(${1 / 60});await dev.queue.onSubmittedWorkDone();ts.push(performance.now()-a);}ts.sort((x,y)=>x-y);return {med:+ts[ts.length>>1].toFixed(3),mean:+(ts.reduce((s,x)=>s+x,0)/ts.length).toFixed(3),p90:+ts[Math.floor(ts.length*0.9)].toFixed(3)};})()`);
  const dispDelta = async (n) => { const b = await state(); await ev(c, `window.__explo_run=async(k)=>{for(let i=0;i<k;i++)window.__sf.tick(${1 / 60});}`); }; // (unused helper placeholder)

  const results = [];
  for (const cs of CASES) {
    console.log(`\n########## ${cs.name} ##########`);
    // warm the room once so lazy sim construction (SPH buffers/pipelines) is paid before timing
    await tp(cs.player.x, cs.player.z); await settle(120);
    await setCam(cs.eye, cs.tgt); await settle(20);

    // ---- STATE A: exhibit LIVE (player in room) ----
    const sA0 = await state();
    const perfA = await time(80);
    const sA1 = await state();
    const dispA = { sph: sA1.sph - sA0.sph, sand: sA1.sand - sA0.sand, stars: sA1.stars - sA0.stars, pool: sA1.pool - sA0.pool };

    // ---- STATE B: exhibit IDLE (player in lobby, SAME fixed cam) ----
    await tp(LOBBY.x, LOBBY.z); await settle(40); // leaving the room fires setActive(false)
    const sB0 = await state();
    const perfB = await time(80);
    const sB1 = await state();
    const dispB = { sph: sB1.sph - sB0.sph, sand: sB1.sand - sB0.sand, stars: sB1.stars - sB0.stars, pool: sB1.pool - sB0.pool };

    const cost = +(perfA.med - perfB.med).toFixed(3);
    results.push({ name: cs.name, active: { room: sA0.room, perf: perfA, disp: dispA }, idle: { room: sB0.room, perf: perfB, disp: dispB }, costMs: cost });

    console.log(`  ACTIVE (player in ${sA0.room}):  ${perfA.med} ms med   dispatches/80f sph=${dispA.sph} sand=${dispA.sand} stars=${dispA.stars} pool=${dispA.pool}`);
    console.log(`  IDLE   (player in ${sB0.room}):  ${perfB.med} ms med   dispatches/80f sph=${dispB.sph} sand=${dispB.sand} stars=${dispB.stars} pool=${dispB.pool}`);
    console.log(`  >>> isolated exhibit cost (same fixed view): ${cost} ms/frame`);
    // release cam for next case
    await ev(c, `window.__sfFreeCam(null);true`);
  }

  console.log("\n\n===================== ISOLATED EXHIBIT COST (fixed camera) =====================");
  for (const r of results) {
    console.log(`  ${r.name}`);
    console.log(`     live=${r.active.perf.med}ms  idle=${r.idle.perf.med}ms   ->  +${r.costMs} ms/frame while you're in the room`);
  }
  writeFileSync(path.join(OUT, "isolate.json"), JSON.stringify(results, null, 2));
  console.log(`\n[probe] wrote ${path.join(OUT, "isolate.json")}`);

  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
