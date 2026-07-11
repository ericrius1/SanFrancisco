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
  // settle: fence-yielded ticks until draw count plateaus
  let lastDraws = -1;
  for (let k = 0; k < 40; k++) {
    const d = await ev(c, `(async()=>{
      const sf = window.__sf; const dev = sf.renderer.backend.device;
      for (let i=0;i<30;i++){ sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); }
      sf.renderer.info.autoReset = false;
      sf.renderer.info.reset(); sf.tick(1/60); await dev.queue.onSubmittedWorkDone();
      return sf.renderer.info.render.drawCalls ?? sf.renderer.info.render.calls ?? 0;
    })()`);
    if (k > 4 && lastDraws > 50 && Math.abs(d - lastDraws) < Math.max(3, lastDraws * 0.01)) { lastDraws = d; break; }
    lastDraws = d;
    await sleep(300);
  }
  console.log(`[ablate] settled ~${lastDraws} draws`);

  // per-frame draw series: catch shadow-throttle alternation
  const series = await ev(c, `(async()=>{
    const sf = window.__sf; const dev = sf.renderer.backend.device;
    sf.renderer.info.autoReset = false;
    const out = [];
    for (let i=0;i<12;i++){ sf.renderer.info.reset(); sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); out.push(sf.renderer.info.render.drawCalls ?? sf.renderer.info.render.calls ?? 0); }
    return out;
  })()`);
  console.log(`[ablate] 12-frame draw series: ${series.join(" ")}`);

  const WARM = 30, MEASURE = 70;
  const timeExpr = `(async()=>{
    const dev=window.__sf.renderer.backend.device; const cpu=[], tot=[];
    for(let i=0;i<${WARM};i++){ window.__sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); }
    window.__sf.renderer.info.autoReset = false;
    let draws = 0;
    for(let i=0;i<${MEASURE};i++){
      window.__sf.renderer.info.reset();
      const a=performance.now(); window.__sf.tick(1/60);
      const b=performance.now(); await dev.queue.onSubmittedWorkDone();
      cpu.push(b-a); tot.push(performance.now()-a);
      draws = Math.max(draws, window.__sf.renderer.info.render.drawCalls ?? window.__sf.renderer.info.render.calls ?? 0);
    }
    const p50=(arr)=>{arr=[...arr].sort((x,y)=>x-y);return +arr[arr.length>>1].toFixed(2);};
    return { cpu:p50(cpu), tot:p50(tot), draws };
  })()`;

  const rows = [];
  const run = async (label) => {
    const m = await ev(c, timeExpr);
    rows.push({ label, ...m });
    console.log(`  ${label.padEnd(40)} cpu ${String(m.cpu).padStart(6)}ms  tot ${String(m.tot).padStart(6)}ms  maxdraws ${m.draws}`);
  };

  await run("BASE");

  // 1: trio shadow casters only
  await ev(c, `(()=>{const sf=window.__sf; sf.__abl=[]; sf.buskers.group.traverse(o=>{ if(o.castShadow){ sf.__abl.push(o); o.castShadow=false; } }); return sf.__abl.length;})()`);
  await run("buskers castShadow OFF");
  await ev(c, `(()=>{const sf=window.__sf; for(const o of sf.__abl) o.castShadow=true; return true;})()`);

  // 2: trio fully hidden
  await ev(c, `(()=>{window.__sf.buskers.group.visible=false; return true;})()`);
  await run("buskers hidden");
  await ev(c, `(()=>{window.__sf.buskers.group.visible=true; return true;})()`);

  // 3: corona heights park hidden (stub update so gate can't re-show)
  await ev(c, `(()=>{const sf=window.__sf; sf.__chUp=sf.coronaHeights.update; sf.coronaHeights.update=()=>{}; sf.coronaHeights.group.visible=false; return true;})()`);
  await run("coronaHeights hidden");
  await ev(c, `(()=>{const sf=window.__sf; sf.coronaHeights.update=sf.__chUp; sf.coronaHeights.group.visible=true; return true;})()`);

  // 4: wildlands flowers hidden
  await ev(c, `(()=>{const sf=window.__sf; let n=0; sf.scene.traverse(o=>{ if(o.name==="wildlands_flowers"){o.visible=false;n++;} }); return n;})()`);
  await run("wildlands_flowers hidden");
  await ev(c, `(()=>{const sf=window.__sf; sf.scene.traverse(o=>{ if(o.name==="wildlands_flowers"){o.visible=true;} }); return true;})()`);

  // 5: road markings hidden
  await ev(c, `(()=>{const sf=window.__sf; let n=0; sf.scene.traverse(o=>{ if(/RoadMarkings/.test(o.name)){o.visible=false;n++;} }); return n;})()`);
  await run("roadMarkings hidden");
  await ev(c, `(()=>{const sf=window.__sf; sf.scene.traverse(o=>{ if(/RoadMarkings/.test(o.name)){o.visible=true;} }); return true;})()`);

  // 6: all shadow casters off scene-wide (upper bound of shadow-pass encode)
  await ev(c, `(()=>{const sf=window.__sf; sf.__abl2=[]; sf.scene.traverse(o=>{ if(o.castShadow){ sf.__abl2.push(o); o.castShadow=false; } }); return sf.__abl2.length;})()`);
  await run("ALL castShadow OFF");
  await ev(c, `(()=>{const sf=window.__sf; for(const o of sf.__abl2) o.castShadow=true; return true;})()`);

  writeFileSync(path.join(OUT, "ablate.json"), JSON.stringify(rows, null, 2));
  console.log(`[ablate] done`);
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
