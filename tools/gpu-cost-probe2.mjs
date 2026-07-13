// GPU COST BREAKDOWN — round 2: drift-controlled A/B/A + resolution VERIFICATION.
//
// Round 1 found: flat pixelRatio sweep (suspicious), detail bundles = ~10.5ms,
// instanced windows ~free, and ~+3.8ms thermal upward drift over the run that
// contaminated the late alphaHash rows. This probe:
//   - VERIFIES the framebuffer actually resizes with pixelRatio (reads real px)
//   - interleaves a fresh BASE before/after every ablation (drift control)
//   - confirms draw-count vs fragment vs vertex with half-bundle + tiny-canvas
//
//   node tools/gpu-cost-probe2.mjs
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
const WARM = 30, MEASURE = 90;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout"); }
class Cdp { #ws; #id = 1; #p = new Map(); errs = []; constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.method === "Runtime.exceptionThrown") this.errs.push(m.params?.exceptionDetails?.exception?.description || "exn"); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); } close() { this.#ws.close(); } }
async function ev(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; }
async function waitEval(c, e, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(c, e)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + e); }
async function tick(c, dt = 0.05) { try { await ev(c, `window.__sf.tick(${dt})`); } catch {} }

const MEASURE_EXPR = `(async () => {
  const sf = window.__sf, dev = sf.renderer.backend.device;
  const tot = [];
  for (let i = 0; i < ${WARM}; i++) { sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); }
  for (let i = 0; i < ${MEASURE}; i++) { const t0 = performance.now(); sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); tot.push(performance.now() - t0); }
  tot.sort((a,b)=>a-b);
  return +tot[Math.floor(tot.length*0.5)].toFixed(2);
})()`;

// count draws on a SHADOW-render frame vs a NON-shadow frame (throttle alternates)
const DRAWCOUNT_EXPR = `(async () => {
  const sf = window.__sf, dev = sf.renderer.backend.device, info = sf.renderer.info;
  info.autoReset = false;
  const sample = async () => { info.reset(); sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); return { d: info.render.drawCalls ?? info.render.calls, t: info.render.triangles }; };
  let lo = { d: 1e9 }, hi = { d: -1 };
  for (let i = 0; i < 8; i++) { const s = await sample(); if (s.d < lo.d) lo = s; if (s.d > hi.d) hi = s; }
  info.autoReset = true;
  return { minDraws: lo.d, minTris: lo.t, maxDraws: hi.d, maxTris: hi.t };
})()`;

