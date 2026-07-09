// Whole-app perf baseline: boots the real app headless (WebGPU/metal), freezes
// the clock, drives __sf.tick() by hand, and at a ladder of representative city
// locations measures per-frame cost three ways:
//   cpuMs    — performance.now() around tick() alone (CPU: sim + encode)
//   frameMs  — tick() + queue.onSubmittedWorkDone() (serialized CPU+GPU)
//   gpu≈     — frameMs − cpuMs (rough GPU-side residue)
// at three quality tiers (emulating the old presets):
//   P: dpr 1.0, shadows off,  samples 0   (old "performance" default)
//   B: dpr 1.5, shadows low,  samples 2   (old "balanced" — user reports 20-30fps)
//   H: dpr 1.5, shadows high, samples 4   (old "high")
// plus renderer.info draw calls / triangles per stop.
//
//   node tools/perf-baseline-probe.mjs
// Env: SF_PROBE_OUT (default .data/perf-baseline), SF_PROBE_URL, CHROME_BIN,
//      SF_W/SF_H (logical canvas, default 2560x1600 to match past measurements)

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/perf-baseline");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5196";
const W = Number(process.env.SF_W ?? 2560), H = Number(process.env.SF_H ?? 1600);
const WARM = 80, MEASURE = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STOPS = [
  // name, world x/z, facing (rad), mode
  { name: "downtown FiDi (dense towers)", x: 4117, z: 200, facing: Math.PI, mode: "walk" },
  { name: "golden gate deck (spawn)", spawn: "goldenGate" },
  { name: "residential marina", x: -700, z: -2380, facing: 0.6, mode: "walk" },
  { name: "botanical meadow (horses+grass)", x: -2260, z: 2450, facing: 2.4, mode: "walk" },
  { name: "embarcadero pier (water+city)", x: 3900, z: -1100, facing: -2.2, mode: "walk" }
];

const TIERS = [
  { key: "P dpr1 sh-off s0", dpr: 1.0, shadows: "off", samples: 0 },
  { key: "B dpr1.5 sh-low s2", dpr: 1.5, shadows: "low", samples: 2 },
  { key: "H dpr1.5 sh-high s4", dpr: 1.5, shadows: "high", samples: 4 }
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

  console.log("[probe] waiting for app boot...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device&&window.__sf.sky)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("app never ready (see [page-*] above)");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  await ev(c, `window.__sfManual&&window.__sfManual(true)`);

  // tier switcher installed in-page. Mirrors what the "/" panel preset onChange does.
  await ev(c, `window.__tier = async (dpr, shadows, samples) => {
    const sf = window.__sf;
    sf.renderer.setPixelRatio(dpr);
    sf.renderer.setSize(window.innerWidth, window.innerHeight);
    // shadow quality is fixed now (universal render mode) — there are no more
    // low/high tiers, but we can still A/B the renderer-level shadow pass on/off.
    sf.renderer.shadowMap.enabled = shadows !== "off";
    sf.POSTFX_TUNING.values.sceneSamples = samples;
    sf.pipeline.applyPostQuality ? sf.pipeline.applyPostQuality() : null;
    return true;
  }; true`);

  const timeExpr = (n, dt) => `(async()=>{
    const dev=window.__sf.renderer.backend.device; const cpu=[], tot=[];
    for(let i=0;i<${n};i++){
      const a=performance.now();
      window.__sf.tick(${dt});
      const b=performance.now();
      await dev.queue.onSubmittedWorkDone();
      const cEnd=performance.now();
      cpu.push(b-a); tot.push(cEnd-a);
    }
    const st=(arr)=>{arr=[...arr].sort((x,y)=>x-y);return {p50:+arr[arr.length>>1].toFixed(2),p90:+arr[Math.floor(arr.length*0.9)].toFixed(2),mean:+(arr.reduce((s,x)=>s+x,0)/arr.length).toFixed(2)};};
    const info = window.__sf.renderer.info;
    const ri = info && info.render ? { calls: info.render.drawCalls ?? info.render.calls, tris: info.render.triangles } : null;
    return { cpu: st(cpu), tot: st(tot), info: ri };
  })()`;

  const rows = [];
  for (const stop of STOPS) {
    // teleport
    if (stop.spawn) {
      await ev(c, `(()=>{const p=window.__sf.player;p.respawn&&p.respawn("${stop.spawn}");return true;})()`).catch(() => {});
      // fall back: if respawn(name) unsupported, ignore — the default spawn IS goldenGate
    } else {
      await ev(c, `(()=>{const sf=window.__sf;const gy=sf.map.groundHeight(${stop.x},${stop.z});sf.player.teleportTo({x:${stop.x},y:gy+1.6,z:${stop.z},facing:${stop.facing},mode:'${stop.mode}'});return true;})()`);
    }
    // settle + stream in tiles/citygen around the new spot: run ticks and give
    // async loaders real wall time in chunks.
    for (let k = 0; k < 6; k++) {
      await ev(c, `(async()=>{for(let i=0;i<40;i++){window.__sf.tick(1/60);} return true;})()`);
      await sleep(700);
    }

    const stopRow = { name: stop.name, tiers: {} };
    for (const tier of TIERS) {
      await ev(c, `window.__tier(${tier.dpr}, "${tier.shadows}", ${tier.samples})`);
      // let the pipeline rebuild + shadow maps settle
      await ev(c, `(async()=>{for(let i=0;i<${WARM};i++){window.__sf.tick(1/60);} return true;})()`);
      const m = await ev(c, timeExpr(MEASURE, 1 / 60));
      stopRow.tiers[tier.key] = m;
      console.log(`  [${stop.name}] ${tier.key}  cpu p50=${m.cpu.p50}ms  frame p50=${m.tot.p50}ms p90=${m.tot.p90}  ` + (m.info ? `calls=${m.info.calls} tris=${(m.info.tris / 1e6).toFixed(1)}M` : ""));
    }
    rows.push(stopRow);
  }

  console.log("\n================= BASELINE SUMMARY =================");
  console.log(`canvas ${W}x${H} logical`);
  for (const r of rows) {
    console.log(`\n${r.name}`);
    for (const [k, m] of Object.entries(r.tiers)) {
      const fps = (1000 / m.tot.p50).toFixed(0);
      console.log(`  ${k.padEnd(20)} frame p50 ${String(m.tot.p50).padStart(6)}ms (~${fps}fps)  p90 ${String(m.tot.p90).padStart(6)}  cpu p50 ${String(m.cpu.p50).padStart(6)}ms` + (m.info ? `  calls ${m.info.calls}` : ""));
    }
  }

  writeFileSync(path.join(OUT, "baseline.json"), JSON.stringify({ W, H, rows }, null, 2));
  console.log(`\n[probe] wrote ${path.join(OUT, "baseline.json")}`);

  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
