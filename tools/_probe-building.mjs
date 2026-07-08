// Phase-0 generated-building probe: boots the app on its OWN vite (fresh port,
// SF_RELAY_PORT=8788), waits for the generated building to load, probes the site
// for water/flatness, screenshots exterior + interior, and reports perf.
//
//   node tools/_probe-building.mjs
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
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); }
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
// drive one frame, ignoring unrelated in-app tick errors (e.g. the WIP aiCars
// learner throws when driven by manual tick() before it initialises).
async function tick(c) { try { await evaluate(c, "window.__sf.tick(0.016)"); } catch {} }
async function shot(c, name) {
  const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
  const f = path.join(OUT, name);
  writeFileSync(f, Buffer.from(s.data, "base64"));
  console.log("  saved", f);
  return f;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const relay = 8788;
  const vitePort = await freePort();
  const SERVER_URL = `http://127.0.0.1:${vitePort}`;
  // detached → own process group, so cleanup kills vite too (not just the npm
  // wrapper; an orphaned vite would keep holding the relay port for later runs)
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  try {
    await waitHttp(SERVER_URL, 60000);
    chrome = spawn(chromePath, [
      `--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-bld")}`,
      "--headless=new", "--no-first-run", "--mute-audio",
      "--enable-features=SharedArrayBuffer", "--use-angle=metal",
      "--enable-unsafe-webgpu", "--enable-gpu",
      "--enable-features=WebGPUDeveloperFeatures",
      `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"
    ], { stdio: "ignore" });

    let ver, t = Date.now();
    while (Date.now() - t < 15000) { try { ver = await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl);
    await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    // surface page console
    c.send("Log.enable").catch(() => {});
    await c.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player)", 120000);
    console.log("[probe] app booted");

    // freeze daytime for clear shots; neutralise the WIP aiCars module whose
    // learner throws under manual tick() (unrelated to buildings) and otherwise
    // aborts the frame before buildings.update() / destabilises the context.
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(13.5);
      try{ if(s.aiCars){ s.aiCars.prePhysics=()=>{}; s.aiCars.update=()=>{}; if(s.aiCars.postPhysics) s.aiCars.postPhysics=()=>{}; } }catch{}
      return 1;})()`);

    // --- site probe: is the chosen spot dry & flat? ---
    const site = await evaluate(c, `(()=>{const m=window.__sf.map; const pts={};
      for(const [n,x,z] of [["site",200,-1800]]){
        pts[n]={g:+m.groundHeight(x,z).toFixed(2), water:m.isWater(x,z), st:m.surfaceType(x,z)};
      } return pts;})()`);
    console.log("[probe] site samples:", JSON.stringify(site));

    // --- wait for the generated STREET to load (20 buildings; 20MB glb once) ---
    await waitEval(c, "Boolean(window.__sf.buildings && window.__sf.buildings.current && window.__sf.buildings.current.list && window.__sf.buildings.current.list.length>0)", 120000);
    const streetInfo = await evaluate(c, `(()=>{const st=window.__sf.buildings.current;
      const addMs=st.addMs.map(v=>+v.toFixed(1));
      const total=addMs.reduce((a,b)=>a+b,0);
      return {stats:st.stats(), addMsPerBuilding:addMs, addMsTotal:+total.toFixed(1),
        addMsAvg:+(total/addMs.length).toFixed(2)};})()`);
    console.log("[probe] street:", JSON.stringify(streetInfo));

    // freeze chase camera so we can free-drive
    await evaluate(c, `(()=>{const s=window.__sf; if(!window.__camFrozen){window.__camFrozen=true; s.chase.update=()=>{};} return 1;})()`);

    const CX = 200, CZ = -1800;
    const CY = site.site.g;

    // --- STREET wide shot: high, looking down the street axis (+x) ---
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${CX-110},${CY+26},${CZ+2}); c.lookAt(${CX+40},${CY+8},${CZ}); return 1;})()`);
    for (let i=0;i<25;i++){ await tick(c); }
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera; c.position.set(${CX-110},${CY+26},${CZ+2}); c.lookAt(${CX+40},${CY+8},${CZ}); return 1;})()`);
    await sleep(500);
    await shot(c, "street_exterior.jpg");

    // --- SHADOW evidence: afternoon sun, camera looking at building + its ground
    //     shadow from the shaded side ---
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.setTimeOfDay(15.5); return 1;})()`);
    const b0 = await evaluate(c, `(()=>{const b=window.__sf.buildings.current.list[2];
      return {p:b.group.position.toArray(), dims:b.dims};})()`);
    const [s0x,s0y,s0z] = b0.p;
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${s0x+30},${s0y+16},${s0z+34}); c.lookAt(${s0x},${s0y+4},${s0z}); return 1;})()`);
    for (let i=0;i<15;i++){ await tick(c); }
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera; c.position.set(${s0x+30},${s0y+16},${s0z+34}); c.lookAt(${s0x},${s0y+4},${s0z}); return 1;})()`);
    await sleep(400);
    await shot(c, "building_shadow.jpg");
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.setTimeOfDay(13.5); return 1;})()`);

    // --- interior of one street building: teleport player inside, verify lazy
    //     build, screenshot. update() called directly (aiCars-crash-proof). ---
    const bi = await evaluate(c, `(()=>{const st=window.__sf.buildings.current;
      const b=st.list[2]; const p=window.__sf.player; const [bx,by,bz]=b.group.position.toArray();
      p.position.set(bx,by+1.2,bz); p.renderPosition.set(bx,by+1.2,bz);
      window.__sf.physics.world.setBodyTransform(p.body,[bx,by+1.2,bz],[0,0,0,1]);
      for(let i=0;i<3;i++) st.update(p.position,0.016);
      return {p:[bx,by,bz], dims:b.dims, built:b.stats.interiorBuilt, meshes:b.stats.interiorMeshes,
        interiorsBuilt:st.stats().interiorsBuilt};})()`);
    console.log("[probe] interior after approach:", JSON.stringify({built:bi.built, meshes:bi.meshes, interiorsBuiltOnStreet:bi.interiorsBuilt}));
    const [bx,by,bz] = bi.p; const hx = bi.dims.halfX, hz = bi.dims.halfZ;
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${bx},${by+1.6},${bz-hz*0.55}); c.lookAt(${bx+hx*0.4},${by+1.4},${bz+hz*0.6}); return 1;})()`);
    for (let i=0;i<12;i++){ await tick(c); }
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${bx},${by+1.6},${bz-hz*0.55}); c.lookAt(${bx+hx*0.4},${by+1.4},${bz+hz*0.6}); return 1;})()`);
    await sleep(400);
    await shot(c, "street_interior.jpg");

    // --- PERF: frame-time with 20 buildings vs 0, + per-building remove timing ---
    // camera back to the wide street view so both benches draw the same scene
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${CX-110},${CY+26},${CZ+2}); c.lookAt(${CX+40},${CY+8},${CZ}); return 1;})()`);
    for (let i=0;i<10;i++){ await tick(c); }
    const perf = await evaluate(c, `(async()=>{
      const s=window.__sf; const N=90;
      const bench=()=>{ let t0=performance.now(); for(let i=0;i<N;i++){ try{ s.tick(0.016); }catch{} } return (performance.now()-t0)/N; };
      // present (20 buildings)
      bench(); // warm
      const withMs=bench();
      const st=s.buildings.current;
      const poolsBefore=st.stats();
      // remove ONE building, timed (streaming-ring cost)
      const t1=performance.now();
      st.list[0].dispose();
      const removeOneMs=+(performance.now()-t1).toFixed(2);
      // dispose the rest, timed
      const t2=performance.now();
      st.dispose(); s.buildings.current=null;
      const removeRestMs=+(performance.now()-t2).toFixed(1);
      bench(); // warm
      const withoutMs=bench();
      // structural counts after dispose
      let meshes=0, batched=0; s.scene.traverse(o=>{ if(o.isBatchedMesh) batched++; else if(o.isInstancedMesh||o.isMesh) meshes++; });
      return {withMs:+withMs.toFixed(3), withoutMs:+withoutMs.toFixed(3), deltaMs:+(withMs-withoutMs).toFixed(3),
        removeOneMs, removeRestMs, poolsBefore, batchedMeshesInScene:batched};
    })()`);
    console.log("[probe] PERF:", JSON.stringify(perf, null, 0));

    // console errors captured?
    c.close();
    console.log("[probe] done");
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
