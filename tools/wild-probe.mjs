// Headless render + perf probe for the wildlands foliage.
//
// Boots the app in headless Chrome (WebGPU via ANGLE-metal), freezes the wall
// clock, teleports the player to a set of viewpoints across Golden Gate Park /
// Presidio / Marin, screenshots each, and measures the foliage cost by A/B
// toggling the wildlands (+garden) groups' visibility while reading real GPU
// time (renderer.info.render.timestamp) + drawCalls + triangles.
//
//   node tools/wild-probe.mjs
// Env: SF_PROBE_OUT (dir, default .data/wild-probe), SF_PROBE_URL, CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/wild-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5188";
const W = 1600, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// viewpoints: [name, x, z, facing(rad)] — chosen to frame each region's foliage
const VIEWS = [
  ["ggpark_meadow", -3400, 2300, 0.6],
  ["ggpark_dell", -2500, 2320, 1.2],
  ["ggpark_west", -5200, 2400, 2.4],
  ["presidio_forest", -1600, -1000, 0.4],
  ["presidio_crissy", -1200, -1750, 1.0],
  ["marin_hills", -4400, -6300, 0.8],
  ["marin_coast", -3400, -5200, 2.0]
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
      const m = JSON.parse(e.data.toString()); if (!m.id) return;
      const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); }
  close() { this.#ws.close(); }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(0)); await sleep(60); } }

async function measure(c) {
  // enable GPU timestamps, warm a few frames, then average GPU ms + read draws/tris
  await ev(c, `(()=>{const b=window.__sf.renderer.backend;if(b)b.trackTimestamp=true;return true;})()`);
  for (let i = 0; i < 8; i++) await tick(c, 1 / 60);
  const s = await ev(c, `(async()=>{let g=0,n=0;for(let i=0;i<20;i++){window.__sf.tick(1/60);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const t=window.__sf.renderer.info.render.timestamp;if(t>0){g+=t;n++;}}
    const inf=window.__sf.renderer.info.render;return{gpuMs:n?g/n:0,draws:inf.drawCalls,tris:inf.triangles};})()`);
  return s;
}
async function setFoliage(c, on) {
  await ev(c, `(()=>{for(const g of window.__sf.wildlands.groups)g.visible=${on};window.__sf.garden.group.visible=${on};return true;})()`);
}
async function teleport(c, x, z, facing) {
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:${facing},mode:'walk'});return true;})()`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  const profile = path.join(OUT, "chrome");
  const proc = spawn(chrome, [
    `--user-data-dir=${profile}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`
  ], { cwd: ROOT, stdio: "ignore" });
  await sleep(1500);
  // find the page target
  let list;
  for (let i = 0; i < 40; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (list.find((t) => t.type === "page")) break; } catch {} await sleep(300); }
  const page = list.find((t) => t.type === "page");
  const c = new Cdp(page.webSocketDebuggerUrl);
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) { if (await ev(c, `!!(window.__sf&&window.__sf.wildlands&&window.__sf.player)`)) break; await sleep(500); }
  await ev(c, `window.__sfManual&&window.__sfManual(true)`); // freeze wall clock
  await settle(c, 12); // let tiles + hero trees stream

  const results = [];
  for (const [name, x, z, facing] of VIEWS) {
    await teleport(c, x, z, facing);
    await settle(c, 16); // stream this area's tiles + grow species heroes
    for (let i = 0; i < 6; i++) await tick(c, 1 / 60);
    const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88, fromSurface: true });
    writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(shot.data, "base64"));
    const on = await measure(c);
    await setFoliage(c, false);
    const off = await measure(c);
    await setFoliage(c, true);
    const row = { view: name, gpuOn: +on.gpuMs.toFixed(2), gpuOff: +off.gpuMs.toFixed(2), gpuFoliage: +(on.gpuMs - off.gpuMs).toFixed(2), drawsOn: on.draws, drawsFoliage: on.draws - off.draws, trisFoliageM: +((on.tris - off.tris) / 1e6).toFixed(2) };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  const stats = await ev(c, `({trees:window.__sf.wildlands.stats,garden:window.__sf.garden.stats})`);
  writeFileSync(path.join(OUT, "perf.json"), JSON.stringify({ results, stats }, null, 2));
  console.log("[probe] stats", JSON.stringify(stats));
  console.log(`[probe] screenshots + perf.json in ${OUT}`);
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
