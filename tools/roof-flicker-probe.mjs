// Diagnoses roof flicker/banding on citygen detail buildings. Locks a camera
// above a settled detail roofscape, then captures:
//   A/B/C  three consecutive frames, identical camera  → temporal flicker (shadow)
//   D      sun moved (setTimeOfDay)                    → acne moves with sun
//   E      2 cm camera dolly                           → z-fight decorrelates
//   node tools/roof-flicker-probe.mjs
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
async function tick(c, dt = 0.05) { try { await evaluate(c, `window.__sf.tick(${dt})`); } catch {} }
async function shot(c, name) { const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92 }); writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64")); console.log("  saved", name); }
async function main() {
  await mkdir(OUT, { recursive: true });
  const vitePort = await freePort();
  const relayPort = await freePort();
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort) }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome(); const dport = await freePort(); let chrome;
  try {
    await waitHttp(`http://127.0.0.1:${vitePort}`, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-roof-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.citygenRing && window.__sf.citygenRing.current)", 120000);
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(10.5); if(!window.__f){window.__f=1;s.chase.update=()=>{};s.player.update=()=>{};} return 1;})()`);
    const gy = await evaluate(c, "window.__sf.map.groundHeight(900,2400)");
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player;const y=${gy}+2;p.position.set(900,y,2400);p.renderPosition.copy(p.position);s.physics.world.setBodyTransform(p.body,[900,y,2400],[0,0,0,1]);return 1;})()`);
    for (let i = 0; i < 90; i++) await tick(c); // settle: detail fades complete
    // camera just above the rooftops looking DOWN the row at a shallow angle
    const camY = gy + 16;
    const setCam = (dx = 0) => evaluate(c, `(()=>{const c=window.__sf.camera;c.position.set(${880 + (dx || 0)},${camY},2385);c.lookAt(930,${gy + 8},2410);return 1;})()`);
    const nearby = await evaluate(c, "window.__sf.citygenRing.current.debugEntriesNear(900,2400,80)");
    console.log("[probe] entries near:", JSON.stringify(nearby.slice(0, 8)));
    await setCam(); await shot(c, "roof_A.jpg");
    await tick(c, 0.016); await setCam(); await shot(c, "roof_B.jpg");
    await tick(c, 0.016); await setCam(); await shot(c, "roof_C.jpg");
    await evaluate(c, "window.__sf.sky.setTimeOfDay(14.0)");
    for (let i = 0; i < 4; i++) await tick(c, 0.016);
    await setCam(); await shot(c, "roof_D_sun14.jpg");
    await evaluate(c, "window.__sf.sky.setTimeOfDay(10.5)");
    for (let i = 0; i < 4; i++) await tick(c, 0.016);
    await setCam(0.02); await shot(c, "roof_E_dolly.jpg");
    // higher aerial for the wide roofscape banding the user showed
    await evaluate(c, `(()=>{const c=window.__sf.camera;c.position.set(870,${gy + 40},2360);c.lookAt(940,${gy},2420);return 1;})()`);
    await shot(c, "roof_F_aerial.jpg");
    console.log("[probe] page errors:", c.errs.length ? c.errs.slice(0, 3) : "none");
    c.close(); console.log("[probe] done");
  } finally { chrome?.kill("SIGTERM"); try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); } }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
