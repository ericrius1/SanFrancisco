// Focused meadow frame-cost probe. Boots the app, teleports to the botanical
// meadow, waits for grass residency, then measures frame p50 at dpr1.
//   node tools/meadow-perf-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/meadow-perf");
const W = Number(process.env.SF_W ?? 2560), H = Number(process.env.SF_H ?? 1600);
const WARM = 120, MEASURE = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) return;
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
  const vitePort = await freePort();
  const relay = await freePort();
  const serverUrl = `http://127.0.0.1:${vitePort}`;
  console.log(`[meadow] starting Vite at ${serverUrl}`);
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(serverUrl, 90000, "vite");

  const chrome = await findChrome();
  const port = await freePort();
  const profile = path.join(OUT, "chrome");
  const proc = spawn(chrome, [
    `--user-data-dir=${profile}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${serverUrl}/?autostart&profile&fullfps`
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
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[meadow] waiting for boot...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) {
    try {
      if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device&&window.__sf.sky)`)) {
        ready = true; break;
      }
    } catch {}
    await sleep(600);
  }
  if (!ready) throw new Error("app never ready");
  console.log(`[meadow] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // Stay on the LIVE animation loop while the garden first-approach-loads.
  // waitForWorldBackgroundWindow + wakeDeferredGarden need wall-clock quiet
  // windows and rAF; parking the loop with __sfManual first was how we used to
  // measure an empty meadow.
  await ev(c, `(()=>{const sf=window.__sf;sf.renderer.setPixelRatio(1);sf.renderer.shadowMap.enabled=true;return true;})()`);

  // Botanical meadow — wakeDeferredGarden fires when the player is within 900 m
  // AND world arrival is idle.
  await ev(c, `(()=>{const sf=window.__sf;const gy=sf.map.groundHeight(-2260,2450);sf.player.teleportTo({x:-2260,y:gy+1.6,z:2450,facing:2.4,mode:'walk'});return true;})()`);

  const residencyT0 = Date.now();
  let resident = false;
  while (Date.now() - residencyT0 < 180000) {
    try {
      const snap = await ev(c, `(()=>{
        const sf = window.__sf;
        const g = typeof sf.garden === "function" ? sf.garden() : sf.garden;
        const grass = g && g.grass;
        const grassDraws = grass && grass.stats ? (grass.stats.draws || 0) : 0;
        return {
          arrivalActive: !!(sf.worldArrival && sf.worldArrival.active),
          hasGarden: !!g,
          gardenParented: !!(g && g.group && g.group.parent),
          grassDraws,
          envNodes: (()=>{ let n=0; sf.scene.traverse(o=>{if(!o.isMesh)return; const mats=Array.isArray(o.material)?o.material:[o.material]; for(const m of mats) if(m&&m.envNode) n++;}); return n; })()
        };
      })()`);
      console.log(`[meadow] wait`, snap);
      resident = snap.hasGarden && snap.gardenParented && snap.grassDraws > 0;
    } catch (e) {
      console.log(`[meadow] wait err`, String(e).slice(0, 160));
      resident = false;
    }
    if (resident) break;
    await sleep(1000);
  }
  console.log(`[meadow] residency ${resident ? "ok" : "TIMEOUT"} after ${((Date.now() - residencyT0) / 1000).toFixed(0)}s`);

  const atmos = await ev(c, `(()=>{
    const sf = window.__sf;
    let envNodes = 0, customFog = 0;
    sf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.envNode) envNodes++;
        if (typeof m.setupFog === "function" && m.setupFog !== Object.getPrototypeOf(m).setupFog) customFog++;
      }
    });
    const g = sf.garden;
    return { envNodes, customFog, grassDraws: g?.grass?.stats?.draws ?? 0 };
  })()`);
  console.log("[meadow] atmosphere wiring:", atmos);

  // Live-loop measurement: park-free wall-clock samples of presented frames.
  // Manual ticks remain useful for ablation, but headless metal + parked rAF
  // has repeatedly under-counted draws; the live path is what the player feels.
  await sleep(1500); // let the just-parented garden settle pipelines
  const live = await ev(c, `(async () => {
    const samples = [];
    const cpu = [];
    await new Promise((resolve) => {
      let last = performance.now();
      let n = 0;
      const WARM = 90, N = 120;
      const step = (now) => {
        const dt = now - last;
        last = now;
        if (n++ >= WARM) samples.push(dt);
        if (samples.length >= N) resolve(null);
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    samples.sort((a,b)=>a-b);
    const sf = window.__sf;
    const info = sf.renderer.info;
    const ri = info && info.render ? { calls: info.render.drawCalls ?? info.render.calls, tris: info.render.triangles } : null;
    const tr = sf.tracer && sf.tracer.summary ? sf.tracer.summary() : null;
    return {
      p50: +samples[samples.length>>1].toFixed(2),
      p90: +samples[Math.floor(samples.length*0.9)].toFixed(2),
      mean: +(samples.reduce((s,x)=>s+x,0)/samples.length).toFixed(2),
      info: ri,
      tracer: tr
    };
  })()`);
  console.log(`\n[meadow] LIVE dpr1  frame p50 ${live.p50}ms (~${(1000/live.p50).toFixed(0)}fps)  p90 ${live.p90}  tracerEma ${live.tracer?.emaMs ?? "?"}  calls ${live.info?.calls ?? "?"}`);

  // Manual tick cross-check (after fixing advanceNodeFrame info.reset preamble)
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  await ev(c, `(()=>{const sf=window.__sf; if(sf.adaptiveResolution&&sf.adaptiveResolution.setEnabled) sf.adaptiveResolution.setEnabled(false); return true;})()`);
  await ev(c, `(async()=>{for(let i=0;i<${WARM};i++){window.__sf.tick(1/60);} return true;})()`);
  const m = await ev(c, `(async()=>{
    const dev=window.__sf.renderer.backend.device; const cpu=[], tot=[];
    for(let i=0;i<${MEASURE};i++){
      const a=performance.now();
      window.__sf.tick(1/60);
      const b=performance.now();
      await dev.queue.onSubmittedWorkDone();
      const cEnd=performance.now();
      cpu.push(b-a); tot.push(cEnd-a);
    }
    const st=(arr)=>{arr=[...arr].sort((x,y)=>x-y);return {p50:+arr[arr.length>>1].toFixed(2),p90:+arr[Math.floor(arr.length*0.9)].toFixed(2),mean:+(arr.reduce((s,x)=>s+x,0)/arr.length).toFixed(2)};};
    const info = window.__sf.renderer.info;
    const ri = info && info.render ? { calls: info.render.drawCalls ?? info.render.calls, tris: info.render.triangles } : null;
    const dbg = window.__sf.frameDriver && window.__sf.frameDriver.debugState;
    const nf = window.__sf.renderer._nodes && window.__sf.renderer._nodes.nodeFrame;
    return { cpu: st(cpu), tot: st(tot), info: ri, debug: dbg, frameId: nf && nf.frameId };
  })()`);

  const fps = (1000 / m.tot.p50).toFixed(0);
  console.log(`[meadow] MANUAL dpr1  frame p50 ${m.tot.p50}ms (~${fps}fps)  p90 ${m.tot.p90}  cpu p50 ${m.cpu.p50}ms  calls ${m.info?.calls ?? "?"}  frameId ${m.frameId}`);
  writeFileSync(path.join(OUT, "meadow.json"), JSON.stringify({ W, H, atmos, live, m }, null, 2));
  console.log(`[meadow] wrote ${path.join(OUT, "meadow.json")}`);

  c.close(); proc.kill(); dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[meadow] FAIL", e); process.exit(1); });
