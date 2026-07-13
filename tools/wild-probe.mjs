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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tree-heavy reference sites for both runtimes. Buena Vista uses a fixed
// eye/target pair because the feature under test is its isolated 1050m tier as
// seen from Corona Heights, not a close view from inside the grove.
const ALL_VIEWS = [
  { name: "sfbg_redwood", x: -2500, z: 2310, facing: 2.4, back: 18, up: 4 },
  { name: "ggpark_redwood", x: -4600, z: 2080, facing: 1.2, back: 18, up: 4 },
  { name: "marin_dense_redwood", x: -5300, z: -6200, facing: 0.3, back: 24, up: 6 },
  { name: "sutro_cloud_forest", x: -782, z: 3846, facing: 2.5, back: 24, up: 7 },
  { name: "tea_garden", x: -2280, z: 2185, facing: 1.88, back: 18, up: 5 },
  { name: "buena_from_corona", x: 408, z: 2760, eyeUp: 12, target: [212, 2450, 18] }
];
const requestedViews = new Set((process.env.SF_PROBE_VIEWS ?? "").split(",").map((v) => v.trim()).filter(Boolean));
const VIEWS = requestedViews.size > 0 ? ALL_VIEWS.filter(({ name }) => requestedViews.has(name)) : ALL_VIEWS;
const TEA_ONLY = requestedViews.size === 1 && requestedViews.has("tea_garden");
const W = TEA_ONLY ? 960 : 1280;
const H = TEA_ONLY ? 540 : 720; // tea boot also grows the neighbouring botanical garden; keep headless GPU pressure low
if (requestedViews.size > 0 && VIEWS.length === 0) {
  throw new Error(`SF_PROBE_VIEWS matched no views. Known: ${ALL_VIEWS.map(({ name }) => name).join(", ")}`);
}

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

