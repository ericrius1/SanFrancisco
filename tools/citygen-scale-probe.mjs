// Measures detail-building scaling: for each (detailRadius, maxDetail) rung,
// waits for the detail set to plateau, then reports detail count, module-layer
// instances, renderer draws/tris and frame cost (tick + onSubmittedWorkDone).
//   node tools/citygen-scale-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = path.join(ROOT, ".data", "citygen-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout"); }
class Cdp { #ws; #id = 1; #p = new Map(); errs = []; constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.method === "Runtime.exceptionThrown") this.errs.push(m.params?.exceptionDetails?.exception?.description || "exn"); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); } close() { this.#ws.close(); } }
async function evaluate(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function waitEval(c, e, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(c, e)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + e); }
async function tick(c, dt = 0.05) { try { await evaluate(c, `window.__sf.tick(${dt})`); } catch {} }
async function shot(c, name) { const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90 }); writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64")); console.log("  saved", name); }

// frame cost: N ticks, timing tick + GPU completion (perf-baseline idiom)
const MEASURE = `(async (n) => {
  const sf = window.__sf;
  const dev = sf.renderer.backend.device;
  const cpu = [], tot = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    sf.tick(1/60);
    const t1 = performance.now();
    await dev.queue.onSubmittedWorkDone();
    const t2 = performance.now();
    cpu.push(t1 - t0); tot.push(t2 - t0);
  }
  cpu.sort((a,b)=>a-b); tot.sort((a,b)=>a-b);
  const p = (arr, q) => arr[Math.floor(arr.length * q)];
  sf.renderer.info.autoReset = false; sf.renderer.info.reset();
  sf.tick(1/60);
  await dev.queue.onSubmittedWorkDone();
  const draws = sf.renderer.info.render.drawCalls ?? sf.renderer.info.render.calls;
  const tris = sf.renderer.info.render.triangles;
  sf.renderer.info.autoReset = true;
  return { cpuP50: p(cpu, 0.5), totP50: p(tot, 0.5), totP90: p(tot, 0.9), draws, tris };
})(60)`;

async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort();
  const relayPort = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}`, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-scale-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.citygenRing && window.__sf.citygenRing.current)", 120000);
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(10.5);
      s.dynRes.sample=()=>{};
      if(!window.__f){window.__f=1;s.chase.update=()=>{};s.player.update=()=>{};} return 1;})()`);
    const gy = await evaluate(c, "window.__sf.map.groundHeight(900,2400)");
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player;const y=${gy}+2;p.position.set(900,y,2400);p.renderPosition.copy(p.position);s.physics.world.setBodyTransform(p.body,[900,y,2400],[0,0,0,1]);return 1;})()`);
    for (let i = 0; i < 40; i++) await tick(c);
    await waitEval(c, "window.__sf.renderIdle && window.__sf.renderIdle()", 120000);
    // street-level oblique camera into the dense row (a realistic play view)
    await evaluate(c, `(()=>{const c=window.__sf.camera;c.position.set(880,${gy}+8,2385);c.lookAt(930,${gy}+8,2410);return 1;})()`);

    const RUNGS = [
      { r: 150, n: 40 },   // shipped defaults (baseline)
      { r: 400, n: 200 },
      { r: 700, n: 500 },
      { r: 1200, n: 1200 },
    ];
    for (const { r, n } of RUNGS) {
      await evaluate(c, `(()=>{const v=window.__sf.CITYGEN_TUNING.values; v.detailRadius=${r}; v.maxDetail=${n}; return 1;})()`);
      // let the ring build to plateau: keep ticking until detail count stops rising
      let last = -1, stable = 0;
      for (let i = 0; i < 600 && stable < 8; i++) {
        for (let k = 0; k < 5; k++) await tick(c);
        const st = await evaluate(c, "window.__sf.citygenRing.current.stats()");
        if (st.detail === last) stable++; else { stable = 0; last = st.detail; }
      }
      const stats = await evaluate(c, "window.__sf.citygenRing.current.stats()");
      const m = await evaluate(c, MEASURE);
      console.log(`[rung r=${r} max=${n}] detail=${stats.detail} interiors=${stats.interiors} | draws=${m.draws} tris=${(m.tris / 1e6).toFixed(2)}M | cpu p50=${m.cpuP50.toFixed(1)}ms tot p50=${m.totP50.toFixed(1)}ms p90=${m.totP90.toFixed(1)}ms`);
      await shot(c, `scale_r${r}_n${n}.jpg`);
    }
    console.log("[probe] page errors:", c.errs.length ? c.errs.slice(0, 5) : "none");
    c.close(); console.log("[probe] done");
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
