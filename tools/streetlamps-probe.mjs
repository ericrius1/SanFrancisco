// Street-lamp verify (modelled on tools/foliage-toggle-probe.mjs).
//
// Boots headless Chrome (WebGPU via ANGLE-metal), visits two stops (FiDi +
// a residential street), pins night (23h) and day (13h), and screenshots each.
// At night it toggles the fake-lamp meshes OFF/ON to read the draw-call /
// triangle / frame-time cost they add. At day it confirms the additive ground
// discs go invisible while the posts stay.
//
//   node tools/streetlamps-probe.mjs
// Env: SF_PROBE_OUT (default .data/streetlamps), SF_PROBE_URL, CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/streetlamps");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5245";
const W = 1600, H = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [name, x, z, facing(rad)]
const VIEWS = [
  ["fidi", 4260, 420, -2.4],
  ["residential", 900, 2400, 0.8]
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

// Paired interleaved on/off frame timing: measuring the two states free-running
// is swamped by the shadow throttle's per-frame cascade-parity swing (±100 draws,
// several ms). Toggling the lamp group ON then OFF every iteration and taking the
// median of each cancels that slow drift, so the median-difference isolates the
// lamp meshes' own cost. The 3 InstancedMeshes are exactly 3 draw calls; their
// triangles are computed analytically (resident × per-lamp tris) since the WebGPU
// info.triangles counter reads 0 here.
async function measure(c) {
  return await ev(c, `(async()=>{
    const r=window.__sf.renderer, dev=r.backend&&r.backend.device, sl=window.__sf.streetLamps;
    const sync=async()=>{ if(dev&&dev.queue&&dev.queue.onSubmittedWorkDone) await dev.queue.onSubmittedWorkDone(); };
    const geoTris=(m)=>{const g=m.geometry;return g.index?g.index.count/3:g.attributes.position.count/3;};
    const meshes=sl.group.children;
    const perLampTris=meshes.reduce((s,m)=>s+geoTris(m),0);
    for(let i=0;i<8;i++){window.__sf.tick(1/60);await sync();}
    const on=[],off=[];const N=60;
    for(let i=0;i<N;i++){
      sl.group.visible=true;  let a=performance.now(); window.__sf.tick(1/60); await sync(); on.push(performance.now()-a);
      sl.group.visible=false; let b=performance.now(); window.__sf.tick(1/60); await sync(); off.push(performance.now()-b);
    }
    sl.group.visible=true;
    const med=(xs)=>{xs=[...xs].sort((p,q)=>p-q);return +xs[xs.length>>1].toFixed(2);};
    return{ onP50:med(on), offP50:med(off), dMs:+(med(on)-med(off)).toFixed(2),
            draws:meshes.length, resident:sl.residentCount, perLampTris, tris:Math.round(sl.residentCount*perLampTris) };
  })()`);
}
async function teleport(c, x, z, facing) {
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.6,z:${z},facing:${facing},mode:'walk'});return true;})()`);
}
// disc = the additive (blending===2) instanced mesh; posts/bulbs are the rest
async function lampState(c) {
  return await ev(c, `(()=>{const sl=window.__sf.streetLamps;const disc=sl.group.children.find(m=>m.material&&m.material.blending===2);
    const source=sl.projectedSurfaceLightSource,pipeline=window.__sf.pipeline;
    return{placed:sl.placedCount, resident:sl.residentCount, groupVisible:sl.group.visible, discVisible:disc?disc.visible:null, discCount:disc?disc.count:null,
      projected:pipeline.projectedSurfaceLightState, sourceActive:source.active, sourceCount:source.count, sourceIntensity:source.intensity};})()`);
}
async function shot(c, name) {
  const s = await c.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(s.data, "base64"));
  return file;
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
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      console.log("[page-exception]", (d.exception && (d.exception.description || d.exception.value)) || d.text);
    } else if (m.method === "Inspector.targetCrashed") {
      console.log("[TARGET CRASHED]");
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Inspector.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.streetLamps&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf/streetLamps never ready");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  await settle(c, 10);

  const report = {};
  for (const [name, x, z, facing] of VIEWS) {
    try {
      await teleport(c, x, z, facing);
      await settle(c, 18);

      // --- NIGHT ---
      await ev(c, `window.__sf.sky.setTimeOfDay(23)`);
      for (let i = 0; i < 20; i++) { await tick(c, 1 / 60); await sleep(20); }
      const night = await lampState(c);
      const nightFile = await shot(c, `${name}-night`);

      // cost: paired on/off frame timing + deterministic draws/tris
      const cost = await measure(c);

      // --- DAY --- additive discs must go invisible; posts stay
      await ev(c, `window.__sf.sky.setTimeOfDay(13)`);
      for (let i = 0; i < 20; i++) { await tick(c, 1 / 60); await sleep(20); }
      const day = await lampState(c);
      const dayFile = await shot(c, `${name}-day`);

      report[name] = {
        placed: night.placed, resident: night.resident,
        nightDiscVisible: night.discVisible, dayDiscVisible: day.discVisible,
        projected: night.projected, projectedSourceActive: night.sourceActive,
        projectedSourceCount: night.sourceCount, projectedSourceIntensity: night.sourceIntensity,
        drawsAdded: cost.draws, perLampTris: cost.perLampTris, trisAdded: cost.tris,
        onP50: cost.onP50, offP50: cost.offP50, dMs: cost.dMs,
        night: nightFile, day: dayFile
      };
      console.log(`[${name}] placed ${night.placed} resident ${night.resident} | +${cost.draws} draws +${cost.tris} tris (${cost.perLampTris}/lamp) | on ${cost.onP50}ms off ${cost.offP50}ms (Δ${cost.dMs}ms) | disc night=${night.discVisible} day=${day.discVisible} | projected=${JSON.stringify(night.projected)} source=${night.sourceActive}/${night.sourceCount}`);
      console.log(`  ${nightFile}`);
      console.log(`  ${dayFile}`);
    } catch (e) {
      report[name] = { error: String(e).slice(0, 200) };
      console.log(`[view-fail] ${name}: ${String(e).slice(0, 180)}`);
      break; // tab likely gone — stop rather than cascade
    }
  }
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`[probe] shots + report.json in ${OUT}`);
  console.log("[streetlamps] DONE", JSON.stringify(report));
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
