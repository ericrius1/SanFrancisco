// Focused re-shoot: close-up of the player at full archer draw to confirm the
// bow is gripped in hand (grip-system deliverable). Boots headless, teleports
// to the archery shooting line, sets the draw pose, and grabs three angles.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/archery-verify");
const SERVER_URL = "http://127.0.0.1:5232";
const W = 1280, H = 720, DT = 1 / 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)) { if (c.includes("/") && !existsSync(c)) continue; return c; } throw new Error("no chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); } throw new Error("timeout " + url); }
async function startDev() { try { await waitHttp(SERVER_URL, 2000); return null; } catch {} const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5232", "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: "8792" }, stdio: ["ignore", "ignore", "ignore"] }); await waitHttp(SERVER_URL, 60000); return child; }
class Cdp { #ws; #id = 1; #p = new Map(); constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (!m.id) return; const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); } close() { this.#ws.close(); } }
let ownedDev = null, chromeProc = null, cdp = null;
function cleanup() { try { cdp?.close(); } catch {} try { chromeProc?.kill(); } catch {} try { ownedDev?.kill(); } catch {} }
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("eval:" + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; }
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function freeCamAt(c, ex, ey, ez, tx, ty, tz) { await ev(c, `window.__sfFreeCam([${ex},${ey},${ez}],[${tx},${ty},${tz}])`); for (let i = 0; i < 160; i++) { await tick(c, 0); const p = await ev(c, `[window.__sf.camera.position.x,window.__sf.camera.position.y,window.__sf.camera.position.z]`); if (Math.hypot(p[0] - ex, p[1] - ey, p[2] - ez) < 0.06) return; await sleep(30); } }
async function shoot(c, name) { const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92, fromSurface: true }); writeFileSync(path.join(OUT, name + ".jpg"), Buffer.from(s.data, "base64")); console.log("shot", name); }
async function main() {
  mkdirSync(OUT, { recursive: true });
  ownedDev = await startDev();
  const chrome = await findChrome(); const port = await freePort();
  chromeProc = spawn(chrome, [`--user-data-dir=${path.join(OUT, "chrome2")}`, "--headless=new", `--remote-debugging-port=${port}`, "--enable-unsafe-webgpu", "--use-angle=metal", "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);
  let page; for (let i = 0; i < 60; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl); if (page) break; } catch {} await sleep(400); }
  const c = new Cdp(page.webSocketDebuggerUrl); cdp = c; await c.open(); await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now(); while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__archery)`)) break; } catch {} await sleep(600); }
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(13.5);return true;})()`);
  await ev(c, `document.body.classList.add("started")`);
  const AC = { x: -5533, z: 2079 };
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const x=${AC.x - 14},z=${AC.z};const y=m.groundHeight(x,z);p.teleportTo({x,y:y+1.5,z,facing:Math.PI/2,mode:'walk'});return true;})()`);
  for (let i = 0; i < 20; i++) { await tick(c, DT); await sleep(30); }
  const pd = await ev(c, `(()=>{const p=window.__sf.player;p.setBowCarried(true);p.setArcherPose(true,0.95,0.0);const r=p.renderPosition;return{x:r.x,y:r.y,z:r.z,h:p.heading};})()`);
  for (let i = 0; i < 6; i++) { await tick(c, DT); await sleep(20); }
  console.log("player", JSON.stringify(pd));
  // player faces +X (downrange). View from front-left to see the bow arm + grip.
  await freeCamAt(c, pd.x + 1.9, pd.y + 0.55, pd.z - 1.5, pd.x, pd.y + 0.55, pd.z);
  await tick(c, DT); await shoot(c, "archery_draw_close_frontleft");
  await freeCamAt(c, pd.x + 1.9, pd.y + 0.55, pd.z + 1.5, pd.x, pd.y + 0.55, pd.z);
  await tick(c, DT); await shoot(c, "archery_draw_close_frontright");
  await freeCamAt(c, pd.x - 0.4, pd.y + 0.6, pd.z + 2.2, pd.x, pd.y + 0.5, pd.z);
  await tick(c, DT); await shoot(c, "archery_draw_close_side");
  cleanup(); process.exit(0);
}
main().catch((e) => { cleanup(); console.error("FAIL", e); process.exit(1); });
