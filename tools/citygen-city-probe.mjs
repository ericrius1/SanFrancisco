// Verifies the CityGen streaming RING in the live city: teleports into a Victorian
// district, lets the ring stream generated buildings (suppressing the baked twins),
// and screenshots. Bright daylight.
//   node tools/citygen-city-probe.mjs
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
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue; return c;
  }
  throw new Error("no chrome");
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout " + url); }
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); }
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
  const SERVER_URL = `http://127.0.0.1:${vitePort}`;
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: "8788" }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  try {
    await waitHttp(SERVER_URL, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-city-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player && window.__sf.citygenRing)", 120000);
    console.log("[probe] booted");
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(10.5);
      try{ s.scene.environmentIntensity=0.35; s.renderer.toneMappingExposure=(s.renderer.toneMappingExposure||1)*1.05; }catch{}
      try{ if(s.aiCars){ s.aiCars.prePhysics=()=>{}; s.aiCars.update=()=>{}; if(s.aiCars.postPhysics)s.aiCars.postPhysics=()=>{}; } }catch{}
      if(!window.__f){window.__f=1; s.chase.update=()=>{}; s.player.update=()=>{};} return 1;})()`);
    console.log("[probe] ring total victorian/edwardian:", await evaluate(c, "window.__sf.citygenRing.current ? window.__sf.citygenRing.current.count : 'ring not ready'"));

    // candidate Victorian-district spots (game coords); pick the first that streams buildings
    const spots = [[900, 2400], [1400, 2000], [300, -1500], [-400, 2600], [1800, 2800]];
    let chosen = null;
    for (const [x, z] of spots) {
      await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=s.map.groundHeight(${x},${z})+2;
        p.position.set(${x},y,${z}); p.renderPosition.copy(p.position);
        s.physics.world.setBodyTransform(p.body,[${x},y,${z}],[0,0,0,1]); return 1;})()`);
      for (let i = 0; i < 260; i++) await tick(c); // stream tiles + chunk LOD build + detail near
      const st = await evaluate(c, "window.__sf.citygenRing.current ? JSON.stringify(window.__sf.citygenRing.current.stats()) : '0'");
      console.log(`[probe] spot ${x},${z} → stats ${st}`);
      if ((JSON.parse(st).buildings || 0) >= 20) { chosen = [x, z]; break; }
    }
    if (!chosen) { console.log("[probe] no spot streamed buildings; screenshotting last"); chosen = spots[0]; }
    const [cx, cz] = chosen;
    const gy = await evaluate(c, `window.__sf.map.groundHeight(${cx},${cz})`);
    // elevated 3/4 street view
    const setCam = async (px, py, pz, lx, ly, lz) => evaluate(c, `(()=>{const c=window.__sf.camera; c.position.set(${px},${py},${pz}); c.lookAt(${lx},${ly},${lz}); return 1;})()`);
    // high, pulled-back shot to check the DISTANCE (verify no baked fabric out there)
    await setCam(cx - 120, gy + 90, cz - 120, cx + 200, gy + 10, cz + 200);
    for (let i = 0; i < 30; i++) await tick(c); // let far chunks stream in
    await setCam(cx - 120, gy + 90, cz - 120, cx + 200, gy + 10, cz + 200);
    await sleep(500);
    await shot(c, "citygen_city.jpg");
    await setCam(cx - 14, gy + 5, cz - 14, cx + 10, gy + 8, cz + 10);
    for (let i = 0; i < 15; i++) await tick(c);
    await setCam(cx - 14, gy + 5, cz - 14, cx + 10, gy + 8, cz + 10);
    await sleep(400);
    await shot(c, "citygen_city_street.jpg");
    // CLOSE-UP of a streamed DETAIL building (where chunk-LOD vs detail z-fight
    // would show) — stand ~7 m off a wall corner and look at it
    const db = await evaluate(c, "JSON.stringify((window.__sf.citygenRing.current.debugBuildings()||[]).slice(0,1))");
    const dbs = JSON.parse(db);
    if (dbs.length) {
      const b = dbs[0];
      const cy = await evaluate(c, `window.__sf.map.groundHeight(${b.cx},${b.cz})`);
      const mid = (b.base + b.top) / 2;
      // pull back ~22 m diagonally, eye level, frame the whole facade
      await setCam(b.cx - 22, cy + 7, b.cz - 22, b.cx, mid, b.cz);
      for (let i = 0; i < 12; i++) await tick(c);
      await setCam(b.cx - 22, cy + 7, b.cz - 22, b.cx, mid, b.cz);
      await sleep(400);
      await shot(c, "citygen_zfight.jpg");
      console.log("[probe] closeup at", b.cx, b.cz);
    }
    c.close();
    console.log("[probe] done");
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
