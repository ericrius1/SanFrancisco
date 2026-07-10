// Boot headless, settle at a stop, measure frame p50 + save a PNG screenshot.
// Visual + timing sanity in one shot.
//   node tools/perf-shot-probe.mjs [downtown|meadow|marina] [outName]
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/perf-shot");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5199";
const W = Number(process.env.SF_W ?? 1600), H = Number(process.env.SF_H ?? 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WHERE = process.argv[2] ?? "downtown";
const NAME = process.argv[3] ?? WHERE;
const STOPS = {
  downtown: { x: 4117, z: 200, facing: Math.PI },
  meadow: { x: -2260, z: 2450, facing: 2.4 },
  marina: { x: -700, z: -2380, facing: 0.6 },
  embarcadero: { x: 3950, z: -1050, facing: 2.6 },
  fidi: { x: 4260, z: 420, facing: -2.4 }
};
const STOP = WHERE === "spawn" ? null : (STOPS[WHERE] ?? STOPS.downtown);

async function isFile(p) { try { return existsSync(p); } catch { return false; } }
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !(await isFile(c))) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
}
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); }
  throw new Error(`timeout ${label}: ${url}`);
}
async function startDevIfNeeded() {
  try { await waitHttp(SERVER_URL, 2500, "existing vite"); return null; } catch {}
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
}
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) return;
      const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { this.#ws.close(); }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, "chrome-" + NAME)}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`
  ], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);
  let page;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl);
      if (page) break;
    } catch {}
    await sleep(400);
  }
  if (!page) throw new Error("no app page target");
  const c = new Cdp(page.webSocketDebuggerUrl);
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("app never ready");
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  if (STOP) await ev(c, `(()=>{const sf=window.__sf;const gy=sf.map.groundHeight(${STOP.x},${STOP.z});sf.player.teleportTo({x:${STOP.x},y:gy+1.6,z:${STOP.z},facing:${STOP.facing},mode:'walk'});return true;})()`);
  // settle with fence-yields so streaming completes
  for (let k = 0; k < 25; k++) {
    await ev(c, `(async()=>{const sf=window.__sf;const dev=sf.renderer.backend.device;for(let i=0;i<30;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}return true;})()`);
    await sleep(250);
  }
  const m = await ev(c, `(async()=>{
    const dev=window.__sf.renderer.backend.device; const cpu=[], tot=[];
    for(let i=0;i<40;i++){ window.__sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); }
    for(let i=0;i<90;i++){
      const a=performance.now(); window.__sf.tick(1/60);
      const b=performance.now(); await dev.queue.onSubmittedWorkDone();
      cpu.push(b-a); tot.push(performance.now()-a);
    }
    const p50=(arr)=>{arr=[...arr].sort((x,y)=>x-y);return +arr[arr.length>>1].toFixed(2);};
    return { cpu:p50(cpu), tot:p50(tot) };
  })()`);
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, `${NAME}.png`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(`[shot:${WHERE}] frame p50 ${m.tot}ms  cpu p50 ${m.cpu}ms  -> ${file}`);
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
