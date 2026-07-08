// Verifies LAZY Victorian interiors: streams a district, teleports the player
// INSIDE a generated building (which should trigger the interior to build), checks
// stats().interiors, and screenshots the room from inside.
//   node tools/citygen-interior-probe.mjs
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
class Cdp { #ws; #id = 1; #p = new Map(); constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); } close() { this.#ws.close(); } }
async function evaluate(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function waitEval(c, expr, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(c, expr)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + expr); }
async function tick(c) { try { await evaluate(c, "window.__sf.tick(0.05)"); } catch {} }
async function shot(c, name) { const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92 }); const f = path.join(OUT, name); writeFileSync(f, Buffer.from(s.data, "base64")); console.log("  saved", f); return f; }

async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort();
  const SERVER_URL = `http://127.0.0.1:${vitePort}`;
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: "8788" }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  try {
    await waitHttp(SERVER_URL, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-int-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player && window.__sf.citygenRing)", 120000);
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(10.5);
      try{ s.scene.environmentIntensity=0.35; }catch{}
      try{ if(s.aiCars){ s.aiCars.prePhysics=()=>{}; s.aiCars.update=()=>{}; if(s.aiCars.postPhysics)s.aiCars.postPhysics=()=>{}; } }catch{}
      if(!window.__f){window.__f=1; s.chase.update=()=>{}; s.player.update=()=>{};} return 1;})()`);

    // stream the Haight/Mission district
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=s.map.groundHeight(900,2400)+2; p.position.set(900,y,2400); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[900,y,2400],[0,0,0,1]); return 1;})()`);
    for (let i = 0; i < 100; i++) await tick(c);
    await waitEval(c, "window.__sf.citygenRing.current && window.__sf.citygenRing.current.stats().loaded > 2", 20000);

    // pick a resident building, teleport INSIDE it → interior should build
    const b = await evaluate(c, `(()=>{const bs=window.__sf.citygenRing.current.debugBuildings(); if(!bs.length) return null;
      const b=bs[0]; const s=window.__sf,p=s.player; const y=b.base+1.2;
      p.position.set(b.cx,y,b.cz); p.renderPosition.copy(p.position);
      s.physics.world.setBodyTransform(p.body,[b.cx,y,b.cz],[0,0,0,1]); return b;})()`);
    console.log("[probe] entered building:", JSON.stringify(b));
    for (let i = 0; i < 20; i++) await tick(c);
    const st = await evaluate(c, "window.__sf.citygenRing.current.stats()");
    console.log("[probe] ring stats:", JSON.stringify(st));

    // camera inside the room, looking across the floor at the furniture/stairs
    const setCam = async (px, py, pz, lx, ly, lz) => evaluate(c, `(()=>{const c=window.__sf.camera; c.position.set(${px},${py},${pz}); c.lookAt(${lx},${ly},${lz}); return 1;})()`);
    await setCam(b.cx - 2.4, b.base + 1.6, b.cz - 2.4, b.cx + 2, b.base + 1.2, b.cz + 2);
    for (let i = 0; i < 10; i++) await tick(c);
    await setCam(b.cx - 2.4, b.base + 1.6, b.cz - 2.4, b.cx + 2, b.base + 1.2, b.cz + 2);
    await sleep(500);
    await shot(c, "citygen_interior.jpg");

    // step OUT → interior should dispose
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=s.map.groundHeight(${b.cx + 30},${b.cz})+2; p.position.set(${b.cx + 30},y,${b.cz}); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[${b.cx + 30},y,${b.cz}],[0,0,0,1]); return 1;})()`);
    for (let i = 0; i < 15; i++) await tick(c);
    console.log("[probe] after exit, interiors:", await evaluate(c, "window.__sf.citygenRing.current.stats().interiors"));
    c.close();
    console.log("[probe] done");
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
