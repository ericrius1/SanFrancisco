// Boot at the DEFAULT spawn (no garden teleport), expand the full map, and
// screenshot it — proves landmark/minigame pins are registered at boot,
// independent of the lazy region builds. Points at a running server (5179).
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
const URL_ = process.env.BOOT_URL ?? "http://127.0.0.1:5179/?autostart=1&fullfps";
const OUT = process.env.OUT ?? "/tmp/handverify/map-pins.jpg";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)) if (!c.includes("/") || existsSync(c)) return c; throw new Error("no chrome"); }
class Cdp { #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (!m.id) return; const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); }); }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); } }
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) return `EXC:${JSON.stringify(r.exceptionDetails).slice(0, 300)}`; return r.result?.value; }

const port = await freePort();
const chrome = spawn(findChrome(), [`--user-data-dir=/tmp/handverify/pins-chrome`, "--headless=new", `--remote-debugging-port=${port}`, "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal", "--mute-audio", "--window-size=1280,900", URL_], { stdio: "ignore" });
await sleep(2500);
let page;
for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = l.find((t) => t.type === "page" && t.webSocketDebuggerUrl); if (page) break; } catch {} await sleep(400); }
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open(); await c.send("Runtime.enable"); await c.send("Page.enable");
await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
for (let i = 0; i < 80; i++) { if (await ev(c, "!!(window.__sf && window.__sfManual && document.body.classList.contains('started'))")) break; await sleep(600); }
// where did we spawn? (should be the default, NOT the tea garden)
const spawnInfo = await ev(c, `(()=>{const p=window.__sf.player.position;return JSON.stringify([Math.round(p.x),Math.round(p.z)]);})()`);
console.log("spawn xz:", spawnInfo);
// open the full map + let it draw
await ev(c, `(()=>{ const b=document.querySelector('.mm-expand'); if(b) b.click(); return !!b; })()`);
await sleep(600);
await ev(c, `(()=>{ window.__sf.minimap.expanded = true; window.__sf.minimap.update?.(); return true; })()`);
await sleep(800);
const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92, fromSurface: true });
writeFileSync(OUT, Buffer.from(s.data, "base64"));
console.log("shot", OUT);
chrome.kill();
process.exit(0);
