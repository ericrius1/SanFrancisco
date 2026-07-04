// Quick probe: open the full map focused on the Exploratorium and screenshot it.
//   SF_CAPTURE_URL=http://127.0.0.1:5191 node tools/probe-map.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1920, H = 1080;
const SERVER_URL = process.env.SF_CAPTURE_URL ?? "http://127.0.0.1:5179";
const OUT = path.join(ROOT, ".data", "probe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p) { try { await access(p); return true; } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue; return c;
  }
  throw new Error("no chrome");
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); } throw new Error("http timeout"); }
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (!m.id) return; const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); }); }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); }
  close() { this.#ws.close(); }
}
async function ev(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; }
async function waitEv(c, e, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(c, e)) return; } catch {} await sleep(250); } throw new Error("eval timeout " + e); }
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  let dev = null;
  try { await waitHttp(SERVER_URL, 2000); } catch {
    const relay = await freePort(); const vp = Number(new URL(SERVER_URL).port || 5179);
    dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vp), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: "ignore" });
    await waitHttp(SERVER_URL, 45000);
  }
  const chromePath = await findChrome();
  const dport = await freePort();
  const chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
  try {
    let ver; const t0 = Date.now();
    while (Date.now() - t0 < 15000) { try { ver = await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${SERVER_URL}/?demo=reel3&hold=1&manual=1&autostart=1&fullfps=1` });
    await waitEv(c, "Boolean(window.__sf && window.__sf.minimap && window.__sfManual && window.__sfReelStep)", 120000);
    await ev(c, "window.__sfManual(true); true");
    // fast-forward into the fluid room (map -> teleport -> walk) at midday, then
    // tick a while to build the museum + develop the SPH tank
    await ev(c, "window.__sfReelStep(13.6); true");
    for (let i = 0; i < 50; i++) { await ev(c, frame(0.016)); await sleep(50); }
    console.log("[map] fluid interior sampled");
    const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92, fromSurface: true });
    writeFileSync(path.join(OUT, "map.jpg"), Buffer.from(shot.data, "base64"));
    console.log("[map] wrote .data/probe/map.jpg");
    c.close();
  } finally { chrome.kill("SIGTERM"); dev?.kill("SIGTERM"); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
