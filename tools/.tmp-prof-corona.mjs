// Scene census: WHO owns the draw calls and triangles. Boots headless, parks at
// stops, and for each visible mesh that survives frustum culling attributes its
// draw + triangle count to its top-level scene-graph ancestor (or name prefix).
// Also dumps the 20 heaviest individual meshes. Pure diagnosis, no timing.
//
//   node tools/perf-census-probe.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/perf-census");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5198";
const W = Number(process.env.SF_W ?? 2560), H = Number(process.env.SF_H ?? 1600);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STOPS = [
  { name: "corona-summit-n", x: 398, z: 2752, facing: 0.0, mode: "walk" }
];

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

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, "chrome")}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    // `profile` exposes window.__sf on PROD builds too (import.meta.env.DEV is
    // false there); on a dev server it's a harmless no-op. Lets this probe run
    // against a static prod build, immune to concurrent-edit HMR reloads.
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&profile&fullfps`
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


  const stop = STOPS[0];
  await ev(c, `(()=>{const sf=window.__sf;const gy=sf.map.groundHeight(${stop.x},${stop.z});sf.player.teleportTo({x:${stop.x},y:gy+1.6,z:${stop.z},facing:${stop.facing},mode:'${stop.mode}'});return true;})()`);
  await ev(c, `(async()=>{const sf=window.__sf;const dev=sf.renderer.backend.device;for(let i=0;i<150;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}return true;})()`);

  await c.send("Profiler.enable");
  await c.send("Profiler.setSamplingInterval", { interval: 100 });
  await c.send("Profiler.start");
  await ev(c, `(async()=>{const sf=window.__sf;const dev=sf.renderer.backend.device;for(let i=0;i<200;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}return true;})()`);
  const prof = await c.send("Profiler.stop");
  const p = prof.profile;
  const self = new Map();
  const byId = new Map(p.nodes.map(n => [n.id, n]));
  const total = p.samples.length;
  const counts = new Map();
  for (const s of p.samples) counts.set(s, (counts.get(s) || 0) + 1);
  for (const [id, n] of counts) {
    const node = byId.get(id); if (!node) continue;
    const f = node.callFrame;
    const key = (f.functionName || "(anon)") + " @ " + (f.url || "").split("/").slice(-1)[0].split("?")[0] + ":" + f.lineNumber;
    self.set(key, (self.get(key) || 0) + n);
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log(`[prof] ${total} samples`);
  for (const [k, n] of top) console.log(`  ${(100 * n / total).toFixed(1).padStart(5)}%  ${k}`);
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
