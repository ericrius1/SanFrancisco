// Phase-2 Chinatown-ring probe: boots the app on its OWN vite (fresh port,
// SF_RELAY_PORT=8788), teleports into the Chinatown core, pumps the generated-
// building ring so it streams in, and verifies:
//   - generated HK buildings replace the baked OSM ones (isAlive false while loaded)
//   - a walkable interior builds on approach
//   - the OSM twin is RESTORED (isAlive true) when the ring unloads a building
//   - draw calls stay at ~3 BatchedMesh pools for the whole ring; per-frame cost
// Screenshots: chinatown_aerial, chinatown_street, chinatown_interior.
//
//   node tools/_probe-chinatown.mjs
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
      const to = setTimeout(() => { this.#p.delete(id); rej(new Error(`CDP timeout: ${method}`)); }, 30000);
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
  return f;
}

// pump the ring: call update() with a scan-triggering dt, tick a frame, let the
// async generates resolve, repeat until the loaded count stops climbing.
async function pumpRing(c, px, py, pz, iters = 26) {
  let last = -1, stable = 0;
  for (let k = 0; k < iters; k++) {
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player;
      p.position.set(${px},${py},${pz}); p.renderPosition.set(${px},${py},${pz});
      s.buildings.current.update(p.position,0.25); return 1;})()`);
    await tick(c);
    await sleep(200);
    const st = await evaluate(c, "window.__sf.buildings.current.stats()");
    if (st.loaded === last) { if (++stable >= 3) return st; } else { stable = 0; last = st.loaded; }
  }
  return await evaluate(c, "window.__sf.buildings.current.stats()");
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
      `--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-ct")}`,
      "--headless=new", "--no-first-run", "--mute-audio",
      "--enable-features=SharedArrayBuffer", "--use-angle=metal",
      "--enable-unsafe-webgpu", "--enable-gpu",
      "--enable-features=WebGPUDeveloperFeatures",
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
    console.log("[probe] app booted");

    // freeze daytime; neutralise the WIP aiCars module (throws under manual tick)
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(13.5);
      try{ if(s.aiCars){ s.aiCars.prePhysics=()=>{}; s.aiCars.update=()=>{}; if(s.aiCars.postPhysics) s.aiCars.postPhysics=()=>{}; } }catch{}
      if(!window.__camFrozen){window.__camFrozen=true; s.chase.update=()=>{};}
      return 1;})()`);

    // wait for the ring data to load
    await waitEval(c, "Boolean(window.__sf.buildings && window.__sf.buildings.current && window.__sf.buildings.current.count>0)", 120000);
    const ringCount = await evaluate(c, "window.__sf.buildings.current.count");
    console.log("[probe] chinatown entries:", ringCount);

    // Chinatown core (game frame). Ground height sampled in-app.
    const CX = 3300, CZ = -400;
    const CY = await evaluate(c, `+window.__sf.map.groundHeight(${CX},${CZ}).toFixed(2)`);
    console.log("[probe] chinatown ground y:", CY);

    // teleport player in + let the baked tiles stream around us
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=${CY}+1.5;
      p.position.set(${CX},y,${CZ}); p.renderPosition.set(${CX},y,${CZ});
      s.physics.world.setBodyTransform(p.body,[${CX},y,${CZ}],[0,0,0,1]); return 1;})()`);
    for (let i = 0; i < 40; i++) { await tick(c); }
    await sleep(1500);

    // pump the ring so it streams generated buildings in (first build fetches the
    // 20 MB kit glb once, so allow a generous first wait)
    console.log("[probe] pumping ring (first load fetches kit glb)...");
    const loaded = await pumpRing(c, CX, CY + 1.5, CZ, 30);
    console.log("[probe] ring loaded:", JSON.stringify(loaded));

    // --- verify OSM suppression: cross-check chinatown.json entries near centre
    //     against tiles.isAlive — a loaded/generated building's OSM twin is dead.
    const suppression = await evaluate(c, `(async()=>{
      const s=window.__sf;
      const data=await (await fetch('/buildinggen/chinatown.json')).json();
      const near=data.buildings
        .map(b=>({b, d:Math.hypot(b.x-${CX},b.z-(${CZ}))}))
        .sort((a,b)=>a.d-b.d).slice(0,60).map(o=>o.b);
      let suppressed=0, aliveStill=0, tileMissing=0;
      for(const b of near){
        const alive=s.tiles.isAlive(b.key,b.i);
        // isAlive false only counts if the tile is actually loaded
        if(!s.tiles.loaded||!s.tiles.loaded.get?.(b.key)){ tileMissing++; continue; }
        if(alive) aliveStill++; else suppressed++;
      }
      return {sampled:near.length, suppressed, aliveStill, tileMissing};
    })()`);
    console.log("[probe] suppression (near 60):", JSON.stringify(suppression));

    // --- aerial: high over Chinatown looking down at the block of HK towers ---
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${CX - 120},${CY + 150},${CZ + 170}); c.lookAt(${CX},${CY + 10},${CZ}); return 1;})()`);
    for (let i = 0; i < 20; i++) { await tick(c); }
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${CX - 120},${CY + 150},${CZ + 170}); c.lookAt(${CX},${CY + 10},${CZ}); return 1;})()`);
    await sleep(500);
    await shot(c, "chinatown_aerial.jpg");

    // --- street level: stand in the street looking down a row ---
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${CX},${CY + 4},${CZ + 60}); c.lookAt(${CX},${CY + 12},${CZ - 40}); return 1;})()`);
    for (let i = 0; i < 15; i++) { await tick(c); }
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${CX},${CY + 4},${CZ + 60}); c.lookAt(${CX},${CY + 12},${CZ - 40}); return 1;})()`);
    await sleep(400);
    await shot(c, "chinatown_street.jpg");

    // --- interior: find the nearest loaded building, teleport player inside,
    //     pump its 40 m interior gate, screenshot. The ring object doesn't expose
    //     its buildings, so approach via the pool group in the scene: walk to the
    //     ring centre where density is highest. ---
    const interior = await evaluate(c, `(()=>{const s=window.__sf,p=s.player;
      // step through the ring's own update to build the nearest interior
      p.position.set(${CX},${CY + 1.5},${CZ}); p.renderPosition.set(${CX},${CY + 1.5},${CZ});
      for(let i=0;i<4;i++) s.buildings.current.update(p.position,0.25);
      // count interiors now standing (emissive-lit rooms in the scene)
      let interiors=0; s.scene.traverse(o=>{ if(o.name==='generatedBuilding' && o.children.length) interiors++; });
      return {interiors};})()`);
    console.log("[probe] interiors built near centre:", JSON.stringify(interior));
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${CX},${CY + 1.6},${CZ}); c.lookAt(${CX + 6},${CY + 1.4},${CZ}); return 1;})()`);
    for (let i = 0; i < 12; i++) { await tick(c); }
    await sleep(400);
    await shot(c, "chinatown_interior.jpg");

    // --- restoration: move the player far, pump so the ring unloads, confirm the
    //     OSM twins come back alive (no hole in the distant baked city) ---
    try {
    const restore = await evaluate(c, `(async()=>{
      const s=window.__sf,p=s.player;
      const data=await (await fetch('/buildinggen/chinatown.json')).json();
      const near=data.buildings.map(b=>({b,d:Math.hypot(b.x-${CX},b.z-(${CZ}))}))
        .sort((a,b)=>a.d-b.d).slice(0,40).map(o=>o.b);
      // drive the ring far away
      const FX=${CX}+2000, FZ=${CZ};
      for(let i=0;i<20;i++){ p.position.set(FX,20,FZ); s.buildings.current.update(p.position,0.25); }
      const st=s.buildings.current.stats();
      let revived=0, still=0;
      for(const b of near){
        if(!s.tiles.loaded.get?.(b.key)) continue;
        if(s.tiles.isAlive(b.key,b.i)) revived++; else still++;
      }
      return {loadedAfterFar:st.loaded, revived, still};
    })()`);
    console.log("[probe] restoration:", JSON.stringify(restore));
    } catch (e) { console.log("[probe] restoration FAILED:", e.message); }

    // --- perf: frame delta ring-loaded vs ring-empty ---
    try {
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player;
      p.position.set(${CX},${CY + 1.5},${CZ}); p.renderPosition.set(${CX},${CY + 1.5},${CZ}); return 1;})()`);
    const reload = await pumpRing(c, CX, CY + 1.5, CZ, 26);
    console.log("[probe] reload-before-perf:", JSON.stringify(reload));
    await evaluate(c, `(()=>{const s=window.__sf,c=s.camera;
      c.position.set(${CX - 120},${CY + 150},${CZ + 170}); c.lookAt(${CX},${CY + 10},${CZ}); return 1;})()`);
    for (let i = 0; i < 8; i++) { await tick(c); }
    const perf = await evaluate(c, `(()=>{
      const s=window.__sf; const N=30;
      const bench=()=>{ let t0=performance.now(); for(let i=0;i<N;i++){ try{ s.tick(0.016); }catch{} } return (performance.now()-t0)/N; };
      bench();
      const withMs=bench();
      const before=s.buildings.current.stats();
      s.buildings.current.dispose(); s.buildings.current=null;
      bench();
      const withoutMs=bench();
      let batched=0; s.scene.traverse(o=>{ if(o.isBatchedMesh) batched++; });
      return {loadedBuildings:before.loaded, poolStats:before.pools,
        withMs:+withMs.toFixed(3), withoutMs:+withoutMs.toFixed(3), deltaMs:+(withMs-withoutMs).toFixed(3),
        batchedMeshesInScene:batched};
    })()`);
    console.log("[probe] PERF:", JSON.stringify(perf));
    } catch (e) { console.log("[probe] perf FAILED:", e.message); }

    c.close();
    console.log("[probe] done");
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
