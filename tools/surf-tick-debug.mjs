// Minimal repro: autostart at oceanBeach, E-enter surf live, switch to manual
// ticking, and report whether the sim advances.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const SERVER_URL = process.env.SF_PROBE_URL ?? "http://localhost:5243";
const PROFILE = path.join(process.env.TMPDIR ?? "/tmp", `sf-tick-debug-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)) {
    if (!c.includes("/") || existsSync(c)) return c;
  }
  throw new Error("no chrome");
}
class Cdp {
  #s; #id = 1; #p = new Map();
  constructor(url) { this.#s = new WebSocket(url); }
  async open() {
    await new Promise((res, rej) => { this.#s.addEventListener("open", res, { once: true }); this.#s.addEventListener("error", rej, { once: true }); });
    this.#s.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) return;
      const p = this.#p.get(m.id);
      if (!p) return;
      this.#p.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result ?? {});
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#s.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.#p.set(id, { resolve: res, reject: rej }));
  }
  close() { this.#s.close(); }
}
async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result?.value;
}
async function waitEval(cdp, expr, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evaluate(cdp, expr)) return; } catch {}
    await sleep(200);
  }
  throw new Error(`timeout: ${label}`);
}

const chromePort = await freePort();
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(findChrome(), [
  `--remote-debugging-port=${chromePort}`, `--user-data-dir=${PROFILE}`,
  "--headless=new", "--no-first-run", "--mute-audio", "--enable-unsafe-webgpu",
  "--enable-gpu", "--use-angle=metal", "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
  "--window-size=1280,800", "about:blank"
], { stdio: "ignore" });
try {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { try { await (await fetch(`http://127.0.0.1:${chromePort}/json/version`)).json(); break; } catch {} await sleep(200); }
  const page = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: "PUT" })).json();
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1&spawn=oceanBeach` });
  await waitEval(cdp, "Boolean(document.body.classList.contains('started') && window.__sf?.player)", 180000, "started");
  await evaluate(cdp, `(()=>{const s=window.__sf; if(!s.renderIdle?.()) s.pipeline.warmup=async()=>{}; return true;})()`);
  await waitEval(cdp, "window.__sf.renderIdle?.()===true", 30000, "idle");
  await sleep(800);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyE", key: "e", windowsVirtualKeyCode: 69 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyE", key: "e", windowsVirtualKeyCode: 69 });
  await waitEval(cdp, "window.__sf.player.mode==='surf'", 15000, "surf");
  await sleep(500);
  const probe = await evaluate(cdp, `(async()=>{
    const s=window.__sf,p=s.player;
    const snap=()=>({mode:p.mode,x:+p.position.x.toFixed(2),z:+p.position.z.toFixed(2),
      y:+p.position.y.toFixed(2),speed:+p.surfTelemetry.speed.toFixed(2),
      crest:+p.surfTelemetry.crestDistance.toFixed(2),lineDir:p.surfTelemetry.lineDirection,
      camZ:+(s.chase.surfCameraDiagnostics()?.position.z??0).toFixed(2)});
    const live=snap();
    window.__sfManual(true);
    await new Promise(r=>setTimeout(r,120));
    const before=snap();
    for(let i=0;i<120;i++)s.tick(1/60);
    const after=snap();
    // steering: hold A (steer +1) via direct key injection
    s.input.keys.add('KeyA');
    for(let i=0;i<90;i++)s.tick(1/60);
    s.input.keys.delete('KeyA');
    const afterA=snap();
    s.input.keys.add('KeyD');
    for(let i=0;i<90;i++)s.tick(1/60);
    s.input.keys.delete('KeyD');
    const afterD=snap();
    return {live,before,after,afterA,afterD,keysType:typeof s.input.keys};
  })()`);
  console.log(JSON.stringify(probe, null, 1));
  cdp.close();
} finally {
  chrome.kill("SIGTERM");
  await sleep(300);
  rmSync(PROFILE, { recursive: true, force: true });
}