async function measure(c) {
  // Real frame wall-time: tick then block on the GPU queue draining, averaged.
  // Also read deterministic geometry cost (draw calls + triangles). info.render
  // uses `.calls` (not drawCalls).
  const s = await ev(c, `(async()=>{
    const r=window.__sf.renderer, dev=r.backend&&r.backend.device;
    const sync=async()=>{ if(dev&&dev.queue&&dev.queue.onSubmittedWorkDone) await dev.queue.onSubmittedWorkDone(); };
    for(let i=0;i<6;i++){r.tick?r.tick(1/60):window.__sf.tick(1/60);await sync();}
    let sum=0;const N=24;
    for(let i=0;i<N;i++){const t=performance.now();window.__sf.tick(1/60);await sync();sum+=performance.now()-t;}
    const inf=r.info.render;
    // WebGPURenderer currently reports the useful count in calls; some builds
    // expose a present-but-zero drawCalls, so prefer calls when available.
    return{ms:sum/N,calls:inf.calls??inf.drawCalls??0,tris:inf.triangles??0};
  })()`);
  return s;
}
async function setWild(c, on) {
  await ev(c, `(()=>{for(const g of window.__sf.wildlands.groups)g.visible=${on};return true;})()`);
}
async function setGarden(c, on) {
  await ev(c, `(()=>{const sf=window.__sf,p=sf.player.renderPosition??sf.player.position;sf.garden.setVisible(${on},p);return true;})()`);
}
async function teleport(c, x, z, facing) {
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:${facing},mode:'walk'});return true;})()`);
}
// Oblique view with both eye and target grounded independently. This matters on
// the steep Marin/Sutro sites where using target ground for the eye can bury it.
async function freeCamAt(c, x, z, facing, back, eyeUp, targetUp = 8) {
  await ev(c, `(()=>{const m=window.__sf.map;
    const dx=Math.sin(${facing}),dz=Math.cos(${facing});
    const ex=${x}-dx*${back},ez=${z}-dz*${back};
    window.__sfFreeCam([ex,m.groundHeight(ex,ez)+${eyeUp},ez],[${x},m.groundHeight(${x},${z})+${targetUp},${z}]);return true;})()`);
}
async function freeCamBetween(c, ex, ez, eyeUp, tx, tz, targetUp) {
  await ev(c, `(()=>{const m=window.__sf.map;window.__sfFreeCam(
    [${ex},m.groundHeight(${ex},${ez})+${eyeUp},${ez}],
    [${tx},m.groundHeight(${tx},${tz})+${targetUp},${tz}]);return true;})()`);
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
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`,
    `${SERVER_URL}/?autostart=1&profile=1&fullfps=1${TEA_ONLY ? "&spawn=teaGardenPagoda" : ""}`
  ], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);
  // find the app page target (not about:blank / devtools) once it's navigated in
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
  const runtimeErrors = [];
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const message = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      runtimeErrors.push(String(message));
      console.log("[page-exception]", message);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const message = m.params.args.map((a) => a.value || a.description || "").join(" ");
      runtimeErrors.push(message);
      console.log("[page-error]", message.slice(0, 300));
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, TEA_ONLY
    ? `!!(window.__sf&&window.__sf.japaneseTeaGarden&&window.__sf.player)`
    : `!!(window.__sf&&window.__sf.garden&&window.__sf.wildlands&&window.__sf.japaneseTeaGarden&&window.__sf.player)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready (see [page-exception]/[page-error] above)");
  const modulesReadyMs = Date.now() - t0;
  console.log(`[probe] modules ready in ${(modulesReadyMs / 1000).toFixed(1)}s; waiting for tree templates/chunks...`);
  const treesReadyAt = Date.now();
  const readyStats = await ev(c, TEA_ONLY ? `(async()=>{
    const sf=window.__sf;
    if(sf.garden)sf.garden.setVisible(false,sf.player.renderPosition??sf.player.position);
    if(sf.wildlands)for(const group of sf.wildlands.groups)group.visible=false;
    await sf.japaneseTeaGarden.ready;
    return {teaGarden:sf.japaneseTeaGarden.stats};
  })()` : `(async()=>{
    const sf=window.__sf;
    await Promise.all([sf.garden.ready,sf.wildlands.ready,sf.japaneseTeaGarden.ready]);
    return {garden:sf.garden.stats,wildlands:sf.wildlands.stats,teaGarden:sf.japaneseTeaGarden.stats};
  })()`);
  const treesReadyMs = Date.now() - treesReadyAt;
  console.log(`[probe] trees ready in ${(treesReadyMs / 1000).toFixed(1)}s`, JSON.stringify(readyStats));
  await ev(c, `window.__sfManual&&window.__sfManual(true)`); // freeze wall clock
  if (TEA_ONLY) {
    await ev(c, `(()=>{const sky=window.__sf.sky;sky.cycleEnabled=false;sky.setTimeOfDay(13.5);return true;})()`);
  }
  await settle(c, 18); // let deferred compilation + first texture uploads settle

  const results = [];
  let fails = 0;
  for (const view of VIEWS) {
    const { name, x, z } = view;
    try {
      await teleport(c, x, z, view.facing ?? 0); // stream this area's tiles/colliders
      await settle(c, 14); // stream tiles + grow species heroes
      if (view.target) {
        await freeCamBetween(c, x, z, view.eyeUp, view.target[0], view.target[1], view.target[2]);
      } else {
        await freeCamAt(c, x, z, view.facing, view.back, view.up);
      }
      for (let i = 0; i < 6; i++) await tick(c, 1 / 60);
      // let the rebin run a few real frames from this eye, then read near-clone count
      for (let i = 0; i < 20; i++) { await tick(c, 1 / 60); await sleep(30); }
      const diag = name === "tea_garden" ? {} : await ev(c, `(()=>{const w=window.__sf.wildlands;const read=(s)=>({nearActive:s.nearActive(),instances:s.instances,chunks:s.chunks,designs:s.designs});return{main:read(w.trees.stats),buenaVista:read(w.buenaVistaTrees.stats)};})()`);
      console.log(`[diag] ${name}`, JSON.stringify(diag));
      const gdiag = name === "tea_garden" ? {} : await ev(c, `(()=>{const g=window.__sf.wildlands.grass.group;const m=g.children.find(o=>o.isInstancedMesh);if(!m)return{grass:'none'};const a=m.instanceMatrix.array;let n=m.count,lo=1e9,hi=-1e9;for(let i=0;i<n;i++){const y=a[i*16+13];if(y<lo)lo=y;if(y>hi)hi=y;}const cam=window.__sf.camera.position;const gh=window.__sf.map.groundHeight(cam.x,cam.z);return{count:n,yLo:+lo.toFixed(1),yHi:+hi.toFixed(1),camGround:+gh.toFixed(1),camY:+cam.y.toFixed(1)};})()`);
      console.log(`[grass] ${name}`, JSON.stringify(gdiag));
      if (name === "tea_garden") {
        const tea = await ev(c, `(()=>{
          const scene=window.__sf.scene;
          const roots=['japanese_tea_garden_trees','japanese_tea_garden_shrubs','japanese_tea_garden_grass'];
          const found=Object.fromEntries(roots.map(n=>[n,!!scene.getObjectByName(n)]));
          const legacyExact=['japanese_tea_garden_specimen_trees','japanese_tea_garden_azaleas','japanese_tea_garden_mt_fuji_hedge','japanese_tea_garden_hiroshima_descendant_ginkgoes','mt_fuji_clipped_hedge_mound','survivor_ginkgo_trunk','survivor_ginkgo_fan_crown'];
          const legacy=[];scene.traverse(o=>{if(legacyExact.includes(o.name)||/^tea_garden_.+_(branches|foliage)$/.test(o.name)||/^tea_garden_azalea_palette_/.test(o.name))legacy.push(o.name);});
          const live=scene.getObjectByName('japanese_tea_garden_live_plants');let meshObjects=0,instancedDraws=0,instances=0,submittedTriangles=0;
          live?.traverse(o=>{if(!o.isMesh)return;meshObjects++;const mult=o.isInstancedMesh?o.count:1;if(o.isInstancedMesh){instancedDraws++;instances+=o.count;}const g=o.geometry;submittedTriangles+=((g.index?.count??g.getAttribute('position')?.count??0)/3)*mult;});
          return{found,legacy,meshObjects,instancedDraws,instances,submittedTriangles:Math.round(submittedTriangles),siteStats:window.__sf.japaneseTeaGarden.stats};
        })()`);
        console.log(`[tea-garden] ${JSON.stringify(tea)}`);
        if(!Object.values(tea.found).every(Boolean))throw new Error(`missing shared Tea Garden roots: ${JSON.stringify(tea.found)}`);
        if(tea.legacy.length)throw new Error(`legacy Tea Garden foliage present: ${tea.legacy.join(', ')}`);
      }
      const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 88, fromSurface: true });
      writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(shot.data, "base64"));
      const all = await measure(c); // wildlands + garden on
      if (name === "tea_garden") {
        const row = { view: name, ms: +all.ms.toFixed(1), calls: all.calls, tris: all.tris };
        results.push(row);
        console.log(JSON.stringify(row));
        continue;
      }
      await setWild(c, false);
      const noWild = await measure(c);
      await setWild(c, true);
      await setGarden(c, false);
      const noGarden = await measure(c);
      await setGarden(c, true);
      const row = {
        view: name,
        msAll: +all.ms.toFixed(1),
        msWild: +(all.ms - noWild.ms).toFixed(1),
        msGarden: +(all.ms - noGarden.ms).toFixed(1),
        callsAll: all.calls,
        callsWild: all.calls - noWild.calls,
        callsGarden: all.calls - noGarden.calls,
        trisAll: all.tris,
        trisWild: all.tris - noWild.tris,
        trisGarden: all.tris - noGarden.tris,
        treeDiag: diag
      };
      results.push(row);
      console.log(JSON.stringify(row));
      fails = 0;
    } catch (e) {
      console.log(`[view-fail] ${name}: ${String(e).slice(0, 120)}`);
      if (++fails >= 2) { console.log("[probe] tab unstable, stopping views early"); break; }
    }
  }
  const stats = await ev(c, TEA_ONLY
    ? `({teaGarden:window.__sf.japaneseTeaGarden.stats})`
    : `({trees:window.__sf.wildlands.stats,garden:window.__sf.garden.stats,teaGarden:window.__sf.japaneseTeaGarden.stats})`);
  writeFileSync(path.join(OUT, "perf.json"), JSON.stringify({ modulesReadyMs, treesReadyMs, readyStats, results, stats }, null, 2));
  console.log("[probe] stats", JSON.stringify(stats));
  console.log(`[probe] screenshots + perf.json in ${OUT}`);
  const gpuErrors = runtimeErrors.filter((message) => /WebGPU|GPUValidation|render pipeline|vertex buffer count/i.test(message));
  c.close(); proc.kill(); if (dev) dev.kill();
  if (gpuErrors.length) throw new Error(`WebGPU validation/runtime errors: ${gpuErrors.join(" | ").slice(0, 800)}`);
  process.exit(0);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
