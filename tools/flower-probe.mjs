// Headless render probe for the wildflower RING.
//
// Boots the app in headless Chrome (WebGPU via ANGLE-metal), freezes the wall
// clock, teleports to a few meadows, and screenshots ground-level bloom views to
// verify: flowers are dense + scattered through the grass, the density + clump
// tunables change the field live (via FLOWER_TUNING + flowers.refresh()), and the
// ring populates without error. Wind harmony is guaranteed by construction (flowers
// now call the same groundSway/WIND_DIR as the grass) — the shots just confirm both
// layers render together.
//
//   node tools/flower-probe.mjs
// Env: SF_PROBE_OUT (default .data/flower-probe), SF_PROBE_URL, CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/flower-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5189";
const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [name, x, z, facing, backDist, upHeight] — low + close ground bloom views
const VIEWS = [
  ["ggpark_poppy_meadow", -4000, 2440, 1.1, 9, 2.4],
  ["ggpark_lupine_walk", -2725, 2540, 1.2, 9, 2.4],
  ["marin_poppy_hills", -4450, -6250, 0.3, 9, 2.6]
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

async function teleport(c, x, z, _facing) {
  const generation = await ev(c, `(()=>{const sf=window.__sf;const g=sf.worldArrival.snapshot.generation;sf.teleportToTarget(${x},${z},'flower probe');return g;})()`);
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    await tick(c, 0);
    const arrived = await ev(c, `(()=>{const sf=window.__sf,a=sf.worldArrival.snapshot;return a.generation>${generation}&&a.state==='idle'&&!sf.player.worldArrivalHeld;})()`);
    if (arrived) return;
    await sleep(250);
  }
  throw new Error(`covered arrival timed out at ${x}, ${z}`);
}
async function freeCam(c, x, z, facing, back, up) {
  await ev(c, `(()=>{const m=window.__sf.map;
    const dx=Math.sin(${facing}),dz=Math.cos(${facing});
    const ex=${x}-dx*${back},ez=${z}-dz*${back};
    const tx=${x}+dx*20,tz=${z}+dz*20;
    const eye=[ex,m.groundHeight(ex,ez)+${up},ez];
    window.__sfFreeCam(eye,[tx,m.groundHeight(tx,tz)+${Math.max(1.5, up * 0.4)},tz]);return eye;})()`);
}
async function flowerStats(c) {
  return ev(c, `(()=>{const f=window.__sf.wildlands.flowers,s=f.stats;const per=f.group.children.map(m=>m.count||0);
    const g=window.__sf.wildlands.grass.group;let grass=0;for(const m of g.children){if(m.isInstancedMesh)grass+=m.count;else if(m.geometry?.isInstancedBufferGeometry&&Number.isFinite(m.geometry.instanceCount))grass+=m.geometry.instanceCount;}
    return{flowers:s.count,heads:s.heads,submittedTriangles:s.submittedTriangles,
      submittedInstances:s.submittedInstances,lodInstances:s.lodInstances,draws:s.draws,
      trianglesPerClump:s.trianglesPerClump,trianglesPerClumpByLod:s.trianglesPerClumpByLod,
      reservedInstanceBytes:s.reservedInstanceBytes,droppedByCapacity:s.droppedByCapacity,
      instanceCapPerSpecies:s.instanceCapPerSpecies,perBucket:per,grass};})()`);
}
async function setTuning(c, obj) {
  const sets = Object.entries(obj).map(([k, v]) => `t.${k}=${v};`).join("");
  return ev(c, `(()=>{const t=window.__sf.FLOWER_TUNING.values;${sets}window.__sf.wildlands.flowers.refresh();const s=window.__sf.wildlands.flowers.stats;return{density:t.density,clumpiness:t.clumpiness,clumpSize:t.clumpSize,reach:t.reach,count:s.count,heads:s.heads,submittedTriangles:s.submittedTriangles};})()`);
}
async function measure(c) {
  return ev(c, `(async()=>{const sf=window.__sf,r=sf.renderer,dev=r.backend&&r.backend.device;
    const sync=async()=>{if(dev?.queue?.onSubmittedWorkDone)await dev.queue.onSubmittedWorkDone();};
    for(let i=0;i<5;i++){sf.tick(1/60);await sync();}
    const samples=[];for(let i=0;i<18;i++){const t=performance.now();sf.tick(1/60);await sync();samples.push(performance.now()-t);}
    samples.sort((a,b)=>a-b);return{p50:+samples[samples.length>>1].toFixed(2),calls:r.info.render.calls??0};})()`);
}
async function shoot(c, name) {
  const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88, fromSurface: true });
  writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(shot.data, "base64"));
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
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart=1&fullfps=1&profile=1`
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

  console.log("[probe] waiting for base world...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.map&&window.__sf.player&&window.__sf.tick&&window.__sf.worldArrival?.snapshot?.state==='idle'&&window.__sf.renderIdle?.())`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("base world never ready (see [page-exception]/[page-error] above)");
  console.log(`[probe] base world ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // Wildlands is intentionally lazy at the Ocean Beach boot. Move into the
  // first meadow before waiting on the optional owner, then tick its approach
  // gate until the flowers/grass module activates.
  const [, activationX, activationZ, activationFacing] = VIEWS[0];
  await teleport(c, activationX, activationZ, activationFacing);
  const activationStarted = Date.now();
  ready = false;
  while (Date.now() - activationStarted < 180000) {
    try {
      await tick(c, 1 / 60);
      if (await ev(c, `!!(window.__sf.wildlands&&window.__sf.wildlands.flowers&&window.__sf.wildlands.grass)`)) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(300);
  }
  if (!ready) throw new Error("lazy Wildlands owner never activated");
  console.log(`[probe] Wildlands activated in ${((Date.now() - activationStarted) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`); // freeze wall clock
  await settle(c, 12);

  const summary = [];
  for (const [name, x, z, facing, back, up] of VIEWS) {
    try {
      await teleport(c, x, z, facing);
      await settle(c, 12);
      await freeCam(c, x, z, facing, back, up);
      for (let i = 0; i < 16; i++) await tick(c, 1 / 60); // ring re-scatters + wind rolls
      const st = await flowerStats(c);
      await shoot(c, name);
      const on = await measure(c);
      await ev(c, `window.__sf.wildlands.flowers.group.visible=false`);
      const off = await measure(c);
      await ev(c, `window.__sf.wildlands.flowers.group.visible=true`);
      const perf = { frameOnP50: on.p50, frameOffP50: off.p50, flowerP50: +(on.p50 - off.p50).toFixed(2), callsOn: on.calls, callsOff: off.calls };
      console.log(`[flowers] ${name}`, JSON.stringify(st));
      console.log(`[perf] ${name}`, JSON.stringify(perf));
      summary.push({ view: name, ...st, ...perf });
    } catch (e) {
      console.log(`[view-fail] ${name}: ${String(e).slice(0, 160)}`);
    }
  }

  // Tunable A/B at the first meadow: density low/high, then clump vs scatter.
  try {
    const [, x, z, facing, back, up] = VIEWS[0];
    await teleport(c, x, z, facing); await settle(c, 8); await freeCam(c, x, z, facing, back, up);
    for (const [label, obj] of [
      ["density_sparse", { density: 0.3, clumpiness: 0.6 }],
      ["density_carpet", { density: 2.2, clumpiness: 0.6 }],
      ["even_scatter", { density: 1.0, clumpiness: 0.0 }],
      ["tight_clumps", { density: 1.0, clumpiness: 1.0, clumpSize: 6 }]
    ]) {
      const r = await setTuning(c, obj);
      for (let i = 0; i < 6; i++) await tick(c, 1 / 60);
      console.log(`[tune] ${label}`, JSON.stringify(r));
      summary.push({ view: `${VIEWS[0][0]}_${label}`, ...r });
      await shoot(c, `tune_${label}`);
    }
    await setTuning(c, { density: 1.0, clumpiness: 0.6, clumpSize: 9 }); // restore
  } catch (e) {
    console.log(`[tune-fail] ${String(e).slice(0, 160)}`);
  }

  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`[probe] screenshots + summary.json in ${OUT}`);
  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
