// Drawing-buffer resolution probe at a fixed stop. Each candidate is measured
// between two DPR-1 control runs so thermal/load drift does not masquerade as a
// resolution cost.
//
//   node tools/perf-ablation-probe.mjs [downtown|meadow]
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/perf-ablation");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5198";
const W = Number(process.env.SF_W ?? 2560), H = Number(process.env.SF_H ?? 1600);
const MEASURE = 90, WARM = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WHERE = process.argv[2] ?? "downtown";
const STOP = WHERE === "meadow"
  ? { x: -2260, z: 2450, facing: 2.4 }
  : { x: 4117, z: 200, facing: Math.PI };

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
  console.log(`[probe] starting Vite at ${SERVER_URL}`);
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

async function bootPage(chrome, profileTag, urlExtra = "") {
  const port = await freePort();
  const proc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, profileTag)}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&profile&fullfps${urlExtra}`
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
  if (!page) { proc.kill(); throw new Error("no app page target"); }
  const c = new Cdp(page.webSocketDebuggerUrl);
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) { proc.kill(); throw new Error("app never ready"); }
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  return { c, proc };
}

async function settle(c) {
  await ev(c, `(()=>{const sf=window.__sf;const gy=sf.map.groundHeight(${STOP.x},${STOP.z});sf.player.teleportTo({x:${STOP.x},y:gy+1.6,z:${STOP.z},facing:${STOP.facing},mode:'walk'});return true;})()`);
  let lastDraws = -1;
  for (let k = 0; k < 40; k++) {
    const d = await ev(c, `(async()=>{
      const sf = window.__sf; const dev = sf.renderer.backend.device;
      for (let i=0;i<30;i++){ sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); }
      sf.renderer.info.autoReset = false;
      sf.renderer.info.reset(); sf.tick(1/60); await dev.queue.onSubmittedWorkDone();
      return sf.renderer.info.render.drawCalls ?? 0;
    })()`);
    if (k > 4 && lastDraws > 50 && Math.abs(d - lastDraws) < Math.max(3, lastDraws * 0.01)) return d;
    lastDraws = d;
    await sleep(300);
  }
  return lastDraws;
}

const timeExpr = (n) => `(async()=>{
  const dev=window.__sf.renderer.backend.device; const cpu=[], tot=[];
  for(let i=0;i<${WARM};i++){ window.__sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); }
  for(let i=0;i<${n};i++){
    const a=performance.now(); window.__sf.tick(1/60);
    const b=performance.now(); await dev.queue.onSubmittedWorkDone();
    cpu.push(b-a); tot.push(performance.now()-a);
  }
  const p50=(arr)=>{arr=[...arr].sort((x,y)=>x-y);return +arr[arr.length>>1].toFixed(2);};
  return { cpu:p50(cpu), tot:p50(tot) };
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();

  // ---- session 1: everything runtime-togglable, one boot
  const { c, proc } = await bootPage(chrome, "chrome-a");
  const draws = await settle(c);
  console.log(`[ablate:${WHERE}] settled ~${draws} draws/frame`);

  const rows = [];
  const run = async (label, dpr) => {
    const size = await ev(c, `(()=>{const sf=window.__sf;
      sf.renderer.setPixelRatio(${dpr});
      sf.renderer.setSize(window.innerWidth, window.innerHeight);
      const out=sf.renderer.getDrawingBufferSize(new sf.THREE.Vector2());
      return { width: out.x, height: out.y };
    })()`);
    const m = await ev(c, timeExpr(MEASURE));
    const row = { label, dpr, ...size, ...m, gpuResidue: +(m.tot - m.cpu).toFixed(2) };
    rows.push(row);
    console.log(`  ${label.padEnd(24)} ${String(size.width + "x" + size.height).padStart(10)}  frame ${String(m.tot).padStart(6)}ms  cpu ${String(m.cpu).padStart(6)}ms`);
    return row;
  };

  const comparisons = [];
  for (const dpr of [1.25, 1.5, 2]) {
    const before = await run(`control before ${dpr}`, 1);
    const candidate = await run(`candidate dpr ${dpr}`, dpr);
    const after = await run(`control after ${dpr}`, 1);
    const baseFrame = (before.tot + after.tot) / 2;
    const baseGpu = (before.gpuResidue + after.gpuResidue) / 2;
    comparisons.push({
      dpr,
      pixelMultiplier: +(dpr * dpr).toFixed(4),
      frameDeltaMs: +(candidate.tot - baseFrame).toFixed(2),
      gpuResidueDeltaMs: +(candidate.gpuResidue - baseGpu).toFixed(2)
    });
  }
  c.close(); proc.kill();

  writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ where: WHERE, width: W, height: H, stop: STOP, rows, comparisons }, null, 2));
  console.log("\n[drift-controlled DPR deltas]");
  for (const row of comparisons) {
    console.log(`  dpr ${row.dpr.toFixed(2)} (${row.pixelMultiplier.toFixed(2)}x pixels): frame ${row.frameDeltaMs >= 0 ? "+" : ""}${row.frameDeltaMs}ms, gpu residue ${row.gpuResidueDeltaMs >= 0 ? "+" : ""}${row.gpuResidueDeltaMs}ms`);
  }
  console.log("\n[ablate] done");
  if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
