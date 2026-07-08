// Verifies the new CityGen neighborhood landmarks: each pin resolves on the map,
// and teleporting to one lands you among freshly streamed generated buildings.
// Screenshots the expanded map (dots) + the arrival street.
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
class Cdp { #ws; #id = 1; #p = new Map(); constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (m.id) { const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result ?? {}); } }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej })); } close() { this.#ws.close(); } }
async function ev(c, e) { const r = await c.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function waitEv(c, e, ms) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(c, e)) return; } catch {} await sleep(300); } throw new Error("eval timeout " + e); }
async function tick(c) { try { await ev(c, "window.__sf.tick(0.05)"); } catch {} }
async function shot(c, name) { const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90 }); writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64")); console.log("  saved", name); }
async function main() {
  await mkdir(OUT, { recursive: true });
  const vp = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vp), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: "8790" }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  try {
    await waitHttp(`http://127.0.0.1:${vp}`, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-lm-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vp}/?autostart=1&fullfps=1` });
    await waitEv(c, "Boolean(window.__sf && window.__sf.minimap && window.__sf.citygenRing)", 120000);
    await ev(c, `(()=>{const s=window.__sf;s.sky.cycleEnabled=false;s.sky.setTimeOfDay(10.5);try{s.scene.environmentIntensity=0.35;}catch{} try{if(s.aiCars){s.aiCars.prePhysics=()=>{};s.aiCars.update=()=>{};if(s.aiCars.postPhysics)s.aiCars.postPhysics=()=>{};}}catch{} return 1;})()`);
    // 1) every landmark resolves on the map
    const names = ["Pacific Heights", "The Castro", "Sunset District", "SoMa", "Downtown"];
    const resolved = await ev(c, `JSON.stringify((${JSON.stringify(names)}).map(n=>{const p=window.__sf.minimap.focusLandmark(n);return [n, p?1:0];}))`);
    console.log("[probe] landmarks resolve:", resolved);
    // screenshot the expanded map (focused on The Castro, dots visible)
    await ev(c, `window.__sf.minimap.focusLandmark("The Castro")`);
    await sleep(400);
    await shot(c, "citygen_map_landmarks.jpg");
    await ev(c, `window.__sf.minimap.setExpanded(false)`);
    // 2) teleport to The Castro, stream, screenshot arrival
    await ev(c, `(()=>{const s=window.__sf;if(!window.__f){window.__f=1;s.chase.update=()=>{};s.player.update=()=>{};}return 1;})()`);
    const p = await ev(c, `(()=>{const s=window.__sf,pl=s.player;const x=199,z=3197,y=s.map.groundHeight(x,z)+2;pl.position.set(x,y,z);pl.renderPosition.copy(pl.position);s.physics.world.setBodyTransform(pl.body,[x,y,z],[0,0,0,1]);return {x,y,z};})()`);
    for (let i = 0; i < 90; i++) await tick(c);
    console.log("[probe] Castro stream:", JSON.stringify(await ev(c, "window.__sf.citygenRing.current.stats()")));
    const gy = p.y - 2;
    const setCam = (px, py, pz, lx, ly, lz) => ev(c, `(()=>{const c=window.__sf.camera;c.position.set(${px},${py},${pz});c.lookAt(${lx},${ly},${lz});return 1;})()`);
    await setCam(199 - 42, gy + 24, 3197 - 42, 199, gy + 6, 3197);
    for (let i = 0; i < 15; i++) await tick(c);
    await setCam(199 - 42, gy + 24, 3197 - 42, 199, gy + 6, 3197);
    await sleep(400);
    await shot(c, "citygen_castro.jpg");
    c.close(); console.log("[probe] done");
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
