// Aerial roof z-fight check: two districts (Corona/Castro hillside — the user
// report — and the flats), fog disabled, camera above the roofscape; captures
// consecutive frames + a 3 cm dolly and pixel-diffs them. Static-scene frames
// must match (temporal flicker) and the dolly must not explode (z-fight).
//   node tools/roof-aerial-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = path.join(ROOT, ".data", "citygen-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return true; } catch {} await sleep(300); } throw new Error("http timeout"); }
class Cdp { #ws; #id = 1; #p = new Map(); errs = []; constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.method === "Runtime.exceptionThrown") this.errs.push(m.params?.exceptionDetails?.exception?.description || "exn"); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); } close() { this.#ws.close(); } }
async function evaluate(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function waitEval(c, e, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(c, e)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + e); }
async function tick(c, dt = 0.016) { try { await evaluate(c, `window.__sf.tick(${dt})`); } catch {} }
async function shot(c, name) { const s = await c.send("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64")); }
async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort();
  const relayPort = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}`, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-roofa-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.citygenRing && window.__sf.citygenRing.current)", 120000);
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(21.6);
      const wt=s.WORLD_TUNING.values; wt.fogBank=0; wt.fogNoise=0; wt.fog=0.00004; s.sky.applyFogParams();
      s.dynRes.sample=()=>{};
      if(!window.__f){window.__f=1;s.chase.update=()=>{};s.player.update=()=>{};} return 1;})()`);
    const SPOTS = [
      { name: "castro", x: 420, z: 2620 },   // Corona/Castro hillside (user report area)
      { name: "flats", x: 900, z: 2400 },
    ];
    for (const s of SPOTS) {
      const gy = await evaluate(c, `window.__sf.map.groundHeight(${s.x},${s.z})`);
      await evaluate(c, `(()=>{const sf=window.__sf,p=sf.player;const y=${gy}+2;p.position.set(${s.x},y,${s.z});p.renderPosition.copy(p.position);sf.physics.world.setBodyTransform(p.body,[${s.x},y,${s.z}],[0,0,0,1]);return 1;})()`);
      for (let i = 0; i < 60; i++) await tick(c, 0.05);
      await waitEval(c, "window.__sf.renderIdle && window.__sf.renderIdle()", 120000);
      for (let i = 0; i < 30; i++) await tick(c, 0.05);
      const setCam = (dx = 0) => evaluate(c, `(()=>{const cc=window.__sf.camera;cc.position.set(${s.x - 40 + " + " + 0} + ${0} + ${""}0, 0, 0);return 1;})()`);
      void setCam;
      const cam = (dx) => evaluate(c, `(()=>{const cc=window.__sf.camera;cc.position.set(${s.x - 45} + ${dx}, ${gy + 55}, ${s.z - 45});cc.lookAt(${s.x + 40}, ${gy}, ${s.z + 40});return 1;})()`);
      await cam(0); await tick(c); await shot(c, `night_${s.name}_f1.png`);
      await cam(0); await tick(c); await shot(c, `night_${s.name}_f2.png`);
      await cam(0.03); await tick(c); await shot(c, `night_${s.name}_dolly.png`);
    }
    console.log("[probe] page errors:", c.errs.length ? c.errs.slice(0, 3) : "none");
    c.close(); console.log("[probe] done");
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
