// Headless render + perf probe for the wildlands foliage.
//
// Boots the app in headless Chrome (WebGPU via ANGLE-metal), freezes the wall
// clock, teleports the player to a set of viewpoints across Golden Gate Park /
// Presidio / Marin, screenshots each, and measures the foliage cost by A/B
// toggling the wildlands (+garden) groups' visibility while reading real GPU
// time (renderer.info.render.timestamp) + drawCalls + triangles.
//
//   node tools/wild-probe.mjs
// Env: SF_PROBE_OUT (dir, default .data/wild-probe), SF_PROBE_URL, CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/wild-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5188";
const W = 1280, H = 720; // smaller surface = less GPU pressure (headless WebGPU tab crashes under load)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// viewpoints: [name, x, z, facing(rad), backDist, upHeight] — overviews pull far
// back + high; ground/bloom views sit low + close so near-clone trees and the
// flower drifts are actually visible.
const VIEWS = [
  ["marin_no_float", -4450, -6250, 0.3, 12, 3.6],
  ["ggpark_flowers_grass", -2725, 2540, 1.2, 11, 3.2]
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

async function measure(c) {
  // Real frame wall-time: tick then block on the GPU queue draining, averaged.
  // Also read deterministic geometry cost (draw calls + triangles). info.render
  // uses `.calls` (not drawCalls).
  const s = await ev(c, `(async()=>{
    const r=window.__sf.renderer, dev=r.backend&&r.backend.device;
    const sync=async()=>{ if(dev&&dev.queue&&dev.queue.onSubmittedWorkDone) await dev.queue.onSubmittedWorkDone(); };
    for(let i=0;i<6;i++){r.tick?r.tick(1/60):window.__sf.tick(1/60);await sync();}
    let sum=0;const N=24;
    for(let i=0;i<N;i++){const t=performance.now();window.__sf.tick(1/60);await sync();sum+=performance.now()-t;}
    const inf=r.info.render;
    return{ms:sum/N,calls:inf.calls,tris:inf.triangles};
  })()`);
  return s;
}
async function setWild(c, on) {
  await ev(c, `(()=>{for(const g of window.__sf.wildlands.groups)g.visible=${on};return true;})()`);
}
async function setGarden(c, on) {
  await ev(c, `(()=>{window.__sf.garden.group.visible=${on};return true;})()`);
}
async function teleport(c, x, z, facing) {
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:${facing},mode:'walk'});return true;})()`);
}
// oblique view: eye pulled back + up from the target ground point (per-view)
async function freeCam(c, x, z, facing, back, up) {
  await ev(c, `(()=>{const m=window.__sf.map;const gy=m.groundHeight(${x},${z});
    const dx=Math.sin(${facing}),dz=Math.cos(${facing});
    const eye=[${x}-dx*${back}, gy+${up}, ${z}-dz*${back}];
    window.__sfFreeCam(eye,[${x}+dx*35, gy+${Math.max(3, up * 0.15)}, ${z}+dz*35]);return true;})()`);
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
  // find the app page target (not about:blank / devtools) once it's navigated in
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
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.wildlands&&window.__sf.player)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready (see [page-exception]/[page-error] above)");
  console.log(`[probe] __sf ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`); // freeze wall clock
  await settle(c, 12); // let tiles + hero trees stream

  const results = [];
  let fails = 0;
  for (const [name, x, z, facing, back, up] of VIEWS) {
    try {
      await teleport(c, x, z, facing); // stream this area's tiles/colliders
      await settle(c, 14); // stream tiles + grow species heroes
      await freeCam(c, x, z, facing, back, up);
      for (let i = 0; i < 6; i++) await tick(c, 1 / 60);
      // let the rebin run a few real frames from this eye, then read near-clone count
      for (let i = 0; i < 20; i++) { await tick(c, 1 / 60); await sleep(30); }
      const diag = await ev(c, `(()=>{const s=window.__sf.wildlands.trees.stats;return{nearActive:s.nearActive(),instances:s.instances,chunks:s.chunks,designs:s.designs};})()`);
      console.log(`[diag] ${name}`, JSON.stringify(diag));
      const gdiag = await ev(c, `(()=>{const g=window.__sf.wildlands.grass.group;const m=g.children.find(o=>o.isInstancedMesh);if(!m)return{grass:'none'};const a=m.instanceMatrix.array;let n=m.count,lo=1e9,hi=-1e9;for(let i=0;i<n;i++){const y=a[i*16+13];if(y<lo)lo=y;if(y>hi)hi=y;}const cam=window.__sf.camera.position;const gh=window.__sf.map.groundHeight(cam.x,cam.z);return{count:n,yLo:+lo.toFixed(1),yHi:+hi.toFixed(1),camGround:+gh.toFixed(1),camY:+cam.y.toFixed(1)};})()`);
      console.log(`[grass] ${name}`, JSON.stringify(gdiag));
      const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88, fromSurface: true });
      writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(shot.data, "base64"));
      const all = await measure(c); // wildlands + garden on
      await setWild(c, false);
      const noWild = await measure(c);
      await setWild(c, true);
      const row = { view: name, msAll: +all.ms.toFixed(1), msWild: +(all.ms - noWild.ms).toFixed(1) };
      results.push(row);
      console.log(JSON.stringify(row));
      fails = 0;
    } catch (e) {
      console.log(`[view-fail] ${name}: ${String(e).slice(0, 120)}`);
      if (++fails >= 2) { console.log("[probe] tab unstable, stopping views early"); break; }
    }
  }
  const stats = await ev(c, `({trees:window.__sf.wildlands.stats,garden:window.__sf.garden.stats})`);
  writeFileSync(path.join(OUT, "perf.json"), JSON.stringify({ results, stats }, null, 2));
  console.log("[probe] stats", JSON.stringify(stats));
  console.log(`[probe] screenshots + perf.json in ${OUT}`);
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
