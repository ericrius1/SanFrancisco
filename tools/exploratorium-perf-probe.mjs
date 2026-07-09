// Headless ground-truth for Exploratorium locality gating + its perf cost.
//
// Boots the real app (WebGPU via ANGLE-metal), freezes the wall clock, drives
// __sf.tick() manually, and parks the player at a ladder of positions relative
// to the Pier 15 museum. At each stop it reads exploratorium.state() (compute
// DISPATCH counts per exhibit — hard proof of room gating), inspects the museum
// group's visibility + how many sim sprites are actually drawn, and times a
// batch of GPU-synced frames (queue.onSubmittedWorkDone) to get a per-frame ms.
//
// The delta between "standing in the water room" (48k SPH + ripple pool live)
// and "same building, exhibits idle" (lobby) isolates the exhibit GPU cost; the
// delta vs "museum not even built" (far away) is the whole-museum cost.
//
//   node tools/exploratorium-perf-probe.mjs
// Env: SF_PROBE_OUT (default .data/explo-perf), SF_PROBE_URL, CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/explo-perf");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5195"; // fresh port (human dev = 5179)
const W = 900, H = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pier-frame constants, straight from exploratorium.ts (must stay in sync)
const CX = 4084.7, CZ = -1271.5, YAW = -2.523, FLOOR = 3.78;
const COS = Math.cos(YAW), SIN = Math.sin(YAW);
const pierWorld = (u, v) => ({ x: CX + u * COS + v * SIN, z: CZ - u * SIN + v * COS });

