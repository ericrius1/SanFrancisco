// Headless verification for the MASTER foliage toggle.
//
// Boots the app in headless Chrome (WebGPU via ANGLE-metal), freezes the wall
// clock, and at two spots (Botanical meadow + a city park) screenshots the
// scene with foliage ON, then flips window.__sf.setFoliageVisible(false),
// settles, screenshots OFF, flips back ON, screenshots RESTORED. Also reports
// the median (p50) frame wall-time with foliage OFF at the meadow.
//
//   node tools/foliage-toggle-probe.mjs
// Env: SF_PROBE_OUT (dir, default .data/foliage-toggle), SF_PROBE_URL, CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/foliage-toggle");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5221";
const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [name, x, z, facing(rad), backDist, upHeight, findPark]
// findPark: snap to the nearest surfaceType===1 (city park green) patch near
// the nominal coords so the street-greens A/B actually has greens in frame.
const VIEWS = [
  ["meadow", -2260, 2450, 1.2, 12, 3.4, false],
  ["city_park", 900, 2400, 0.6, 14, 4.0, true]
];
const ONLY = process.env.SF_PROBE_VIEW ?? null; // run a single view by name

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
      if (!m.id) { if (this.onEvent) this.onEvent(m); return; }
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

async function measureP50(c) {
  const s = await ev(c, `(async()=>{
    const r=window.__sf.renderer, dev=r.backend&&r.backend.device;
    const sync=async()=>{ if(dev&&dev.queue&&dev.queue.onSubmittedWorkDone) await dev.queue.onSubmittedWorkDone(); };
    for(let i=0;i<6;i++){window.__sf.tick(1/60);await sync();}
    const xs=[];const N=32;
    for(let i=0;i<N;i++){const t=performance.now();window.__sf.tick(1/60);await sync();xs.push(performance.now()-t);}
    xs.sort((a,b)=>a-b);
    const inf=r.info.render;
    return{p50:xs[Math.floor(N/2)],calls:inf.calls,tris:inf.triangles};
  })()`);
  return s;
}
async function setFoliage(c, on) {
  await ev(c, `window.__sf.setFoliageVisible(${on})`);
}
async function readFoliageState(c) {
  return await ev(c, `(()=>{const g=window.__sf.garden.group.visible;const w=window.__sf.wildlands.groups.map(x=>x.visible);return{garden:g,wildlands:w,tuning:window.__sf.FOLIAGE_TUNING.values.visible};})()`);
}
async function teleport(c, x, z, facing) {
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:${facing},mode:'walk'});return true;})()`);
}
async function freeCam(c, x, z, facing, back, up) {
  await ev(c, `(()=>{const m=window.__sf.map;const gy=m.groundHeight(${x},${z});
    const dx=Math.sin(${facing}),dz=Math.cos(${facing});
    const eye=[${x}-dx*${back}, gy+${up}, ${z}-dz*${back}];
    window.__sfFreeCam(eye,[${x}+dx*35, gy+${Math.max(3, up * 0.15)}, ${z}+dz*35]);return true;})()`);
}
async function shot(c, name) {
  const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88, fromSurface: true });
  writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(s.data, "base64"));
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
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      console.log("[page-exception]", (d.exception && (d.exception.description || d.exception.value)) || d.text);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      console.log("[page-error]", m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300));
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.wildlands&&window.__sf.garden&&window.__sf.setFoliageVisible&&window.__sf.player)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready");
  console.log(`[probe] __sf ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  await settle(c, 12);

  const report = {};
  for (const [name, x0, z0, facing, back, up, findPark] of VIEWS) {
    if (ONLY && name !== ONLY) continue;
    try {
    let x = x0, z = z0;
    if (findPark) {
      // spiral-scan for the densest city-park (surfaceType 1) patch near the
      // nominal spot; grass/flowers only scatter on green, never the street.
      const p = await ev(c, `(()=>{const m=window.__sf.map;let best=null,bestScore=-1;
        for(let r=0;r<=500;r+=20)for(let a=0;a<Math.PI*2;a+=Math.PI/12){
          const px=${x0}+Math.cos(a)*r,pz=${z0}+Math.sin(a)*r;
          if(m.surfaceType(px,pz)!==1)continue;
          let score=0;for(let dx=-15;dx<=15;dx+=10)for(let dz=-15;dz<=15;dz+=10)if(m.surfaceType(px+dx,pz+dz)===1)score++;
          score-=r/500; if(score>bestScore){bestScore=score;best=[px,pz];}
          if(bestScore>=15)return best;}
        return best;})()`);
      if (p) { x = p[0]; z = p[1]; console.log(`[park] snapped ${name} to (${x.toFixed(0)}, ${z.toFixed(0)})`); }
      else console.log(`[park] no park surface near (${x0}, ${z0}) — using nominal spot`);
    }
    await teleport(c, x, z, facing);
    await settle(c, 16);
    await freeCam(c, x, z, facing, back, up);
    for (let i = 0; i < 24; i++) { await tick(c, 1 / 60); await sleep(25); }

    // ON
    await setFoliage(c, true);
    for (let i = 0; i < 10; i++) { await tick(c, 1 / 60); await sleep(25); }
    const onState = await readFoliageState(c);
    await shot(c, `${name}_on`);

    // OFF
    await setFoliage(c, false);
    for (let i = 0; i < 8; i++) { await tick(c, 1 / 60); await sleep(25); }
    const offState = await readFoliageState(c);
    await shot(c, `${name}_off`);
    const offPerf = await measureP50(c);

    // RESTORED
    await setFoliage(c, true);
    for (let i = 0; i < 10; i++) { await tick(c, 1 / 60); await sleep(25); }
    const restoredState = await readFoliageState(c);
    await shot(c, `${name}_restored`);
    const onPerf = await measureP50(c);

    report[name] = {
      onState, offState, restoredState,
      offP50ms: +offPerf.p50.toFixed(2), offCalls: offPerf.calls, offTris: offPerf.tris,
      onP50ms: +onPerf.p50.toFixed(2), onCalls: onPerf.calls, onTris: onPerf.tris
    };
    console.log(`[${name}]`, JSON.stringify(report[name]));
    } catch (e) {
      report[name] = { error: String(e).slice(0, 200) };
      console.log(`[view-fail] ${name}: ${String(e).slice(0, 160)}`);
      break; // tab likely gone — stop rather than cascade
    }
  }
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`[probe] shots + report.json in ${OUT}`);
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
