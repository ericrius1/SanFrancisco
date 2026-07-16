// Hourly 5-second action clip of the Wild Ones horse paddock, captured
// deterministically (manual __sf.tick per frame) in headless Chrome, encoded
// with ffmpeg, plus 5 keyframe stills so the overnight watcher can EYEBALL
// gait quality (not just trust fitness numbers).
//
//   node tools/capture-horse-clip.mjs [--label hHHMM] [--out DIR]
//
// Writes <out>/clips/<label>-horses.mp4 + <out>/clips/<label>-f{0..4}.jpg
import { spawn, execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argOf = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const now = new Date();
const LABEL = argOf("label", `h${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`);
const OUT = path.resolve(ROOT, argOf("out", ".data/creature-nursery"));
const CLIPS = path.join(OUT, "clips");
const FRAMES = path.join(process.env.TMPDIR ?? "/tmp", `horse-clip-frames-${process.pid}`);
const PORT = 5238; // its own port — never collides with the state probe on 5237
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const W = 960, H = 540;
const FPS = 30;
const SECONDS = 5;
const HORSES = { x: -775, z: -1655 }; // sync with src/gameplay/ranch/meta.ts
const CENTER = { x: -720, z: -1655 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !existsSync(c)) continue; return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); } throw new Error(`timeout ${label}: ${url}`); }
async function startDev() {
  try { execSync(`lsof -ti tcp:${PORT} | xargs kill -9`, { stdio: "ignore" }); } catch {}
  console.log(`[clip] starting Vite ${SERVER_URL}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: ["ignore", "ignore", "ignore"] });
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
}
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (!m.id) return; const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {}); });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { this.#ws.close(); }
}
let ownedDev = null, chromeProc = null, activeCdp = null;
function cleanup() { try { activeCdp?.close(); } catch {} try { chromeProc?.kill(); } catch {} try { ownedDev?.kill(); } catch {} try { rmSync(FRAMES, { recursive: true, force: true }); } catch {} }
process.on("exit", cleanup);
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`); return r.result?.value; }
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;

async function main() {
  mkdirSync(CLIPS, { recursive: true });
  mkdirSync(FRAMES, { recursive: true });
  ownedDev = await startDev();
  const chrome = await findChrome();
  const port = await freePort();
  chromeProc = spawn(chrome, [`--user-data-dir=${path.join(FRAMES, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`, "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal", "--hide-scrollbars", "--mute-audio", "--autoplay-policy=no-user-gesture-required", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);
  let page;
  for (let i = 0; i < 60; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl); if (page) break; } catch {} await sleep(400); }
  if (!page) throw new Error("no app page target");
  const c = new Cdp(page.webSocketDebuggerUrl); activeCdp = c;
  await c.open(); await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[clip] waiting for __sf...");
  const t0 = Date.now(); let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.player&&window.__sf.map)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready");

  await ev(c, `window.__sfManual(true)`);
  await ev(c, `(()=>{try{window.__sf.sky.setTimeOfDay?.(14.0)}catch(e){} return true})()`);
  await ev(c, `(()=>{const h=document.getElementById('hud');if(h)h.style.display='none';return true})()`);
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const x=${CENTER.x},z=${CENTER.z};const y=m.groundTop(x,z);p.teleportTo({x,y:y+1.5,z,facing:0,mode:'walk'});return true;})()`);
  for (let i = 0; i < 30; i++) await ev(c, frame(1 / 30));

  console.log("[clip] waiting for ranch...");
  const t1 = Date.now(); let ok = false;
  while (Date.now() - t1 < 180000) {
    for (let i = 0; i < 6; i++) await ev(c, frame(1 / 30));
    try { if (await ev(c, `!!(window.__sf.ranch && window.__sf.siteGate.awake('ranch'))`)) { ok = true; break; } } catch {}
  }
  if (!ok) throw new Error("ranch never woke");

  // frame the paddock from a low three-quarter angle that reads gait clearly
  const g = await ev(c, `window.__sf.map.groundTop(${HORSES.x},${HORSES.z})`);
  await ev(c, `window.__sfFreeCam([${HORSES.x + 16},${g + 5},${HORSES.z + 22}],[${HORSES.x},${g + 1.2},${HORSES.z}])`);
  for (let i = 0; i < 40; i++) await ev(c, frame(1 / 30)); // cam settle + horses settle

  const total = FPS * SECONDS;
  console.log(`[clip] recording ${total} frames...`);
  for (let i = 0; i < total; i++) {
    await ev(c, frame(1 / FPS));
    const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 85, fromSurface: true });
    writeFileSync(path.join(FRAMES, `f${String(i).padStart(4, "0")}.jpg`), Buffer.from(shot.data, "base64"));
  }
  const mp4 = path.join(CLIPS, `${LABEL}-horses.mp4`);
  execFileSync("ffmpeg", ["-y", "-framerate", String(FPS), "-i", path.join(FRAMES, "f%04d.jpg"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", mp4], { stdio: "ignore" });
  // 5 keyframes for the visual reviewer
  for (let k = 0; k < 5; k++) {
    const src = path.join(FRAMES, `f${String(Math.min(total - 1, Math.round((k * (total - 1)) / 4))).padStart(4, "0")}.jpg`);
    execFileSync("cp", [src, path.join(CLIPS, `${LABEL}-f${k}.jpg`)]);
  }
  // pen state alongside, so the clip pairs with ground truth
  const state = await ev(c, `JSON.stringify(window.__sf.ranch.debugState())`);
  writeFileSync(path.join(CLIPS, `${LABEL}-state.json`), state);
  console.log(`[clip] wrote ${mp4} + keyframes`);
  cleanup();
  process.exit(0);
}

main().catch((e) => { console.error("[clip] FAIL:", e.message); cleanup(); process.exit(1); });