const RESVERIFY = (pr) => `(()=>{const s=window.__sf; s.renderer.setPixelRatio(${pr}); s.renderer.setSize(window.innerWidth, window.innerHeight);
  const sz = s.renderer.getDrawingBufferSize ? s.renderer.getDrawingBufferSize(new s.THREE.Vector2()) : {x:-1,y:-1};
  const el = s.renderer.domElement;
  return { pr: s.renderer.getPixelRatio(), bufW: sz.x, bufH: sz.y, elW: el.width, elH: el.height };
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const vitePort = await freePort(), relayPort = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  const log = [];
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}`, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome2-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.citygenRing && window.__sf.citygenRing.current)", 120000);
    await ev(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(10.5);
      if(!window.__f){window.__f=1;s.chase.update=()=>{};s.player.update=()=>{};} return 1;})()`);
    const gy = await ev(c, "window.__sf.map.groundHeight(900,2400)");
    await ev(c, `(()=>{const s=window.__sf,p=s.player;const y=${gy}+2;p.position.set(900,y,2400);p.renderPosition.copy(p.position);s.physics.world.setBodyTransform(p.body,[900,y,2400],[0,0,0,1]);return 1;})()`);
    for (let i = 0; i < 40; i++) await tick(c);
    await waitEval(c, "window.__sf.renderIdle && window.__sf.renderIdle()", 120000);
    await ev(c, `(()=>{const c=window.__sf.camera;c.position.set(880,${gy}+8,2385);c.lookAt(930,${gy}+8,2410);return 1;})()`);
    await ev(c, `(()=>{const v=window.__sf.CITYGEN_TUNING.values; v.detailRadius=${DETAIL_R}; v.maxDetail=${DETAIL_N}; return 1;})()`);
    let last = -1, stable = 0;
    for (let i = 0; i < 800 && stable < 10; i++) { for (let k = 0; k < 5; k++) await tick(c); const st = await ev(c, "window.__sf.citygenRing.current.stats()"); if (st.detail === last) stable++; else { stable = 0; last = st.detail; } }
    const stats = await ev(c, "window.__sf.citygenRing.current.stats()");
    // handles
    await ev(c, `(() => { const sf = window.__sf; const glass = [], trim = [], bundles = [];
      sf.scene.traverse(o => { if (o.name && o.name.startsWith("cityGenModules.")) { if (o.name.endsWith(".glass")) glass.push(o); else if (o.name.endsWith(".trim")) trim.push(o); } if (o.name === "cityGenBuilding" && o.isBundleGroup) bundles.push(o); });
      window.__gp = { glass, trim, bundles, glassMat: glass[0] && glass[0].material, trimMat: trim[0] && trim[0].material, side0: glass[0] && glass[0].material.side, gAH: glass[0] && glass[0].material.alphaHash, tAH: trim[0] && trim[0].material.alphaHash }; return bundles.length; })()`);
    const dc = await ev(c, DRAWCOUNT_EXPR);
    console.log(`[plateau] detail=${stats.detail} | draws: non-shadow=${dc.minDraws} shadow-frame=${dc.maxDraws} | tris: ${(dc.minTris/1e6).toFixed(2)}M / ${(dc.maxTris/1e6).toFixed(2)}M`);

    // ---- RESOLUTION VERIFICATION (does the framebuffer actually resize?) ----
    console.log("\n[resolution verify + timing]");
    for (const pr of [0.5, 1.0, 2.0, 3.0]) {
      const rv = await ev(c, RESVERIFY(pr));
      const ms = await ev(c, MEASURE_EXPR);
      console.log(`  pr ${pr.toFixed(2)} -> buffer ${rv.bufW}x${rv.bufH} (el ${rv.elW}x${rv.elH})  = ${ms}ms`);
      log.push({ test: `pr${pr}`, buf: `${rv.bufW}x${rv.bufH}`, ms });
    }
    await ev(c, RESVERIFY(1.0));

    // ---- DRIFT-CONTROLLED A/B/A ablations ----
    console.log("\n[drift-controlled ablations: base | test | base]");
    const meas = () => ev(c, MEASURE_EXPR);
    const aba = async (label, on, off) => {
      const b0 = await meas();
      await ev(c, on); const x = await meas(); await ev(c, off);
      const b1 = await meas();
      const base = (b0 + b1) / 2;
      const delta = +(x - base).toFixed(2);
      console.log(`  ${label.padEnd(38)} base ${b0.toFixed(1)}/${b1.toFixed(1)}  test ${x.toFixed(1)}  Δ ${delta >= 0 ? "+" : ""}${delta}ms`);
      log.push({ test: label, base0: b0, base1: b1, val: x, delta });
      return delta;
    };

    const showBundles = (v) => `(()=>{window.__gp.bundles.forEach(o=>{o.visible=${v};o.needsUpdate=true;}); return 1;})()`;
    const showHalf = (v) => `(()=>{window.__gp.bundles.forEach((o,i)=>{ if(i%2===0){o.visible=${v};o.needsUpdate=true;} }); return 1;})()`;
    const showArr = (a, v) => `(()=>{window.__gp.${a}.forEach(o=>o.visible=${v}); return 1;})()`;

    await aba("(c) ALL detail bundles hidden", showBundles(false), showBundles(true));
    await aba("(c/2) HALF detail bundles hidden", showHalf(false), showHalf(true));
    await aba("(a) instanced glass hidden", showArr("glass", false), showArr("glass", true));
    await aba("(b) instanced trim hidden", showArr("trim", false), showArr("trim", true));
    await aba("(d) shadows OFF", `(()=>{window.__sf.renderer.shadowMap.enabled=false;return 1;})()`, `(()=>{window.__sf.renderer.shadowMap.enabled=true;return 1;})()`);
    await aba("(g1) glass FrontSide", `(()=>{const m=window.__gp.glassMat;m.side=0;m.needsUpdate=true;return 1;})()`, `(()=>{const m=window.__gp.glassMat;m.side=window.__gp.side0;m.needsUpdate=true;return 1;})()`);
    await aba("(g2) glass alphaHash OFF", `(()=>{const m=window.__gp.glassMat;m.alphaHash=false;m.transparent=false;m.needsUpdate=true;return 1;})()`, `(()=>{const m=window.__gp.glassMat;m.alphaHash=window.__gp.gAH;m.transparent=false;m.needsUpdate=true;return 1;})()`);
    await aba("(g3) trim alphaHash OFF", `(()=>{const m=window.__gp.trimMat;m.alphaHash=false;m.transparent=false;m.needsUpdate=true;return 1;})()`, `(()=>{const m=window.__gp.trimMat;m.alphaHash=window.__gp.tAH;m.transparent=false;m.needsUpdate=true;return 1;})()`);
    // detail bundles: stop casting shadows (isolates shadow-pass draw cost of bundles)
    await aba("(d2) detail bundles castShadow OFF",
      `(()=>{window.__gp.bundles.forEach(g=>{g.traverse(o=>{if(o.isMesh)o.castShadow=false;});g.needsUpdate=true;});return 1;})()`,
      `(()=>{window.__gp.bundles.forEach(g=>{g.traverse(o=>{if(o.isMesh)o.castShadow=true;});g.needsUpdate=true;});return 1;})()`);

    writeFileSync(path.join(OUT, "gpu-cost2.json"), JSON.stringify({ stats, drawCounts: dc, log }, null, 2));
    console.log("\n[probe] errors:", c.errs.length ? c.errs.slice(0, 4) : "none");
    console.log("[probe] wrote", path.join(OUT, "gpu-cost2.json"));
    c.close();
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
