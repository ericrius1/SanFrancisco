// Mission Dolores museum probe: spawns its own vite + headless WebGPU Chrome,
// teleports to the basilica, and shoots the façade, the nave toward the altar,
// the nave toward the rose window, a 3/4 aerial, and the opened Canticle book.
//   node tools/mission-dolores-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 1000;
const OUT = process.env.SF_OUT ?? path.join(ROOT, ".data", "mission-dolores-shots");
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
  const dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relayPort), SF_HMR: "0" }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const chromePath = await findChrome();
  const dport = await freePort();
  let chrome;
  const consoleErrors = [];
  try {
    await waitHttp(SERVER_URL, 90000);
    chrome = spawn(chromePath, [`--remote-debugging-port=${dport}`, `--user-data-dir=${path.join(OUT, "chrome-" + Date.now())}`, "--headless=new", "--no-first-run", "--mute-audio", "--enable-features=SharedArrayBuffer", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-gpu", "--enable-features=WebGPUDeveloperFeatures", `--window-size=${W},${H}`, "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
    let t = Date.now(); while (Date.now() - t < 15000) { try { await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); break; } catch { await sleep(200); } }
    const pg = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
    const c = new Cdp(pg.webSocketDebuggerUrl); await c.open();
    c.onEvent = (method, params) => {
      if (method === "Runtime.exceptionThrown") consoleErrors.push(`[exception] ${params.exceptionDetails?.text ?? ""} ${params.exceptionDetails?.exception?.description ?? ""}`);
      if (method === "Runtime.consoleAPICalled" && params.type === "error") consoleErrors.push(`[console.error] ${(params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")}`);
    };
    await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable"); await c.send("Network.setCacheDisabled", { cacheDisabled: true });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1` });
    await waitEval(c, "Boolean(window.__sf && window.__sf.player && window.__sf.missionDolores)", 120000);

    // freeze the world for deterministic shots, warm midday light
    await evaluate(c, `(()=>{const s=window.__sf; s.sky.cycleEnabled=false; s.sky.setTimeOfDay(14.0);
      if(!window.__f){window.__f=1; s.chase.update=()=>{}; s.player.update=()=>{};} return 1;})()`);

    const floorTop = await evaluate(c, "window.__sf.missionDolores.floorTop");
    const CX = 1560, CZ = 3235;
    console.log("[probe] museum floorTop:", floorTop);

    // teleport the player into the nave so terrain around the church streams
    await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=${floorTop}+1.6; p.position.set(${CX},y,${CZ - 20}); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[${CX},y,${CZ - 20}],[0,0,0,1]); return 1;})()`);
    for (let i = 0; i < 70; i++) await tick(c);
    await waitEval(c, "window.__sf.renderIdle && window.__sf.renderIdle()", 120000);
    await sleep(2500); // let plaque/rose textures finish loading
    for (let i = 0; i < 20; i++) await tick(c);
    console.log("[probe] isPlayerInside:", await evaluate(c, `window.__sf.missionDolores.isPlayerInside(window.__sf.player.position)`));

    const setCam = (px, py, pz, lx, ly, lz) => evaluate(c, `(()=>{const c=window.__sf.camera; c.position.set(${px},${py},${pz}); c.lookAt(${lx},${ly},${lz}); return 1;})()`);
    const F = floorTop;
    const frame = async (name, cam, look) => {
      await setCam(...cam, ...look);
      for (let k = 0; k < 3; k++) await tick(c);
      await setCam(...cam, ...look);
      await sleep(300);
      await shot(c, name);
    };

    // 1. façade + bell towers (from outside the entrance, local -z / world z<2976)
    await frame("md_1_facade.jpg", [CX, F + 7, CZ - 62], [CX, F + 9, CZ - 30]);
    // 2. 3/4 aerial of the whole basilica
    await frame("md_2_aerial.jpg", [CX + 46, F + 26, CZ - 52], [CX, F + 6, CZ - 4]);
    // 3. nave interior toward the altar/apse
    await frame("md_3_nave_altar.jpg", [CX, F + 2.6, CZ - 26], [CX, F + 3.5, CZ + 32]);
    // 4. nave interior looking back toward the rose window over the portal
    await frame("md_4_nave_rose.jpg", [CX, F + 3.2, CZ + 12], [CX, F + 8.5, CZ - 35]);
    // 5. side view down a colonnade aisle (west gallery) toward the altar
    await frame("md_5_west_aisle.jpg", [CX - 10, F + 2.4, CZ - 24], [CX - 10, F + 2.6, CZ + 20]);
    // 8. upward at an angle (offset so lookAt isn't degenerate) — vault ceiling check
    await frame("md_8_ceiling.jpg", [CX - 5, F + 2, CZ - 10], [CX + 3, F + 13, CZ + 2]);

    // 6. open the Canticle book at the pedestal and shoot the WebGPU reader.
    // The book is a 3D quad drawn in front of the camera, so we must keep TICKING
    // after opening (the tick's book branch renders it + glues it to the camera).
    const opened = await evaluate(c, `(()=>{const s=window.__sf,p=s.player; const y=${F}+1.6; p.position.set(${CX},y,${CZ - 28}); p.renderPosition.copy(p.position); s.physics.world.setBodyTransform(p.body,[${CX},y,${CZ - 28}],[0,0,0,1]);
      s.camera.position.set(${CX}, y, ${CZ - 24}); s.camera.lookAt(${CX}, y, ${CZ + 10});
      s.missionDolores.tryInteract(p.position, 'walk', { message(){} }); return s.missionDolores.bookOpen; })()`);
    console.log("[probe] book opened:", opened, "museumBookOpen(render branch active):", await evaluate(c, `!!window.__sf.missionDolores.bookOpen`));
    for (let i = 0; i < 12; i++) await tick(c);
    console.log("[probe] bookdbg:", JSON.stringify(await evaluate(c, `(()=>{const s=window.__sf; const cam=s.camera; const found=[]; s.scene.traverse(o=>{ if(o.renderOrder>=990){ const wp=new s.THREE.Vector3(); o.getWorldPosition(wp); found.push({n:o.name||o.type, ro:o.renderOrder, vis:o.visible, wp:[+wp.x.toFixed(1),+wp.y.toFixed(1),+wp.z.toFixed(1)], mat:o.material&&o.material.type}); } }); const cp=cam.position; return {count:found.length, cam:[+cp.x.toFixed(1),+cp.y.toFixed(1),+cp.z.toFixed(1)], sample:found.slice(0,4)}; })()`)));
    await sleep(600);
    await shot(c, "md_6_book_cover.jpg");
    // turn a few pages via the reader's own arrow-key handler
    await evaluate(c, `(()=>{for(let i=0;i<2;i++) window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'})); return 1;})()`);
    for (let i = 0; i < 12; i++) await tick(c);
    await sleep(500);
    await shot(c, "md_7_book_page.jpg");

    console.log("[probe] console errors:", consoleErrors.length ? "\n  " + consoleErrors.slice(0, 20).join("\n  ") : "(none)");
    c.close();
    console.log("[probe] done");
  } finally {
    chrome?.kill("SIGTERM");
    try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
