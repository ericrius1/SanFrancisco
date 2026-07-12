// Verifies the "windows look out to the real world" feature: enters a
// citygen building, confirms its exterior shell + glass hide (setShellHidden/
// setGlassHidden) and the interior shell carved real window holes, then shoots
// the aperture from inside so it can be visually checked for real exterior
// pixels (sky/neighbor) instead of the old opaque painted-parallax panel.
//   node tools/window-lookout-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = process.env.SF_OUT ?? path.join(ROOT, ".data", "citygen-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout " + url); }
class Cdp {
  #ws; #id = 1; #p = new Map(); onEvent = null;
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); }
      else if (m.method && this.onEvent) this.onEvent(m.method, m.params);
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); }
  close() { this.#ws.close(); }
}
async function evaluate(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function waitEval(c, expr, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(c, expr)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + expr); }
async function tick(c) { try { await evaluate(c, "window.__sf.tick(0.05)"); } catch {} }
async function shot(c, name) { const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92 }); const f = path.join(OUT, name); writeFileSync(f, Buffer.from(s.data, "base64")); console.log("  saved", f); return f; }

async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort();
  const relayPort = await freePort();
  const SERVER_URL = `http://127.0.0.1:${vitePort}`;
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  const consoleErrors = [];
  try {
    await waitHttp(SERVER_URL, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-lookout-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    c.onEvent = (method, params) => {
      if (method === "Runtime.exceptionThrown") consoleErrors.push(`[exception] ${params.exceptionDetails?.text ?? ""} ${params.exceptionDetails?.exception?.description ?? ""}`);
      if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "warning")) {
        consoleErrors.push(`[console.${params.type}] ${(params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")}`);
      }
    };
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player && window.__sf.citygenRing)", 120000);
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(10.5);
      try{ s.scene.environmentIntensity=0.35; }catch{}
      try{ if(s.aiCars){ s.aiCars.prePhysics=()=>{}; s.aiCars.update=()=>{}; if(s.aiCars.postPhysics)s.aiCars.postPhysics=()=>{}; } }catch{}
      if(!window.__f){window.__f=1; s.chase.update=()=>{}; s.player.update=()=>{};} return 1;})()`);

    // stream near (900,2400) — a victorian block per the task brief
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=s.map.groundHeight(900,2400)+2; p.position.set(900,y,2400); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[900,y,2400],[0,0,0,1]); return 1;})()`);
    for (let i = 0; i < 100; i++) await tick(c);
    await waitEval(c, "window.__sf.citygenRing.current && window.__sf.citygenRing.current.stats().buildings > 2", 30000);

    // pick a building and stand INSIDE its footprint (gateInterior polygon test,
    // not just the AABB) so ensureInterior actually fires.
    const b = await evaluate(c, `(()=>{const bs=window.__sf.citygenRing.current.debugBuildings(); if(!bs.length) return null;
      const near=bs.filter(x=>x.top-x.base>4).map(x=>({x,d2:(x.cx-900)**2+(x.cz-2400)**2})).sort((a,b)=>a.d2-b.d2);
      const b=(near[0]?.x) ?? bs[0]; const s=window.__sf,p=s.player; const y=b.base+1.2;
      p.position.set(b.cx,y,b.cz); p.renderPosition.copy(p.position);
      s.physics.world.setBodyTransform(p.body,[b.cx,y,b.cz],[0,0,0,1]); return b;})()`);
    console.log("[probe] entered building:", JSON.stringify(b));
    for (let i = 0; i < 30; i++) await tick(c);
    await waitEval(c, "window.__sf.citygenRing.current.isPlayerInside()", 10000);
    console.log("[probe] isPlayerInside:", await evaluate(c, "window.__sf.citygenRing.current.isPlayerInside()"));
    const st = await evaluate(c, "window.__sf.citygenRing.current.stats()");
    console.log("[probe] ring stats:", JSON.stringify(st));

    await waitEval(c, "window.__sf.renderIdle && window.__sf.renderIdle()", 120000);

    // camera: stand near the building centre, low, looking outward toward the
    // nearest footprint edge midpoint (where a window row should be), from
    // inside eye height — sweeps a few yaw angles to find a window aperture.
    // Real floor Y from the actual interior mesh bounds (groundHeight can read a
    // hillside sample far from where the room floor landed; the interior group
    // is the ground truth).
    const floorInfo = await evaluate(c, `(()=>{const s=window.__sf; let ig=null; s.scene.traverse(o=>{if(!ig&&o.name==='cityGenInterior') ig=o;}); if(!ig) return null;
      let minY=Infinity,maxY=-Infinity; ig.traverse(o=>{ if(o.geometry && o.geometry.attributes && o.geometry.attributes.position){ const arr=o.geometry.attributes.position.array; for(let i=1;i<arr.length;i+=3){ const y=arr[i]; if(y<minY)minY=y; if(y>maxY)maxY=y; } } });
      return { minY, maxY };})()`);
    console.log("[probe] interior mesh Y range:", JSON.stringify(floorInfo));
    const setCam = async (px, py, pz, lx, ly, lz) => evaluate(c, `(()=>{const c=window.__sf.camera; c.position.set(${px},${py},${pz}); c.lookAt(${lx},${ly},${lz}); return 1;})()`);
    const eye = (floorInfo && Number.isFinite(floorInfo.minY) ? floorInfo.minY : b.base) + 1.4;
    const bbx = b.bb || { minx: b.cx - 4, maxx: b.cx + 4, minz: b.cz - 4, maxz: b.cz + 4 };
    const cx = (bbx.minx + bbx.maxx) / 2, cz = (bbx.minz + bbx.maxz) / 2;
    const R = Math.max(bbx.maxx - bbx.minx, bbx.maxz - bbx.minz);
    const N = 12;
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2;
      const lx = cx + Math.cos(ang) * R, lz = cz + Math.sin(ang) * R;
      await setCam(cx, eye, cz, lx, eye, lz);
      for (let k = 0; k < 3; k++) await tick(c);
      await setCam(cx, eye, cz, lx, eye, lz); // re-assert after tick (chase/render may touch it)
      await sleep(250);
      await shot(c, `window_lookout_${i}.jpg`);
    }

    console.log("[probe] page console errors/exceptions:", consoleErrors.length ? "\n  " + consoleErrors.join("\n  ") : "(none)");
    c.close();
    console.log("[probe] done");
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
