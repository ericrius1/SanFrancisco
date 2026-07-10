// Hitch probe: boots the real app headless (WebGPU/metal) with the REAL rAF
// loop (no manual tick), drives/flies across the city with synthetic input,
// and records per-frame timing to find intermittent hitches:
//   - rAF delta series → p50/p95/p99/max + hitch counts (>20/33/50ms)
//   - per-frame renderer counters (geometries/textures/drawCalls/dpr) → deltas
//     at spike frames tell WHAT streamed in that frame
//   - CDP sampling profiler across each leg → per-spike-window top self-time
//     functions, GC share, plus a whole-leg self-time ranking
//
//   node tools/hitch-probe.mjs
// Env: SF_PROBE_OUT (default .data/hitch-probe), SF_PROBE_URL, CHROME_BIN,
//      SF_W/SF_H (default 1920x1200), SF_LEG_SECONDS (default 45)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/hitch-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5197";
const W = Number(process.env.SF_W ?? 1920), H = Number(process.env.SF_H ?? 1200);
const LEG_SECONDS = Number(process.env.SF_LEG_SECONDS ?? 45);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Legs: drive legs auto-re-teleport to the next anchor if the car gets stuck;
// the fly leg crosses the whole map at plane speed (max streaming pressure).
const LEGS = [
  {
    name: "drive-marina-east",
    mode: "drive",
    anchors: [
      { x: -700, z: -2380, facing: -1.6 },   // Marina Green, head east along the waterfront
      { x: 900, z: -2000, facing: -2.0 },
      { x: 2400, z: -1500, facing: -2.2 },
      { x: 3900, z: -1100, facing: 2.6 }     // Embarcadero, head back southwest
    ]
  },
  {
    name: "drive-downtown-grid",
    mode: "drive",
    anchors: [
      { x: 4117, z: 200, facing: Math.PI },  // FiDi
      { x: 3400, z: 700, facing: 2.2 },
      { x: 2600, z: 1200, facing: -2.6 },
      { x: 1800, z: 1800, facing: 0.4 }
    ]
  },
  {
    name: "fly-cross-city",
    mode: "plane",
    anchors: [
      { x: -2400, z: 2600, facing: -0.9, alt: 140 }  // sunset → downtown diagonal
    ]
  }
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

// ---------- profile → per-window attribution ----------
function buildNodeTable(profile) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const nameOf = (id) => {
    const n = byId.get(id);
    if (!n) return `#${id}`;
    const f = n.callFrame;
    const url = f.url ? f.url.split("/").pop().split("?")[0] : "";
    return `${f.functionName || "(anon)"}${url ? ` @${url}` : ""}`;
  };
  return { byId, nameOf };
}
function sampleTimes(profile) {
  // absolute µs timestamps per sample
  const t = new Array(profile.samples.length);
  let acc = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) { acc += profile.timeDeltas[i]; t[i] = acc; }
  return t;
}
function windowAttribution(profile, times, pageAlign, winStartMs, winEndMs, nameOf) {
  // pageAlign: pageMs = pageAlign.page0 + (ts - pageAlign.prof0)/1000
  const toPage = (ts) => pageAlign.page0 + (ts - pageAlign.prof0) / 1000;
  const self = new Map();
  let inWin = 0, gc = 0, idle = 0;
  for (let i = 0; i < times.length; i++) {
    const pm = toPage(times[i]);
    if (pm < winStartMs || pm > winEndMs) continue;
    inWin++;
    const name = nameOf(profile.samples[i]);
    if (name.startsWith("(garbage collector)")) gc++;
    if (name.startsWith("(idle)")) idle++;
    self.set(name, (self.get(name) ?? 0) + 1);
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([n, c]) => `${n}×${c}`);
  return { samples: inWin, gcSamples: gc, idleSamples: idle, top };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const profileDir = path.join(OUT, "chrome");
  const proc = spawn(chrome, [
    `--user-data-dir=${profileDir}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps&profile`
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
  const consoleLog = [];
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      console.log("[page-exception]", (d.exception && (d.exception.description || d.exception.value)) || d.text);
    } else if (m.method === "Runtime.consoleAPICalled") {
      const txt = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200);
      consoleLog.push({ wall: Date.now(), type: m.params.type, txt });
      if (m.params.type === "error") console.log("[page-error]", txt);
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  // Neuter vite's HMR websocket: a parallel editing session saving any src file
  // mid-leg full-reloads the page, wiping the injected __rec/__key/__tp helpers
  // (observed as "window.__key is not a function" mid-run). The stub swallows
  // the HMR connection so the page under test stays exactly as booted.
  await c.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { const W = window.WebSocket; window.WebSocket = function(url, p) {
      const u = String(url);
      if (u.includes("token=") || u.includes("vite") || u.includes("hmr")) {
        return { addEventListener(){}, removeEventListener(){}, send(){}, close(){}, readyState: 3 };
      }
      return p === undefined ? new W(url) : new W(url, p);
    }; window.WebSocket.prototype = W.prototype; })()`
  });
  await c.send("Page.reload"); // pick up the stub from a clean load

  console.log("[probe] waiting for app boot...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device&&window.__sf.sky)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("app never ready (see [page-*] above)");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  // let the deferred modules (citygen ring, wildlands, forest) come up too —
  // they're part of the real steady-state and prime hitch suspects
  const tDef = Date.now();
  while (Date.now() - tDef < 60000) {
    if (await ev(c, `!!(window.__sf.citygenRing && window.__sf.citygenRing.current)`)) break;
    await sleep(1000);
  }
  console.log(`[probe] citygen ring ${await ev(c, `!!(window.__sf.citygenRing&&window.__sf.citygenRing.current)`) ? "ready" : "NOT ready (continuing)"}`);

  // in-page recorder: one extra rAF loop, cheap counter polls per frame
  await ev(c, `(()=>{
    const sf = window.__sf;
    window.__rec = { on:false, t:[], geo:[], tex:[], calls:[], dpr:[], px:[], pz:[] };
    const info = sf.renderer.info;
    const loop = (t) => {
      const r = window.__rec;
      if (r.on) {
        r.t.push(t);
        r.geo.push(info.memory ? info.memory.geometries : -1);
        r.tex.push(info.memory ? info.memory.textures : -1);
        r.calls.push(info.render ? (info.render.drawCalls ?? info.render.calls ?? -1) : -1);
        r.dpr.push(sf.renderer.getPixelRatio());
        r.px.push(sf.player.position.x); r.pz.push(sf.player.position.z);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    window.__key = (code, down) => window.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{code,bubbles:true}));
    window.__tp = (x, z, facing, mode, alt) => {
      const gy = sf.map.groundHeight(x, z);
      sf.player.teleportTo({ x, y: gy + (alt ?? 1.2), z, facing, mode });
      if (sf.chase) sf.chase.yaw = facing + Math.PI;
      return true;
    };
    return true;
  })()`);

  await c.send("Profiler.enable");
  await c.send("Profiler.setSamplingInterval", { interval: 500 }); // µs

  const legReports = [];
  for (const leg of LEGS) {
    console.log(`\n[leg] ${leg.name} (${LEG_SECONDS}s)`);
    // teleport to first anchor, settle streaming for a few seconds
    const a0 = leg.anchors[0];
    await ev(c, `window.__tp(${a0.x}, ${a0.z}, ${a0.facing}, '${leg.mode}', ${a0.alt ?? "undefined"})`);
    await sleep(4000);

    // clear recorder, align clocks, start profiler, hold W
    await ev(c, `(()=>{const r=window.__rec; r.t.length=r.geo.length=r.tex.length=r.calls.length=r.dpr.length=r.px.length=r.pz.length=0; r.on=true; return true;})()`);
    const page0 = await ev(c, `performance.now()`);
    await c.send("Profiler.start");
    const profWall0 = Date.now();
    await ev(c, `window.__key('KeyW', true) ?? true`);

    // during the leg: watchdog re-teleports a stuck car to the next anchor
    let anchorIdx = 0;
    const legEnd = Date.now() + LEG_SECONDS * 1000;
    let lastPos = await ev(c, `[window.__sf.player.position.x, window.__sf.player.position.z]`);
    let lastMove = Date.now();
    while (Date.now() < legEnd) {
      await sleep(2500);
      await ev(c, `window.__key('KeyW', true) ?? true`); // re-assert against HMR/blur
      const pos = await ev(c, `[window.__sf.player.position.x, window.__sf.player.position.z]`);
      const d = Math.hypot(pos[0] - lastPos[0], pos[1] - lastPos[1]);
      if (d > 4) { lastMove = Date.now(); lastPos = pos; }
      else if (leg.mode === "drive" && Date.now() - lastMove > 6000 && leg.anchors.length > 1) {
        anchorIdx = (anchorIdx + 1) % leg.anchors.length;
        const a = leg.anchors[anchorIdx];
        console.log(`  [watchdog] stuck — hop to anchor ${anchorIdx} (${a.x},${a.z})`);
        await ev(c, `window.__tp(${a.x}, ${a.z}, ${a.facing}, '${leg.mode}', ${a.alt ?? "undefined"})`);
        lastMove = Date.now();
      }
    }
    await ev(c, `window.__key('KeyW', false) ?? true`);
    const { profile } = await c.send("Profiler.stop");
    await ev(c, `(()=>{window.__rec.on=false; return true;})()`);
    const rec = await ev(c, `window.__rec`);

    // ---------- analyze ----------
    const t = rec.t;
    const dts = [];
    for (let i = 1; i < t.length; i++) dts.push(t[i] - t[i - 1]);
    const sorted = [...dts].sort((a, b) => a - b);
    const q = (p) => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1) : 0;
    const secs = t.length > 1 ? (t[t.length - 1] - t[0]) / 1000 : 1;
    const count = (ms) => dts.filter((d) => d > ms).length;

    const { nameOf } = buildNodeTable(profile);
    const times = sampleTimes(profile);
    const pageAlign = { page0, prof0: profile.startTime };
    // whole-leg self-time ranking (exclude idle/program/gc bookkeeping? keep gc)
    const legSelf = new Map();
    for (const s of profile.samples) {
      const n = nameOf(s);
      if (n.startsWith("(idle)") || n.startsWith("(program)")) continue;
      legSelf.set(n, (legSelf.get(n) ?? 0) + 1);
    }
    const legTop = [...legSelf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
      .map(([n, cnt]) => ({ fn: n, ms: +(cnt * 0.5).toFixed(1) })); // 500µs/sample

    // spikes: worst 14 frames > 20ms, each attributed
    const spikes = [];
    for (let i = 1; i < t.length; i++) {
      const d = t[i] - t[i - 1];
      if (d > 20) spikes.push({ i, start: t[i - 1], dt: +d.toFixed(1) });
    }
    spikes.sort((a, b) => b.dt - a.dt);
    const spikeRows = spikes.slice(0, 14).map((s) => {
      const att = windowAttribution(profile, times, pageAlign, s.start, s.start + s.dt, nameOf);
      const dGeo = rec.geo[s.i] - rec.geo[s.i - 1];
      const dTex = rec.tex[s.i] - rec.tex[s.i - 1];
      const dCalls = rec.calls[s.i] - rec.calls[s.i - 1];
      const dDpr = rec.dpr[s.i] !== rec.dpr[s.i - 1] ? `${rec.dpr[s.i - 1]}→${rec.dpr[s.i]}` : "";
      const cpuShare = att.samples ? (att.samples * 0.5) / s.dt : 0; // sampled CPU ms / wall ms
      const cls = att.gcSamples * 0.5 > s.dt * 0.3 ? "GC"
        : cpuShare > 0.5 ? "CPU"
        : "GPU/other";
      return {
        atSec: +((s.start - t[0]) / 1000).toFixed(1), dt: s.dt, cls,
        cpuMsSampled: +(att.samples * 0.5).toFixed(1), gcMs: +(att.gcSamples * 0.5).toFixed(1),
        dGeo, dTex, dCalls, dDpr, top: att.top.slice(0, 4)
      };
    });

    const report = {
      leg: leg.name, frames: dts.length, seconds: +secs.toFixed(1),
      fpsMean: +(dts.length / secs).toFixed(1),
      p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +Math.max(0, ...dts).toFixed(1),
      hitches: { over20ms: count(20), over33ms: count(33), over50ms: count(50), perMinOver33: +(count(33) / (secs / 60)).toFixed(1) },
      spikes: spikeRows, legTop, profWall0
    };
    legReports.push(report);
    console.log(`  frames=${report.frames} p50=${report.p50} p95=${report.p95} p99=${report.p99} max=${report.max}  >33ms:${report.hitches.over33ms} (${report.hitches.perMinOver33}/min)`);
    for (const s of spikeRows.slice(0, 8)) {
      console.log(`   spike +${s.atSec}s ${s.dt}ms [${s.cls}] cpu≈${s.cpuMsSampled} gc≈${s.gcMs} Δgeo=${s.dGeo} Δtex=${s.dTex} Δcalls=${s.dCalls} ${s.dDpr} :: ${s.top.join(" | ")}`);
    }
  }

  writeFileSync(path.join(OUT, "hitch-report.json"), JSON.stringify({ W, H, LEG_SECONDS, legReports, consoleLog: consoleLog.slice(-200) }, null, 2));
  console.log(`\n[probe] wrote ${path.join(OUT, "hitch-report.json")}`);

  console.log("\n================= HITCH SUMMARY =================");
  for (const r of legReports) {
    console.log(`\n${r.leg}: p50 ${r.p50}ms p95 ${r.p95} p99 ${r.p99} max ${r.max} — >33ms ${r.hitches.perMinOver33}/min`);
    console.log(`  top CPU (whole leg): ${r.legTop.slice(0, 6).map((x) => `${x.fn} ${x.ms}ms`).join(" | ")}`);
  }

  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
