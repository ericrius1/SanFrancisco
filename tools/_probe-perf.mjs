// Real GPU frame-cost probe for the Chinatown ring.
//
// Method (per sf-app-perf-profile): freeze the world, then time renderer
// .renderAsync(scene,camera) — awaiting it is a valid per-frame GPU sync. Isolate
// the generated buildings' cost by toggling the 3 BatchedMesh pools + shadow-proxy
// pool .visible (INSTANT — never dispose(); disposing 72 buildings is ~600k
// deleteInstance calls and stalls the eval). Absolute ms/frame → implied fps.
//
//   node tools/_probe-perf.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = process.env.SF_OUT ?? "/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco/96e2d226-a5bb-4a84-ab31-2af9185c15aa/scratchpad";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue; return c;
  }
  throw new Error("no chrome");
}
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer(); s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function waitHttp(url, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); }
  throw new Error("http timeout " + url);
}
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); }
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.#p.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 60000);
      this.#p.set(id, { res: (v) => { clearTimeout(to); res(v); }, rej: (e) => { clearTimeout(to); rej(e); } });
    });
  }
  close() { this.#ws.close(); }
}
async function evaluate(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}
async function waitEval(c, expr, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (await evaluate(c, expr)) return; } catch {} await sleep(300); }
  throw new Error("eval timeout " + expr);
}
async function tick(c) { try { await evaluate(c, "window.__sf.tick(0.016)"); } catch {} }
async function shot(c, name) {
  const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
  const f = path.join(OUT, name);
  writeFileSync(f, Buffer.from(s.data, "base64"));
  console.log("  saved", f);
}

// Freeze the world then time renderAsync. Returns {avg,p50,p95,min} ms over n frames.
// `hideExpr` (optional) is JS that toggles visibility BEFORE the timed loop.
async function benchRender(c, n = 24) {
  return await evaluate(c, `(async()=>{
    const s=window.__sf, r=s.renderer, sc=s.scene, cam=s.camera;
    const times=[];
    for(let i=0;i<4;i++){ await r.renderAsync(sc,cam); }         // warm
    for(let i=0;i<${n};i++){ const t=performance.now(); await r.renderAsync(sc,cam); times.push(performance.now()-t); }
    times.sort((a,b)=>a-b);
    const avg=times.reduce((a,b)=>a+b,0)/times.length;
    return {avg:+avg.toFixed(2), p50:+times[times.length>>1].toFixed(2),
      p95:+times[Math.min(times.length-1,Math.floor(times.length*0.95))].toFixed(2),
      min:+times[0].toFixed(2), n:times.length};
  })()`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const relay = 8788;
  const vitePort = await freePort();
  const SERVER_URL = `http://127.0.0.1:${vitePort}`;
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  try {
    await waitHttp(SERVER_URL, 60000);
    chrome = spawn(chromePath, [
      `--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-perf")}`,
      "--headless=new", "--no-first-run", "--mute-audio",
      "--enable-features=SharedArrayBuffer", "--use-angle=metal",
      "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures",
      `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"
    ], { stdio: "ignore" });
    let t = Date.now();
    while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl);
    await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player)", 120000);
    console.log("[perf] booted");

    // freeze cycle + neutralise aiCars + freeze camera/player so the timed frames
    // render an identical scene each call
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(13.5);
      try{ if(s.aiCars){ s.aiCars.prePhysics=()=>{}; s.aiCars.update=()=>{}; if(s.aiCars.postPhysics)s.aiCars.postPhysics=()=>{}; } }catch{}
      if(!window.__frozen){window.__frozen=true; s.chase.update=()=>{}; s.player.update=()=>{}; } return 1;})()`);

    const CX = 3300, CZ = -400;
    const CY = await evaluate(c, `+window.__sf.map.groundHeight(${CX},${CZ}).toFixed(2)`);

    // stream tiles + ring in: place player, tick the real update via manual pump
    // (update() is cheap — only dispose is O(instances), and we never dispose)
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=${CY}+1.5;
      p.position.set(${CX},y,${CZ}); p.renderPosition.set(${CX},y,${CZ});
      s.physics.world.setBodyTransform(p.body,[${CX},y,${CZ}],[0,0,0,1]); return 1;})()`);
    for (let i = 0; i < 50; i++) { await tick(c); }
    await sleep(1000);
    console.log("[perf] streaming ring...");
    for (let k = 0; k < 40; k++) {
      await evaluate(c, `(()=>{const s=window.__sf,p=s.player; s.buildings.current.update(p.position,0.25); return 1;})()`);
      await tick(c);
      await sleep(180);
      const st = await evaluate(c, "window.__sf.buildings.current.stats()");
      if (st.loaded >= 80 || (st.loaded > 0 && st.loading === 0 && k > 20)) break;
    }
    const ring = await evaluate(c, "window.__sf.buildings.current.stats()");
    console.log("[perf] ring:", JSON.stringify(ring));

    // helper to toggle the generated-building render layers
    const setVis = async (v) => evaluate(c, `(()=>{let n=0; window.__sf.scene.traverse(o=>{
      if(o.isBatchedMesh || o.name==='buildingShadowProxies' || o.name==='generatedBuilding'){ o.visible=${v}; n++; }}); return n;})()`);

    // === street-level view (the gameplay-relevant camera) ===
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${CX},${CY + 1.7},${CZ}); c.lookAt(${CX + 30},${CY + 8},${CZ + 6}); return 1;})()`);
    await tick(c); await sleep(200);
    await shot(c, "perf_street_view.jpg");
    await setVis(true);  const streetWith = await benchRender(c, 24);
    await setVis(false); const streetWithout = await benchRender(c, 24);
    await setVis(true);
    console.log("[perf] STREET  with:", JSON.stringify(streetWith), " without:", JSON.stringify(streetWithout),
      " delta_avg:", +(streetWith.avg - streetWithout.avg).toFixed(2), "ms");

    // === aerial view (worst case — whole ring on screen) ===
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${CX - 120},${CY + 150},${CZ + 170}); c.lookAt(${CX},${CY + 10},${CZ}); return 1;})()`);
    await tick(c); await sleep(200);
    await setVis(true);  const airWith = await benchRender(c, 24);
    await setVis(false); const airWithout = await benchRender(c, 24);
    await setVis(true);
    console.log("[perf] AERIAL  with:", JSON.stringify(airWith), " without:", JSON.stringify(airWithout),
      " delta_avg:", +(airWith.avg - airWithout.avg).toFixed(2), "ms");

    console.log("[perf] implied fps @street:", +(1000 / streetWith.avg).toFixed(1),
      " @aerial:", +(1000 / airWith.avg).toFixed(1), " (baseline no-ring @street:", +(1000 / streetWithout.avg).toFixed(1), ")");
    c.close();
    console.log("[perf] done");
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