// Test stops: pier-local (u,v). d = exterior distance from the OBB (HL=125.6, HW=31.4)
const STOPS = [
  { name: "WATER room  (SPH 48k + pool live)", u: -20, v: -21.7, expect: "water" },
  { name: "GALLERY room(sand 5k + stars 14k)", u: 50, v: -8, expect: "gallery" },
  { name: "DOME theater(sky shader clock on)", u: -72, v: 0, expect: "dome" },
  { name: "LOBBY inside(exhibits idle)      ", u: 108, v: 0, expect: "lobby" },
  { name: "NEAR outside(~40m, group shown)  ", u: 165.6, v: 0, expect: "none" },
  { name: "MIDBAND     (~200m, shell drawn) ", u: 325.6, v: 0, expect: "none" },
  { name: "FAR (world origin, not built)    ", world: { x: 0, z: 0 }, expect: "none" }
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
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
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

  console.log("[probe] waiting for __sf.exploratorium...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.exploratorium&&window.__sf.player&&window.__sf.renderer.backend.device)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf.exploratorium never ready (see [page-*] above)");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  await ev(c, `window.__sfManual&&window.__sfManual(true)`); // freeze wall clock + stop the rAF loop; we drive tick() by hand

  // Helper installed in-page: locate the museum group (matches the pier origin),
  // report visibility + how many sim sprites are actually drawn.
  await ev(c, `window.__explo = {
    grp(){
      let g=null; window.__sf.scene.traverse(o=>{ if(!g && o.isGroup && Math.abs(o.position.x-${CX})<1 && Math.abs(o.position.z-(${CZ}))<1) g=o; });
      return g;
    },
    vis(){
      const g=this.grp(); if(!g) return { built:false };
      let sprites=0, spritesVis=0, meshes=0, meshesVis=0;
      g.traverse(o=>{ if(o.isSprite){sprites++; if(o.visible)spritesVis++;} else if(o.isMesh){meshes++; if(o.visible)meshesVis++;} });
      return { built:true, groupVisible:g.visible, sprites, spritesVis, meshes, meshesVis };
    }
  }; true`);

  // A GPU-synced frame timer: run N ticks, each followed by a queue fence, and
  // return the median per-frame ms. Captures BOTH the renderer's work and the
  // FluidSim's own direct queue.submit (its compute lives outside the RenderPipeline).
  const timeExpr = (n, dt) => `(async()=>{
    const dev=window.__sf.renderer.backend.device; const ts=[];
    for(let i=0;i<${n};i++){ const a=performance.now(); window.__sf.tick(${dt}); await dev.queue.onSubmittedWorkDone(); ts.push(performance.now()-a); }
    ts.sort((x,y)=>x-y);
    const med=ts[ts.length>>1], mean=ts.reduce((s,x)=>s+x,0)/ts.length, p90=ts[Math.floor(ts.length*0.9)];
    return { med:+med.toFixed(3), mean:+mean.toFixed(3), p90:+p90.toFixed(3) };
  })()`;

  const rows = [];
  for (const stop of STOPS) {
    const w = stop.world ?? pierWorld(stop.u, stop.v);
    const y = FLOOR + 1.2;
    // teleport (walk mode) to the stop
    await ev(c, `(()=>{const p=window.__sf.player;const gy=window.__sf.map.groundHeight(${w.x},${w.z});const yy=${stop.world? "gy+1.6" : y};p.teleportTo({x:${w.x},y:yy,z:${w.z},facing:0,mode:'walk'});return true;})()`);
    // settle: stand up, enter the room, lazily build + activate that room's sims (first entry allocates SPH buffers/pipelines — warm it before timing)
    for (let i = 0; i < 90; i++) { await ev(c, `window.__sf.tick(${1 / 60})`); }

    const state = await ev(c, `window.__sf.exploratorium.state()`);
    const vis = await ev(c, `window.__explo.vis()`);
    // baseline dispatch snapshot, then run a fixed window and measure the delta
    const before = await ev(c, `(()=>{const s=window.__sf.exploratorium.state().dispatches;return {sand:s.sand,stars:s.stars,sph:s.sph,pool:s.pool};})()`);
    const perf = await ev(c, timeExpr(60, 1 / 60));
    const after = await ev(c, `(()=>{const s=window.__sf.exploratorium.state().dispatches;return {sand:s.sand,stars:s.stars,sph:s.sph,pool:s.pool};})()`);
    const dd = { sand: after.sand - before.sand, stars: after.stars - before.stars, sph: after.sph - before.sph, pool: after.pool - before.pool };
    const totalDisp = dd.sand + dd.stars + dd.sph + dd.pool;

    rows.push({ name: stop.name, expect: stop.expect, room: state.room, inside: state.inside, built: state.built, colliders: state.colliders, vis, dispPer60: dd, totalDisp, perf });
    console.log(`\n=== ${stop.name} ===`);
    console.log(`  room=${state.room} inside=${state.inside} built=${state.built} colliders=${state.colliders}`);
    console.log(`  group: ${vis.built ? `visible=${vis.groupVisible} spritesDrawn=${vis.spritesVis}/${vis.sprites} meshesDrawn=${vis.meshesVis}/${vis.meshes}` : "NOT BUILT"}`);
    console.log(`  compute dispatches over 60 frames: sand=${dd.sand} stars=${dd.stars} sph=${dd.sph} pool=${dd.pool}  (total ${totalDisp})`);
    console.log(`  frame ms (GPU-synced): median=${perf.med} mean=${perf.mean} p90=${perf.p90}`);
  }

  // Deltas
  const byName = (frag) => rows.find((r) => r.name.includes(frag));
  const water = byName("WATER"), gallery = byName("GALLERY"), dome = byName("DOME"), lobby = byName("LOBBY"), far = byName("FAR"), mid = byName("MIDBAND");
  const d = (a, b) => (a && b ? +(a.perf.med - b.perf.med).toFixed(3) : null);
  const summary = {
    water_vs_lobby: d(water, lobby),   // exhibit GPU cost, same building/view
    gallery_vs_lobby: d(gallery, lobby),
    dome_vs_lobby: d(dome, lobby),
    water_vs_far: d(water, far),       // whole-museum cost vs not-built
    lobby_vs_far: d(lobby, far),       // static shell/dome draw, no exhibits
    mid_vs_far: d(mid, far)
  };

  console.log("\n\n========================= SUMMARY =========================");
  console.log("Per-frame median ms (GPU-synced), by where the player stands:");
  for (const r of rows) console.log(`  ${r.name}  ${String(r.perf.med).padStart(7)} ms   compute/60f=${String(r.totalDisp).padStart(5)}   spritesDrawn=${r.vis.built ? r.vis.spritesVis : "-"}`);
  console.log("\nDeltas (median ms):");
  console.log(`  WATER room  − LOBBY (idle, same bldg) = ${summary.water_vs_lobby} ms   <- cost of the live SPH tank + ripple pool`);
  console.log(`  GALLERY     − LOBBY                   = ${summary.gallery_vs_lobby} ms   <- cost of live sand + star table`);
  console.log(`  DOME        − LOBBY                   = ${summary.dome_vs_lobby} ms   <- cost of the animated sky shader`);
  console.log(`  WATER room  − FAR (not built)         = ${summary.water_vs_far} ms   <- whole museum, heaviest room`);
  console.log(`  LOBBY       − FAR                     = ${summary.lobby_vs_far} ms   <- static shell+dome drawn, exhibits OFF`);
  console.log(`  MIDBAND     − FAR                     = ${summary.mid_vs_far} ms   <- shell drawn @200m, zero exhibit logic`);

  // Verdict: gating correct if far/mid/lobby run ZERO exhibit compute, and each
  // room runs only its own sims, and sprites are hidden whenever not in-room.
  const zeroWhenAway = (far.totalDisp === 0) && (mid.totalDisp === 0) && (lobby.totalDisp === 0);
  const spritesHiddenAway = (mid.vis.built ? mid.vis.spritesVis === 0 : true) && (lobby.vis.spritesVis === 0);
  const waterOnlySph = water.dispPer60.sph > 0 && water.dispPer60.sand === 0 && water.dispPer60.stars === 0;
  const galleryOnlyGrain = gallery.dispPer60.sand > 0 && gallery.dispPer60.stars > 0 && gallery.dispPer60.sph === 0;
  const ok = zeroWhenAway && spritesHiddenAway && waterOnlySph && galleryOnlyGrain;

  console.log("\n[CHECKS]");
  console.log(`  exhibits run ZERO compute when not in their room (far/mid/lobby): ${zeroWhenAway}`);
  console.log(`  sim sprites hidden when not in-room (mid/lobby drawn=0):          ${spritesHiddenAway}`);
  console.log(`  water room dispatches ONLY the SPH+pool (no sand/stars):         ${waterOnlySph}`);
  console.log(`  gallery dispatches ONLY sand+stars (no SPH):                     ${galleryOnlyGrain}`);
  console.log(ok ? "\n[VERDICT] PASS — exhibits fully room-gated; compute + sprites off when away" : "\n[VERDICT] FAIL — see rows above");

  writeFileSync(path.join(OUT, "perf.json"), JSON.stringify({ rows, summary }, null, 2));
  console.log(`\n[probe] wrote ${path.join(OUT, "perf.json")}`);

  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(ok ? 0 : 2);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
