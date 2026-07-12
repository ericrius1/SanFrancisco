// GPU COST BREAKDOWN for the citygen detail render.
//
// Boots the app, drives to the dense downtown row used by citygen-scale-probe,
// plateaus a HEAVY detail set (detailRadius/maxDetail cranked), then ablates one
// GPU cost-center at a time and reports the GPU-synced frame delta.
//
// Answers:
//  1. fragment/overdraw-bound vs geometry-bound  (resolution / pixel-ratio sweep)
//  2. ms deltas: instanced glass, window trim, wall bundles, shadows, dpr/2
//  3. ranked cost centers
//  4. alphaHash-always + DoubleSide glass cost (early-Z / overdraw hypothesis)
//
//   node tools/gpu-cost-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, mkdirSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = path.join(ROOT, ".data", "gpu-cost");
const DETAIL_R = Number(process.env.SF_R ?? 700);
const DETAIL_N = Number(process.env.SF_N ?? 500);
const WARM = 40, MEASURE = 110;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout"); }
class Cdp { #ws; #id = 1; #p = new Map(); errs = []; constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.method === "Runtime.exceptionThrown") this.errs.push(m.params?.exceptionDetails?.exception?.description || "exn"); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); } close() { this.#ws.close(); } }
async function ev(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; }
async function waitEval(c, e, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(c, e)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + e); }
async function tick(c, dt = 0.05) { try { await ev(c, `window.__sf.tick(${dt})`); } catch {} }

// GPU-synced frame timing: WARM ticks, then MEASURE ticks timing tick+fence.
const MEASURE_EXPR = `(async () => {
  const sf = window.__sf, dev = sf.renderer.backend.device;
  const cpu = [], tot = [];
  for (let i = 0; i < ${WARM}; i++) { sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); }
  for (let i = 0; i < ${MEASURE}; i++) {
    const t0 = performance.now(); sf.tick(1/60);
    const t1 = performance.now(); await dev.queue.onSubmittedWorkDone();
    cpu.push(t1 - t0); tot.push(performance.now() - t0);
  }
  cpu.sort((a,b)=>a-b); tot.sort((a,b)=>a-b);
  const p = (a,q) => +a[Math.floor(a.length*q)].toFixed(2);
  sf.renderer.info.autoReset = false; sf.renderer.info.reset();
  sf.tick(1/60); await dev.queue.onSubmittedWorkDone();
  const draws = sf.renderer.info.render.drawCalls ?? sf.renderer.info.render.calls;
  const tris = sf.renderer.info.render.triangles;
  sf.renderer.info.autoReset = true;
  return { cpu: p(cpu,0.5), tot: p(tot,0.5), tot90: p(tot,0.9), draws, tris };
})()`;

