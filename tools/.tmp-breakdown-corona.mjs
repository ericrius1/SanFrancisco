// Per-system CPU breakdown, zero source edits: wraps the update() method of
// every system object exposed on window.__sf (plus pipeline.render and
// player.update) with performance.now() accumulators, drives ticks by hand,
// and dumps ms/frame per system. Also grabs renderer.info draw calls/triangles
// (autoReset off) so GPU pressure can be correlated.
//
//   node tools/perf-breakdown-probe.mjs
// Env: SF_PROBE_URL (default fresh vite on 5197), CHROME_BIN, SF_W/SF_H

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/perf-breakdown");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5197";
const W = Number(process.env.SF_W ?? 2560), H = Number(process.env.SF_H ?? 1600);
const FRAMES = 240;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STOPS = [
  { name: "corona-summit", x: 398, z: 2752, facing: 0.0, mode: "walk" },
  { name: "corona-park", x: 340, z: 2650, facing: 2.4, mode: "walk" }
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
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`,
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
    if (m.method === "Runtime.exceptionThrown") console.log("[page-exception]", JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for app boot...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("app never ready");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);

  // Install wrappers: every __sf.<key> object with a .update function gets timed.
  await ev(c, `(()=>{
    const sf = window.__sf;
    const acc = window.__acc = {};
    const wrap = (obj, key, name) => {
      const fn = obj[key];
      if (typeof fn !== "function" || fn.__wrapped) return;
      const w = function(...args){ const a=performance.now(); const r=fn.apply(this,args); acc[name]=(acc[name]??0)+(performance.now()-a); return r; };
      w.__wrapped = true;
      obj[key] = w;
    };
    for (const k of Object.keys(sf)) {
      const v = sf[k];
      if (v && typeof v === "object" && typeof v.update === "function") wrap(v, "update", k);
    }
    if (sf.pipeline && typeof sf.pipeline.render === "function") wrap(sf.pipeline, "render", "RENDER(pipeline)");
    if (sf.player && typeof sf.player.update === "function") wrap(sf.player, "update", "player");
    if (sf.chase && typeof sf.chase.update === "function") wrap(sf.chase, "update", "chase");
    if (sf.citygenRing && sf.citygenRing.current && typeof sf.citygenRing.current.update === "function") wrap(sf.citygenRing.current, "update", "citygenRing");
    if (sf.net && typeof sf.net.sendState === "function") wrap(sf.net, "sendState", "net.sendState");
    if (sf.physics && sf.physics.world && typeof sf.physics.world.step === "function") wrap(sf.physics.world, "step", "physics.step");
    if (sf.physics && typeof sf.physics.step === "function") wrap(sf.physics, "step", "physics.step");
    // renderer info: keep counts
    sf.renderer.info.autoReset = false;
    return Object.keys(acc);
  })()`);

  const results = [];
  for (const stop of STOPS) {
    await ev(c, `(()=>{const sf=window.__sf;const gy=sf.map.groundHeight(${stop.x},${stop.z});sf.player.teleportTo({x:${stop.x},y:gy+1.6,z:${stop.z},facing:${stop.facing},mode:'${stop.mode}'});return true;})()`);
    // settle until the streamed world is actually resident: run fence-yielded
    // ticks and wait for the per-frame draw count to plateau (tiles, citygen,
    // foliage all stream on async loaders — a synchronous tick burst loads nothing)
    let lastDraws = -1;
    for (let k = 0; k < 40; k++) {
      const d = await ev(c, `(async()=>{
        const sf = window.__sf; const dev = sf.renderer.backend.device;
        for (let i=0;i<30;i++){ sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); }
        sf.renderer.info.reset(); sf.tick(1/60); await dev.queue.onSubmittedWorkDone();
        return sf.renderer.info.render.drawCalls ?? sf.renderer.info.render.calls ?? 0;
      })()`);
      if (k > 4 && lastDraws > 50 && Math.abs(d - lastDraws) < Math.max(3, lastDraws * 0.01)) { lastDraws = d; break; }
      lastDraws = d;
      await sleep(300);
    }
    console.log(`  [${stop.name}] settled at ~${lastDraws} draws/frame`);
    const r = await ev(c, `(async()=>{
      const sf = window.__sf; const acc = window.__acc;
      const dev = sf.renderer.backend.device;
      for (const k of Object.keys(acc)) delete acc[k];
      let cpu = 0;
      const t0 = performance.now();
      for (let i=0;i<${FRAMES};i++) {
        const a = performance.now();
        sf.tick(1/60);
        cpu += performance.now() - a;
        await dev.queue.onSubmittedWorkDone();
      }
      const total = performance.now() - t0;
      sf.renderer.info.reset(); sf.tick(1/60); await dev.queue.onSubmittedWorkDone();
      const out = {};
      let sum = 0;
      for (const [k,v] of Object.entries(acc)) { out[k] = +(v/${FRAMES}).toFixed(3); sum += v; }
      const info = sf.renderer.info;
      return { perFrame: out, cpuMs: +(cpu/${FRAMES}).toFixed(3), frameMs: +(total/${FRAMES}).toFixed(3), accountedMs: +(sum/${FRAMES}).toFixed(3),
               draws: info.render.drawCalls ?? info.render.calls ?? 0,
               tris: info.render.triangles ?? 0 };
    })()`);
    results.push({ stop: stop.name, ...r });
    const top = Object.entries(r.perFrame).sort((a, b) => b[1] - a[1]).slice(0, 14);
    console.log(`\n=== ${stop.name} ===  tick total ${r.totalMs}ms/f  accounted ${r.accountedMs}  draws/f ${r.draws}  tris/f ${(r.tris / 1e6).toFixed(2)}M`);
    for (const [k, v] of top) console.log(`  ${k.padEnd(20)} ${v.toFixed(3)} ms/f`);
  }
  writeFileSync(path.join(OUT, "breakdown.json"), JSON.stringify(results, null, 2));
  console.log(`\n[probe] wrote ${path.join(OUT, "breakdown.json")}`);
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
