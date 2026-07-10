// In-app WebGPU render of the traffic-signal rigs. Boots the app on its own vite
// (fresh port, never 5179), freezes a bright afternoon sky + camera, teleports to
// a signalized FiDi intersection (signal #75 @ ~4245,408), and screenshots the
// mast-arm rigs from a few street-level angles. A clock-override wrapper on
// trafficLights.update lets us force the signal state so we can prove the lit
// lens changes (green → red) between shots.
//
//   node tools/signals-render-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = process.env.SF_OUT ?? path.join(ROOT, ".data", "perf-shot");
const SX = 4245.4, SZ = 408.0; // signal #75
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
async function tick(c) { try { await evaluate(c, "window.__sf.tick(0.016)"); } catch {} }
async function shot(c, name) {
  const s = await c.send("Page.captureScreenshot", { format: "png" });
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
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  try {
    await waitHttp(SERVER_URL, 60000);
    chrome = spawn(chromePath, [
      `--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-sig-" + Date.now())}`,
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
    await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player)", 120000);
    console.log("[probe] app booted");

    // bright afternoon, no cycle; kill aiCars; freeze camera + player
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(15.0);
      try{ s.scene.environmentIntensity = 0.35; }catch{}
      try{ if(s.aiCars){ s.aiCars.prePhysics=()=>{}; s.aiCars.update=()=>{}; if(s.aiCars.postPhysics) s.aiCars.postPhysics=()=>{}; } }catch{}
      if(!window.__camFrozen){window.__camFrozen=true; s.chase.update=()=>{}; s.player.update=()=>{};} return 1;})()`);

    // teleport to signal #75 so tiles/colliders stream and the rig pool targets it
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const gy=s.map.groundHeight(${SX},${SZ})+2;
      p.position.set(${SX},gy,${SZ}); p.renderPosition.copy(p.position);
      s.physics.world.setBodyTransform(p.body,[${SX},gy,${SZ}],[0,0,0,1]); return 1;})()`);

    // __sf.trafficLights is a null snapshot (captured before the async RoadGraph
    // load resolved), so detect readiness via the rig groups the view adds to the
    // scene, and control the signal phase by offsetting performance.now (the clock
    // that feeds trafficLights.update in the main loop). A constant offset shifts
    // the phase without disturbing frame deltas.
    await evaluate(c, `(()=>{if(!performance.__off){const o=performance.now.bind(performance);
      performance.__off=0; performance.now=()=>o()+(performance.__off||0);} return 1;})()`);
    await waitEval(c, `(()=>{let n=0; window.__sf.scene.traverse(o=>{if(o.userData&&o.userData.trafficLightRig)n++;}); return n;})()`, 120000);
    for (let i = 0; i < 60; i++) await tick(c); // let terrain/tiles/rigs stream in
    const rigInfo = await evaluate(c, `(()=>{let total=0,vis=0,near=0; const px=${SX},pz=${SZ};
      window.__sf.scene.traverse(o=>{if(o.userData&&o.userData.trafficLightRig){total++; if(o.visible){vis++;
        const d=Math.hypot(o.position.x-px,o.position.z-pz); if(d<30)near++;}}}); return {total,vis,near};})()`);
    console.log("[probe] rigs:", JSON.stringify(rigInfo));

    const gy = await evaluate(c, `window.__sf.map.groundHeight(${SX},${SZ})`);
    console.log("[probe] ground at signal:", gy);

    const setCam = async (px, py, pz, lx, ly, lz) =>
      evaluate(c, `(()=>{const c=window.__sf.camera; c.position.set(${px},${py},${pz}); c.lookAt(${lx},${ly},${lz}); return 1;})()`);
    // shift the traffic clock forward (ms offset). NEVER decrease it — a
    // backwards performance.now() gives the main-loop clock a negative delta
    // and wedges the render loop for the rest of the session.
    const setPhaseOffset = async (sec) =>
      evaluate(c, `(performance.__off=Math.max(performance.__off||0, ${sec * 1000}),1)`);

    // read which lens is lit on the rig at the target signal (per gantry) by
    // inspecting bulb materials — lit materials are LIGHT_SCALE-boosted (>2)
    const litStates = async () =>
      evaluate(c, `(()=>{const out={}; const px=${SX},pz=${SZ};
        window.__sf.scene.traverse(o=>{if(!(o.userData&&o.userData.trafficLightRig)||!o.visible)return;
          if(Math.hypot(o.position.x-px,o.position.z-pz)>30)return;
          for(const g of o.children){ if(!g.visible) continue; const lit=[];
            g.traverse(m=>{ if(m.isMesh&&m.geometry&&m.geometry.type==="CircleGeometry"){
              const c0=m.material.color; const mx=Math.max(c0.r,c0.g,c0.b);
              if(mx>2){ lit.push(c0.r>c0.g*1.5?"red":(c0.g>c0.r*1.5?"green":"yellow")); }}});
            out[g.name]=lit.join(",");}});
        return out;})()`);

    // angle A: down an approach from +X
    await setCam(SX + 26, gy + 2.4, SZ - 4, SX, gy + 4.6, SZ + 2);
    for (let i = 0; i < 14; i++) await tick(c);
    await setCam(SX + 26, gy + 2.4, SZ - 4, SX, gy + 4.6, SZ + 2);
    await sleep(300);
    const state0 = await litStates();
    console.log("[probe] lit state @0:", JSON.stringify(state0));
    await shot(c, "signals-A-phase0.png");

    // advance the traffic clock until the lit lens provably changes (cycling)
    let changed = null;
    for (let off = 8; off <= 56 && !changed; off += 8) {
      await setPhaseOffset(off);
      for (let i = 0; i < 4; i++) await tick(c);
      const st = await litStates();
      if (JSON.stringify(st) !== JSON.stringify(state0)) changed = { off, st };
    }
    if (!changed) throw new Error("signal state never changed across a full cycle");
    console.log(`[probe] lit state @${changed.off}s:`, JSON.stringify(changed.st));
    await setCam(SX + 26, gy + 2.4, SZ - 4, SX, gy + 4.6, SZ + 2);
    await sleep(300);
    await shot(c, "signals-A-phase30.png");

    // angle B: 3/4 street view from the -Z/-X corner
    await setCam(SX - 22, gy + 2.6, SZ - 20, SX, gy + 4.8, SZ);
    for (let i = 0; i < 12; i++) await tick(c);
    await setCam(SX - 22, gy + 2.6, SZ - 20, SX, gy + 4.8, SZ);
    await sleep(300);
    await shot(c, "signals-B.png");

    // angle C: low hero looking up at a hanging head
    await setCam(SX + 10, gy + 1.8, SZ + 12, SX + 2, gy + 4.9, SZ + 2);
    for (let i = 0; i < 12; i++) await tick(c);
    await setCam(SX + 10, gy + 1.8, SZ + 12, SX + 2, gy + 4.9, SZ + 2);
    await sleep(300);
    await shot(c, "signals-C.png");

    // read back a rig transform sanity + console errors
    const errs = await evaluate(c, `(window.__sfErrors||[]).slice(-8)`);
    if (errs && errs.length) console.log("[probe] page errors:", JSON.stringify(errs));

    c.close();
    console.log("[probe] done");
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