// Scene helpers evaluated in-page. Return counts so we can confirm toggles hit.
const HELPERS = `(() => {
  const sf = window.__sf, THREE = sf.THREE;
  const glass = [], trim = [], bundles = [], bakedGlass = [];
  let glassMat = null, trimMat = null;
  sf.scene.traverse(o => {
    if (o.name && o.name.startsWith("cityGenModules.")) {
      if (o.name.endsWith(".glass")) { glass.push(o); glassMat = o.material; }
      else if (o.name.endsWith(".trim")) { trim.push(o); trimMat = o.material; }
    }
    if (o.name === "cityGenBuilding" && o.isBundleGroup) bundles.push(o);
    if (o.name === "glass" && o.isMesh) bakedGlass.push(o);
  });
  window.__gp = { glass, trim, bundles, bakedGlass, glassMat, trimMat,
    basePR: sf.renderer.getPixelRatio(),
    glassSide0: glassMat && glassMat.side, glassAH0: glassMat && glassMat.alphaHash,
    trimAH0: trimMat && trimMat.alphaHash };
  return { glass: glass.length, trim: trim.length, bundles: bundles.length,
           bakedGlass: bakedGlass.length, basePR: window.__gp.basePR };
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const vitePort = await freePort(), relayPort = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  const rows = [];
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}`, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.citygenRing && window.__sf.citygenRing.current)", 120000);
    await ev(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(10.5); s.dynRes.sample=()=>{};
      if(!window.__f){window.__f=1;s.chase.update=()=>{};s.player.update=()=>{};} return 1;})()`);
    const gy = await ev(c, "window.__sf.map.groundHeight(900,2400)");
    await ev(c, `(()=>{const s=window.__sf,p=s.player;const y=${gy}+2;p.position.set(900,y,2400);p.renderPosition.copy(p.position);s.physics.world.setBodyTransform(p.body,[900,y,2400],[0,0,0,1]);return 1;})()`);
    for (let i = 0; i < 40; i++) await tick(c);
    await waitEval(c, "window.__sf.renderIdle && window.__sf.renderIdle()", 120000);
    await ev(c, `(()=>{const c=window.__sf.camera;c.position.set(880,${gy}+8,2385);c.lookAt(930,${gy}+8,2410);return 1;})()`);
    // crank detail set and plateau
    await ev(c, `(()=>{const v=window.__sf.CITYGEN_TUNING.values; v.detailRadius=${DETAIL_R}; v.maxDetail=${DETAIL_N}; return 1;})()`);
    let last = -1, stable = 0;
    for (let i = 0; i < 800 && stable < 10; i++) {
      for (let k = 0; k < 5; k++) await tick(c);
      const st = await ev(c, "window.__sf.citygenRing.current.stats()");
      if (st.detail === last) stable++; else { stable = 0; last = st.detail; }
    }
    const stats = await ev(c, "window.__sf.citygenRing.current.stats()");
    const mods = await ev(c, "window.__sf.citygenRing.current.moduleStats ? window.__sf.citygenRing.current.moduleStats() : null").catch(() => null);
    const h = await ev(c, HELPERS);
    console.log(`[plateau] detail=${stats.detail} interiors=${stats.interiors} | glassMeshes=${h.glass} trimMeshes=${h.trim} bundles=${h.bundles} bakedGlass=${h.bakedGlass} basePR=${h.basePR}`);

    const run = async (label, note = "") => {
      const m = await ev(c, MEASURE_EXPR);
      rows.push({ label, ...m, note });
      console.log(`  ${label.padEnd(40)} tot ${String(m.tot).padStart(6)}ms  cpu ${String(m.cpu).padStart(5)}ms  draws ${String(m.draws).padStart(4)}  tris ${(m.tris/1e6).toFixed(2)}M  ${note}`);
      return m;
    };

    // ---- BASELINE ----
    const base = await run("BASE (all on)");

    // ---- 1. RESOLUTION / PIXEL-RATIO SWEEP (fragment vs geometry) ----
    const setPR = (pr) => ev(c, `(()=>{const s=window.__sf; s.renderer.setPixelRatio(${pr}); s.renderer.setSize(window.innerWidth, window.innerHeight); return s.renderer.getPixelRatio();})()`);
    for (const pr of [0.5, 0.75, 1.0, 1.5, 2.0]) { await setPR(pr); await run(`pixelRatio ${pr.toFixed(2)}`, `(base ${h.basePR})`); }
    await setPR(h.basePR); // restore

    // ---- 2. ABLATE COST CENTERS ----
    const show = (arr, v) => ev(c, `(()=>{window.__gp.${arr}.forEach(o=>o.visible=${v}); return window.__gp.${arr}.length;})()`);

    await show("glass", false); await run("(a) instanced GLASS hidden"); await show("glass", true);
    await show("trim", false); await run("(b) instanced TRIM hidden"); await show("trim", true);
    await show("glass", false); await show("trim", false); await run("(a+b) all instanced windows hidden"); await show("glass", true); await show("trim", true);
    // hide whole detail bundles (walls+roof+trim boxes+doors)
    await ev(c, `(()=>{window.__gp.bundles.forEach(o=>{o.visible=false;o.needsUpdate=true;}); return 1;})()`);
    await run("(c) detail BUNDLES hidden (walls+roof+doors)");
    await ev(c, `(()=>{window.__gp.bundles.forEach(o=>{o.visible=true;o.needsUpdate=true;}); return 1;})()`);
    // everything citygen off (bundles + instanced windows) = pure world floor
    await show("glass", false); await show("trim", false);
    await ev(c, `(()=>{window.__gp.bundles.forEach(o=>{o.visible=false;o.needsUpdate=true;}); return 1;})()`);
    await run("(a+b+c) ALL citygen detail hidden");
    await show("glass", true); await show("trim", true);
    await ev(c, `(()=>{window.__gp.bundles.forEach(o=>{o.visible=true;o.needsUpdate=true;}); return 1;})()`);

    // ---- 3. SHADOWS ----
    await ev(c, `(()=>{const s=window.__sf; s.renderer.shadowMap.enabled=false; return 1;})()`);
    await run("(d) CSM shadows OFF");
    await ev(c, `(()=>{const s=window.__sf; s.renderer.shadowMap.enabled=true; return 1;})()`);

    // ---- 4. GLASS MATERIAL HYPOTHESES (DoubleSide / alphaHash) ----
    const THREE_FRONT = 0; // THREE.FrontSide
    // glass -> single sided
    await ev(c, `(()=>{const m=window.__gp.glassMat; if(m){m.side=${THREE_FRONT}; m.needsUpdate=true;} return m?m.side:-1;})()`);
    await run("(g1) glass FrontSide (was DoubleSide)");
    await ev(c, `(()=>{const m=window.__gp.glassMat; if(m){m.side=window.__gp.glassSide0; m.needsUpdate=true;} return 1;})()`);
    // glass alphaHash off
    await ev(c, `(()=>{const m=window.__gp.glassMat; if(m){m.alphaHash=false; m.transparent=false; m.needsUpdate=true;} return 1;})()`);
    await run("(g2) glass alphaHash OFF");
    await ev(c, `(()=>{const m=window.__gp.glassMat; if(m){m.alphaHash=window.__gp.glassAH0; m.needsUpdate=true;} return 1;})()`);
    // trim alphaHash off
    await ev(c, `(()=>{const m=window.__gp.trimMat; if(m){m.alphaHash=false; m.transparent=false; m.needsUpdate=true;} return 1;})()`);
    await run("(g3) trim alphaHash OFF");
    await ev(c, `(()=>{const m=window.__gp.trimMat; if(m){m.alphaHash=window.__gp.trimAH0; m.needsUpdate=true;} return 1;})()`);
    // both window mats: single-sided glass + alphaHash off on both (settled-ideal)
    await ev(c, `(()=>{const g=window.__gp.glassMat,t=window.__gp.trimMat;
      if(g){g.side=${THREE_FRONT}; g.alphaHash=false; g.transparent=false; g.needsUpdate=true;}
      if(t){t.alphaHash=false; t.transparent=false; t.needsUpdate=true;} return 1;})()`);
    await run("(g4) glass FrontSide + both alphaHash OFF");
    await ev(c, `(()=>{const g=window.__gp.glassMat,t=window.__gp.trimMat;
      if(g){g.side=window.__gp.glassSide0; g.alphaHash=window.__gp.glassAH0; g.needsUpdate=true;}
      if(t){t.alphaHash=window.__gp.trimAH0; t.needsUpdate=true;} return 1;})()`);

    // ---- BASE re-measure (drift check) ----
    await run("BASE re-check");

    console.log("\n[summary] deltas vs BASE (tot p50):");
    for (const r of rows) console.log(`  ${r.label.padEnd(40)} ${String(r.tot).padStart(6)}ms  Δ ${(r.tot - base.tot >= 0 ? "+" : "") + (r.tot - base.tot).toFixed(2)}ms`);
    console.log("[probe] page errors:", c.errs.length ? c.errs.slice(0, 4) : "none");
    writeFileSync(path.join(OUT, "gpu-cost.json"), JSON.stringify({ stats, mods, helpers: h, rows }, null, 2));
    console.log("[probe] wrote", path.join(OUT, "gpu-cost.json"));
    c.close();
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
