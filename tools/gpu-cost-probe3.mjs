// GPU COST BREAKDOWN — round 3: structural draw-count census + COLD headline deltas.
// Bundles hide the child draws from renderer.info (replay doesn't re-increment),
// but the GPU still executes every child mesh. Count the TRUE per-building
// sub-draws and per-material distribution, then measure the 4 headline ablations
// FIRST (cold) before thermal drift sets in.
//   node tools/gpu-cost-probe3.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, mkdirSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = path.join(ROOT, ".data", "gpu-cost");
const DETAIL_R = Number(process.env.SF_R ?? 700), DETAIL_N = Number(process.env.SF_N ?? 500);
const WARM = 25, MEASURE = 80;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout"); }
class Cdp { #ws; #id = 1; #p = new Map(); errs = []; constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.method === "Runtime.exceptionThrown") this.errs.push(m.params?.exceptionDetails?.exception?.description || "exn"); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); } close() { this.#ws.close(); } }
async function ev(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; }
async function waitEval(c, e, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(c, e)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + e); }
async function tick(c, dt = 0.05) { try { await ev(c, `window.__sf.tick(${dt})`); } catch {} }
const MEAS = `(async () => { const sf=window.__sf,dev=sf.renderer.backend.device,tot=[];
  for(let i=0;i<${WARM};i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}
  for(let i=0;i<${MEASURE};i++){const t0=performance.now();sf.tick(1/60);await dev.queue.onSubmittedWorkDone();tot.push(performance.now()-t0);}
  tot.sort((a,b)=>a-b); return +tot[Math.floor(tot.length*0.5)].toFixed(2); })()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const vitePort = await freePort(), relayPort = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}`, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome3-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.citygenRing && window.__sf.citygenRing.current)", 120000);
    await ev(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(10.5); if(!window.__f){window.__f=1;s.chase.update=()=>{};s.player.update=()=>{};} return 1;})()`);
    const gy = await ev(c, "window.__sf.map.groundHeight(900,2400)");
    await ev(c, `(()=>{const s=window.__sf,p=s.player;const y=${gy}+2;p.position.set(900,y,2400);p.renderPosition.copy(p.position);s.physics.world.setBodyTransform(p.body,[900,y,2400],[0,0,0,1]);return 1;})()`);
    for (let i = 0; i < 40; i++) await tick(c);
    await waitEval(c, "window.__sf.renderIdle && window.__sf.renderIdle()", 120000);
    await ev(c, `(()=>{const c=window.__sf.camera;c.position.set(880,${gy}+8,2385);c.lookAt(930,${gy}+8,2410);return 1;})()`);
    await ev(c, `(()=>{const v=window.__sf.CITYGEN_TUNING.values; v.detailRadius=${DETAIL_R}; v.maxDetail=${DETAIL_N}; return 1;})()`);
    let last = -1, stable = 0;
    for (let i = 0; i < 800 && stable < 10; i++) { for (let k = 0; k < 5; k++) await tick(c); const st = await ev(c, "window.__sf.citygenRing.current.stats()"); if (st.detail === last) stable++; else { stable = 0; last = st.detail; } }
    const stats = await ev(c, "window.__sf.citygenRing.current.stats()");

    // ---- STRUCTURAL CENSUS: true GPU sub-draw count for detail bundles ----
    const census = await ev(c, `(() => {
      const sf = window.__sf; const bundles = []; const glass = [], trim = [];
      sf.scene.traverse(o => { if (o.name === "cityGenBuilding" && o.isBundleGroup) bundles.push(o);
        if (o.name && o.name.startsWith("cityGenModules.")) { if (o.name.endsWith(".glass")) glass.push(o); else if (o.name.endsWith(".trim")) trim.push(o); } });
      let childTotal = 0, triTotal = 0; const byMat = {}; const perBuilding = [];
      for (const b of bundles) { let n = 0; b.traverse(o => { if (o.isMesh) { n++; childTotal++;
        const nm = o.name || "?"; byMat[nm] = (byMat[nm]||0)+1;
        const idx = o.geometry && o.geometry.index; if (idx) triTotal += idx.count/3; } }); perBuilding.push(n); }
      perBuilding.sort((a,b)=>a-b);
      const p50 = perBuilding[perBuilding.length>>1] || 0;
      let winInst = 0; for (const m of [...glass, ...trim]) winInst += (m.geometry && m.geometry.instanceCount) || 0;
      window.__gp = { bundles, glass, trim };
      return { bundles: bundles.length, childTotal, childPerBuilding_p50: p50, childPerBuilding_min: perBuilding[0], childPerBuilding_max: perBuilding[perBuilding.length-1],
        bundleTris: Math.round(triTotal), byMat, windowMeshes: glass.length+trim.length, windowInstances: winInst };
    })()`);
    console.log(`[census] detail buildings=${census.bundles}`);
    console.log(`  detail-bundle child MESHES (= GPU sub-draws/frame, main pass): ${census.childTotal}  (per building: min ${census.childPerBuilding_min} / p50 ${census.childPerBuilding_p50} / max ${census.childPerBuilding_max})`);
    console.log(`  detail-bundle triangles: ${(census.bundleTris/1e6).toFixed(2)}M`);
    console.log(`  child mesh count by material:`, JSON.stringify(census.byMat));
    console.log(`  instanced window: ${census.windowMeshes} meshes carrying ${census.windowInstances} instances (ALL city windows) = ${census.windowMeshes} GPU draws`);
    console.log(`  => main-pass GPU draw ratio: ${census.childTotal} (bundles) vs ${census.windowMeshes} (all windows)`);

    // ---- COLD headline ablations, A/B/A, most important first ----
    console.log("\n[cold headline ablations]");
    const meas = () => ev(c, MEAS);
    const aba = async (label, on, off) => { const b0 = await meas(); await ev(c, on); const x = await meas(); await ev(c, off); const b1 = await meas();
      const d = +(x - (b0 + b1) / 2).toFixed(2); console.log(`  ${label.padEnd(34)} base ${b0.toFixed(1)}/${b1.toFixed(1)}  test ${x.toFixed(1)}  Δ ${d>=0?"+":""}${d}ms`); return d; };
    const SB = (v) => `(()=>{window.__gp.bundles.forEach(o=>{o.visible=${v};o.needsUpdate=true;});return 1;})()`;
    const SH = (v) => `(()=>{window.__gp.bundles.forEach((o,i)=>{if(i%2===0){o.visible=${v};o.needsUpdate=true;}});return 1;})()`;
    const SW = (v) => `(()=>{[...window.__gp.glass,...window.__gp.trim].forEach(o=>o.visible=${v});return 1;})()`;
    await aba("ALL detail bundles hidden", SB(false), SB(true));
    await aba("HALF detail bundles hidden", SH(false), SH(true));
    await aba("ALL instanced windows hidden", SW(false), SW(true));
    await aba("CSM shadows OFF", `(()=>{window.__sf.renderer.shadowMap.enabled=false;return 1;})()`, `(()=>{window.__sf.renderer.shadowMap.enabled=true;return 1;})()`);

    writeFileSync(path.join(OUT, "gpu-cost3.json"), JSON.stringify({ stats, census }, null, 2));
    console.log("\n[probe] errors:", c.errs.length ? c.errs.slice(0, 4) : "none");
    console.log("[probe] wrote", path.join(OUT, "gpu-cost3.json"));
    c.close();
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
