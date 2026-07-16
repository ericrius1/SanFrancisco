// Corona Heights flyover hitch probe: boots the real app headless (WebGPU/metal)
// with the REAL rAF loop (no manual tick), flies a plane across the Corona
// Heights summit (day + night) and also hovers quietly nearby so deferred site
// loads are admitted. Records per-frame timing plus Corona-specific markers to
// attribute any multi-second stall WITHOUT assuming a culprit:
//   - rAF delta series → p50/p95/p99/max + hitch counts
//   - per-frame renderer counters (geometries/textures/drawCalls) → deltas at
//     spike frames tell WHAT streamed in that frame
//   - per-frame Corona markers: distance to the busker trio, trio visibility,
//     firefly fill-light state, optional-site states (corona/others)
//   - CDP sampling profiler → per-spike-window top self-time functions + GC
//
//   node tools/corona-hitch-probe.mjs
// Env: SF_PROBE_OUT (default .data/corona-hitch-probe), SF_PROBE_URL, CHROME_BIN,
//      SF_W/SF_H (default 1920x1200)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/corona-hitch-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5198";
const W = Number(process.env.SF_W ?? 1920), H = Number(process.env.SF_H ?? 1200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The busker trio / summit anchor (app systems place the trio at 412,2760).
const SUMMIT = { x: 412, z: 2760 };

// Each leg pins the sky clock first (the app defaults to real SF wall-clock, so
// an unpinned probe would measure a random lighting regime).
const LEGS = [
  {
    // Continuous flight from the east, directly over the summit, daytime.
    // Movement keeps deferred quiet-gated loads OUT — whatever spikes here is
    // un-gated proximity work (streaming, first-visible flips, ...).
    name: "fly-corona-day", mode: "plane", timeOfDay: 14, seconds: 42,
    start: { x: SUMMIT.x + 1600, z: SUMMIT.z, clearance: 65 }
  },
  {
    // Same route at night (firefly/lamp regimes active).
    name: "fly-corona-night", mode: "plane", timeOfDay: 22, seconds: 42,
    start: { x: SUMMIT.x + 1600, z: SUMMIT.z, clearance: 65 }
  },
  {
    // Land ~420m from the summit and stand still: the quiet window opens and
    // deferred optional-site loads (Corona park, Buena Vista foliage, …) are
    // admitted. Any constructor/compile stall shows here.
    name: "hover-corona-quiet", mode: "walk", timeOfDay: 22, seconds: 30,
    start: { x: SUMMIT.x + 420, z: SUMMIT.z + 60, clearance: 1.2 }, still: true
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
  const t = new Array(profile.samples.length);
  let acc = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) { acc += profile.timeDeltas[i]; t[i] = acc; }
  return t;
}
function windowAttribution(profile, times, pageAlign, winStartMs, winEndMs, nameOf) {
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
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--hide-scrollbars", "--mute-audio",
    `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps&profile`
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
  // Neuter vite's HMR websocket so a parallel editing session can't reload the
  // page mid-leg and wipe the injected helpers.
  await c.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { const W = window.WebSocket; window.WebSocket = function(url, p) {
      const u = String(url);
      if (u.includes("token=") || u.includes("vite") || u.includes("hmr")) {
        return { addEventListener(){}, removeEventListener(){}, send(){}, close(){}, readyState: 3 };
      }
      return p === undefined ? new W(url) : new W(url, p);
    }; window.WebSocket.prototype = W.prototype; })()`
  });
  await c.send("Page.reload");

  console.log("[probe] waiting for app boot...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device&&window.__sf.sky&&window.__sf.buskers)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("app never ready (see [page-*] above)");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const tDef = Date.now();
  while (Date.now() - tDef < 60000) {
    if (await ev(c, `!!(window.__sf.citygenRing && window.__sf.citygenRing.current)`)) break;
    await sleep(1000);
  }
  console.log(`[probe] citygen ring ${await ev(c, `!!(window.__sf.citygenRing&&window.__sf.citygenRing.current)`) ? "ready" : "NOT ready (continuing)"}`);

  // in-page recorder: one extra rAF loop with cheap per-frame polls, plus
  // Corona-specific markers so spike frames can be lined up against gates.
  await ev(c, `(()=>{
    const sf = window.__sf;
    const trio = sf.buskers;
    const summit = { x: ${SUMMIT.x}, z: ${SUMMIT.z} };
    window.__rec = { on:false, t:[], geo:[], tex:[], calls:[], px:[], pz:[], py:[],
                     dtrio:[], busk:[], ffly:[], sites:[] };
    const info = sf.renderer.info;
    const fireflyLight = () => {
      // effective render-list membership: the node and every ancestor visible.
      // Pre-fix this is a real PointLight (o.intensity); post-fix it's a pool
      // anchor whose spec carries the requested intensity.
      let o = trio.group.getObjectByName("busker-firefly-fill");
      if (!o) return 0;
      let node = o;
      while (node) { if (!node.visible) return 0; node = node.parent; }
      const spec = o.userData && o.userData.lightSpec;
      const intensity = spec ? spec.intensity : o.intensity;
      return (intensity ?? 0) > 0 ? 2 : 1; // 2 = lit, 1 = present at 0
    };
    const siteStates = () => (sf.optionalWorldSites ?? [])
      .map((s) => s.id[0] + ":" + s.state[0]).join(",");
    const loop = (t) => {
      const r = window.__rec;
      if (r.on) {
        r.t.push(t);
        r.geo.push(info.memory ? info.memory.geometries : -1);
        r.tex.push(info.memory ? info.memory.textures : -1);
        r.calls.push(info.render ? (info.render.drawCalls ?? info.render.calls ?? -1) : -1);
        const p = sf.player.position;
        r.px.push(p.x); r.pz.push(p.z); r.py.push(p.y);
        r.dtrio.push(Math.round(Math.hypot(p.x - summit.x, p.z - summit.z)));
        r.busk.push(trio.group.visible ? 1 : 0);
        r.ffly.push(fireflyLight());
        r.sites.push(siteStates());
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
    window.__pinSky = (hours) => { const s = sf.sky; s.cycleEnabled = false; s.setTimeOfDay(hours); return true; };
    return true;
  })()`);

  await c.send("Profiler.enable");
  await c.send("Profiler.setSamplingInterval", { interval: 500 }); // µs

  const legReports = [];
  for (const leg of LEGS) {
    console.log(`\n[leg] ${leg.name} (${leg.seconds}s, ${leg.timeOfDay}:00)`);
    await ev(c, `window.__pinSky(${leg.timeOfDay})`);
    // Start altitude: clear the summit by `clearance` metres regardless of the
    // ground height at the start point.
    const alt = await ev(c, `(()=>{
      const m = window.__sf.map;
      return Math.max(1.2, m.groundHeight(${SUMMIT.x}, ${SUMMIT.z}) + ${leg.start.clearance} - m.groundHeight(${leg.start.x}, ${leg.start.z}));
    })()`);
    // Face the summit; the app's facing convention is calibrated below.
    let facing = Math.atan2(-(SUMMIT.x - leg.start.x), -(SUMMIT.z - leg.start.z));
    await ev(c, `window.__tp(${leg.start.x}, ${leg.start.z}, ${facing}, '${leg.mode}', ${alt})`);
    await sleep(4000);

    if (!leg.still) {
      // Calibrate heading: hold W briefly, compare actual bearing to desired.
      await ev(c, `window.__key('KeyW', true) ?? true`);
      const s0 = await ev(c, `[window.__sf.player.position.x, window.__sf.player.position.z]`);
      await sleep(1600);
      await ev(c, `window.__key('KeyW', false) ?? true`);
      const s1 = await ev(c, `[window.__sf.player.position.x, window.__sf.player.position.z]`);
      const moved = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]);
      if (moved > 3) {
        const actual = Math.atan2(s1[0] - s0[0], s1[1] - s0[1]);
        const desired = Math.atan2(SUMMIT.x - s1[0], SUMMIT.z - s1[1]);
        facing += (desired - actual);
        console.log(`  [cal] moved ${moved.toFixed(0)}m, heading corrected by ${((desired - actual) * 180 / Math.PI).toFixed(0)}°`);
      } else {
        console.log(`  [cal] WARNING: barely moved (${moved.toFixed(1)}m) — mode '${leg.mode}' may not respond to W`);
      }
      await ev(c, `window.__tp(${leg.start.x}, ${leg.start.z}, ${facing}, '${leg.mode}', ${alt})`);
      await sleep(2500);
    }

    const page0 = await ev(c, `performance.now()`);
    await c.send("Profiler.start");
    await ev(c, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await ev(c, `(()=>{const r=window.__rec; for (const k of Object.keys(r)) if (Array.isArray(r[k])) r[k].length=0; r.on=true; return true;})()`);
    if (!leg.still) await ev(c, `window.__key('KeyW', true) ?? true`);

    const legEnd = Date.now() + leg.seconds * 1000;
    while (Date.now() < legEnd) {
      await sleep(2500);
      if (!leg.still) await ev(c, `window.__key('KeyW', true) ?? true`);
      const tele = await ev(c, `(()=>{const p=window.__sf.player.position;return {x:Math.round(p.x),y:Math.round(p.y),z:Math.round(p.z),d:Math.round(Math.hypot(p.x-${SUMMIT.x},p.z-${SUMMIT.z}))};})()`);
      console.log(`  pos (${tele.x},${tele.y},${tele.z}) dist-to-summit ${tele.d}m`);
    }
    if (!leg.still) await ev(c, `window.__key('KeyW', false) ?? true`);
    await ev(c, `(()=>{window.__rec.on=false; return true;})()`);
    const { profile } = await c.send("Profiler.stop");
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
    const legSelf = new Map();
    for (const s of profile.samples) {
      const n = nameOf(s);
      if (n.startsWith("(idle)") || n.startsWith("(program)")) continue;
      legSelf.set(n, (legSelf.get(n) ?? 0) + 1);
    }
    const legTop = [...legSelf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
      .map(([n, cnt]) => ({ fn: n, ms: +(cnt * 0.5).toFixed(1) }));

    const spikes = [];
    for (let i = 1; i < t.length; i++) {
      const d = t[i] - t[i - 1];
      if (d > 20) spikes.push({ i, start: t[i - 1], dt: +d.toFixed(1) });
    }
    spikes.sort((a, b) => b.dt - a.dt);
    const spikeRows = spikes.slice(0, 16).map((s) => {
      const att = windowAttribution(profile, times, pageAlign, s.start, s.start + s.dt, nameOf);
      const cpuShare = att.samples ? (att.samples * 0.5) / s.dt : 0;
      const cls = att.gcSamples * 0.5 > s.dt * 0.3 ? "GC"
        : cpuShare > 0.5 ? "CPU"
        : "GPU/other";
      return {
        atSec: +((s.start - t[0]) / 1000).toFixed(1), dt: s.dt, cls,
        distToSummit: rec.dtrio[s.i],
        buskersVisible: `${rec.busk[s.i - 1]}→${rec.busk[s.i]}`,
        fireflyLight: `${rec.ffly[s.i - 1]}→${rec.ffly[s.i]}`,
        sites: rec.sites[s.i] !== rec.sites[s.i - 1] ? `${rec.sites[s.i - 1]} → ${rec.sites[s.i]}` : rec.sites[s.i],
        cpuMsSampled: +(att.samples * 0.5).toFixed(1), gcMs: +(att.gcSamples * 0.5).toFixed(1),
        dGeo: rec.geo[s.i] - rec.geo[s.i - 1], dTex: rec.tex[s.i] - rec.tex[s.i - 1],
        dCalls: rec.calls[s.i] - rec.calls[s.i - 1],
        top: att.top.slice(0, 5)
      };
    });

    // Gate-crossing summary: frame indices where the trio flipped visible or
    // the firefly light joined, with the frame cost at that moment.
    const gates = [];
    for (let i = 1; i < t.length; i++) {
      if (rec.busk[i] !== rec.busk[i - 1]) gates.push({ frame: i, what: `buskersVisible ${rec.busk[i - 1]}→${rec.busk[i]}`, dt: +(t[i] - t[i - 1]).toFixed(1), nextDt: i + 1 < t.length ? +(t[i + 1] - t[i]).toFixed(1) : null, dist: rec.dtrio[i] });
      if (rec.ffly[i] !== rec.ffly[i - 1]) gates.push({ frame: i, what: `fireflyLight ${rec.ffly[i - 1]}→${rec.ffly[i]}`, dt: +(t[i] - t[i - 1]).toFixed(1), nextDt: i + 1 < t.length ? +(t[i + 1] - t[i]).toFixed(1) : null, dist: rec.dtrio[i] });
      if (rec.sites[i] !== rec.sites[i - 1]) gates.push({ frame: i, what: `sites ${rec.sites[i - 1]} → ${rec.sites[i]}`, dt: +(t[i] - t[i - 1]).toFixed(1), nextDt: i + 1 < t.length ? +(t[i + 1] - t[i]).toFixed(1) : null, dist: rec.dtrio[i] });
    }

    const report = {
      leg: leg.name, frames: dts.length, seconds: +secs.toFixed(1),
      fpsMean: +(dts.length / secs).toFixed(1),
      p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +Math.max(0, ...dts).toFixed(1),
      hitches: { over20ms: count(20), over33ms: count(33), over50ms: count(50), over500ms: count(500) },
      minDistToSummit: Math.min(...rec.dtrio),
      gates, spikes: spikeRows, legTop
    };
    legReports.push(report);
    console.log(`  frames=${report.frames} p50=${report.p50} p95=${report.p95} p99=${report.p99} max=${report.max}  >50ms:${report.hitches.over50ms} >500ms:${report.hitches.over500ms} minDist=${report.minDistToSummit}m`);
    for (const g of gates) console.log(`   gate: ${g.what} @${g.dist}m — frame ${g.dt}ms, next ${g.nextDt}ms`);
    for (const s of spikeRows.slice(0, 10)) {
      console.log(`   spike +${s.atSec}s ${s.dt}ms [${s.cls}] @${s.distToSummit}m busk=${s.buskersVisible} ffly=${s.fireflyLight} cpu≈${s.cpuMsSampled} gc≈${s.gcMs} Δgeo=${s.dGeo} Δtex=${s.dTex} Δcalls=${s.dCalls} :: ${s.top.join(" | ")}`);
    }
  }

  writeFileSync(path.join(OUT, "corona-hitch-report.json"), JSON.stringify({ W, H, legReports, consoleLog: consoleLog.slice(-300) }, null, 2));
  console.log(`\n[probe] wrote ${path.join(OUT, "corona-hitch-report.json")}`);

  console.log("\n================= CORONA HITCH SUMMARY =================");
  for (const r of legReports) {
    console.log(`\n${r.leg}: p50 ${r.p50}ms p95 ${r.p95} p99 ${r.p99} max ${r.max} — >50ms ${r.hitches.over50ms}, >500ms ${r.hitches.over500ms}, minDist ${r.minDistToSummit}m`);
    console.log(`  top CPU (whole leg): ${r.legTop.slice(0, 6).map((x) => `${x.fn} ${x.ms}ms`).join(" | ")}`);
  }

  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
