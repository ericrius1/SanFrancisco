// Footprints-in-the-sand capture + budget probe.
//
// Launches headless Chrome with WebGPU, drives __sf.tick() by hand (the MCP
// preview pane rAF-deadlocks this app), walks the player up Ocean Beach so the
// stride leaves a trail, and captures it at a raking sun. Also reports what the
// pool costs: draw calls, live instances, and frame CPU with the prints in the
// scene vs. torn down.
//
//   SF_PROBE_URL=http://localhost:5240 node tools/sand-prints-shot.mjs
//
// Env: SF_TIME (default 17.4 = low sun), SF_SHOT_OUT (default .data/sand-prints)

import { spawn } from "node:child_process";
import { constants as fsConstants, mkdirSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_SHOT_OUT ?? ".data/sand-prints");
const URL_BASE = process.env.SF_PROBE_URL?.trim() || "http://localhost:5240";
const WIDTH = Number(process.env.SF_SHOT_WIDTH ?? 1600);
const HEIGHT = Number(process.env.SF_SHOT_HEIGHT ?? 900);
const TIME_OF_DAY = Number(process.env.SF_TIME ?? 17.4);
// The kite beach. The encounter's own site resolver walks east from here for
// the waterline; the probe does the same to find dry sand.
const BEACH = { x: -6160, z: 1650 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function executable(cands) {
  for (const c of cands.filter(Boolean)) {
    if (c.includes(path.sep)) { try { await access(c, fsConstants.X_OK); return c; } catch { continue; } }
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue; const full = path.join(dir, c);
      try { await access(full, fsConstants.X_OK); return full; } catch { /* keep looking */ }
    }
  }
  return null;
}
const findChrome = () => executable([
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome", "chromium"
]);
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => res(a.port)); });
  });
}
async function waitForCdp(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch { /* poll */ }
    await sleep(200);
  }
  throw new Error("CDP endpoint never opened");
}

class Cdp {
  #ws; #id = 1; #pending = new Map(); #listeners = new Map();
  constructor(url) { this.#ws = new WebSocket(url); }
  async open() {
    await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); });
    this.#ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data.toString());
      if (m.id) { const p = this.#pending.get(m.id); if (!p) return; this.#pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result ?? {}); return; }
      for (const l of this.#listeners.get(m.method) ?? []) l(m.params ?? {});
    });
  }
  on(method, l) { const a = this.#listeners.get(method) ?? []; a.push(l); this.#listeners.set(method, a); }
  send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#pending.set(id, { resolve: res, reject: rej })); }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function waitEval(cdp, expr, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { if (await evaluate(cdp, expr)) return; } catch { /* ctx swap */ } await sleep(350); }
  throw new Error(`timeout waiting for ${label}`);
}
const tick = (cdp, dt) => evaluate(cdp, `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`);
async function settle(cdp, frames, dt = 1 / 30, gapMs = 12) { for (let i = 0; i < frames; i++) { await tick(cdp, dt); if (gapMs) await sleep(gapMs); } }

async function setCamera(cdp, eye, target) {
  await evaluate(cdp, `(()=>{const s=window.__sf,c=s.camera;window.__shotCam={eye:[${eye}],target:[${target}]};
    if(!window.__shotPatched){window.__shotPatched=true;s.chase.update=()=>{const p=window.__shotCam;c.position.set(...p.eye);c.up.set(0,1,0);c.lookAt(...p.target);c.updateMatrixWorld();};}
    c.position.set(${eye});c.up.set(0,1,0);c.lookAt(${target});c.updateMatrixWorld();return true;})()`);
}
async function capture(cdp, name) {
  // One more presented frame between the camera move and the grab: a loaded
  // machine will otherwise hand back the previous surface.
  await tick(cdp, 1 / 60);
  await sleep(120);
  const r = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const buf = Buffer.from(r.data, "base64");
  writeFileSync(path.join(OUT, `${name}.png`), buf);
  console.log(`[prints] ${name}.png (${Math.round(buf.length / 1024)} KiB)`);
}

/** Median-ish frame CPU over `n` manual ticks. */
const frameCost = (cdp, n = 90) => evaluate(cdp, `(async()=>{const s=window.__sf,v=[];for(let i=0;i<${n};i++){const t=performance.now();s.tick(1/60);v.push(performance.now()-t);await new Promise(r=>requestAnimationFrame(r));}v.sort((a,b)=>a-b);const info=s.renderer.info;return {avg:+(v.reduce((x,y)=>x+y,0)/v.length).toFixed(3),p95:+v[Math.floor(v.length*0.95)].toFixed(3),calls:info.render.calls,tris:info.render.triangles};})()`);

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = await findChrome();
  if (!chrome) throw new Error("no chrome");
  const debugPort = await freePort();
  const profile = path.join(tmpdir(), `sf-sand-prints-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  const proc = spawn(chrome, [
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--headless=new",
    "--no-first-run", "--no-default-browser-check", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--enable-gpu", "--use-angle=metal",
    `--window-size=${WIDTH},${HEIGHT}`, "--force-device-scale-factor=1", "about:blank"
  ], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
  proc.stderr.on("data", () => {});

  await waitForCdp(debugPort);
  const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    const d = exceptionDetails;
    const where = d?.url ? `${d.url}:${d.lineNumber}:${d.columnNumber}` : "";
    console.log(`[prints] EXCEPTION: ${(d?.exception?.description || d?.text || "").split("\n").slice(0, 4).join(" | ")} @ ${where}`);
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

  const boot = new URL(URL_BASE);
  boot.searchParams.set("autostart", "1");
  boot.searchParams.set("fullfps", "1");
  boot.searchParams.set("profile", "1");
  boot.searchParams.set("j", `${BEACH.x},40,${BEACH.z},0,walk`);
  console.log(`[prints] navigating ${boot}`);
  await cdp.send("Page.navigate", { url: boot.toString() });

  await waitEval(cdp, "Boolean(window.__sf?.player && window.__sf?.sandPrints && window.__sf?.renderIdle && window.__sfManual)", 180000, "__sf");
  // Best-effort: on a loaded machine the beach can keep streaming past any
  // deadline, and the prints do not depend on the rest of the world settling.
  await waitEval(cdp, "window.__sf.renderIdle()", 90000, "renderIdle")
    .catch(() => console.log("[prints] renderIdle never went quiet — capturing anyway"));
  await evaluate(cdp, `window.__sfManual(true);const sky=window.__sf.sky;sky.cycleEnabled=false;sky.setTimeOfDay(${TIME_OF_DAY});document.body.classList.add('started');true`);

  // Find dry sand: walk east from the ocean until the surface class is sand and
  // the ground is clear of the swash, then stand a few metres further up.
  const spot = await evaluate(cdp, `(()=>{const m=window.__sf.map;for(let x=${BEACH.x - 120};x<${BEACH.x + 260};x+=2){if(m.surfaceType(x,${BEACH.z})===2&&m.groundTop(x,${BEACH.z})>1.8){return {x:x+6,z:${BEACH.z},y:m.groundTop(x+6,${BEACH.z})};}}return null;})()`);
  if (!spot) throw new Error("no dry sand found on the kite beach");
  console.log(`[prints] dry sand at ${JSON.stringify(spot)}`);

  // Face north up the beach and walk. Stride phase, not a timer, mints prints.
  await evaluate(cdp, `(()=>{const s=window.__sf,p=s.player;p.teleportTo({x:${spot.x},y:${spot.y + 1.5},z:${spot.z - 14},facing:0,mode:'walk'});return true;})()`);
  await settle(cdp, 30, 1 / 30, 14);
  const before = await evaluate(cdp, "JSON.stringify(window.__sf.sandPrints.debugState)");
  console.log(`[prints] before walking: ${before}`);

  await evaluate(cdp, "(()=>{const s=window.__sf;s.input.suspended=false;s.input.keys.add('KeyW');return true;})()");
  await settle(cdp, 96, 1 / 30, 10);
  await evaluate(cdp, "(()=>{window.__sf.input.keys.delete('KeyW');return true;})()");
  await settle(cdp, 20, 1 / 30, 10);

  const walked = await evaluate(cdp, "(()=>{const s=window.__sf;return {print:s.sandPrints.debugState,pos:[+s.player.position.x.toFixed(1),+s.player.position.z.toFixed(1)],mode:s.player.mode};})()");
  console.log(`[prints] after walking: ${JSON.stringify(walked)}`);

  // Frame the trail from behind and low, where a footprint reads.
  const p = walked.pos;
  const groundY = await evaluate(cdp, `window.__sf.map.groundTop(${p[0]},${p[1]})`);
  await setCamera(cdp, [p[0] + 3.0, groundY + 2.2, p[1] - 6.0], [p[0], groundY + 0.25, p[1] + 3.0]);
  await settle(cdp, 24, 1 / 30, 14);
  await capture(cdp, "trail");

  await setCamera(cdp, [p[0] + 1.1, groundY + 1.0, p[1] - 2.2], [p[0] + 0.1, groundY, p[1] + 2.0]);
  await settle(cdp, 16, 1 / 30, 14);
  await capture(cdp, "trail-close");

  // Kite runners: the encounter is resident at this range, so its flyers should
  // be adding their own prints out on the sand.
  const kite = await evaluate(cdp, "(async()=>{const sf=window.__sf;await sf.ensureOceanBeachKite();const k=sf.oceanBeachKite;if(!k)return null;const s=k.debugState();return {flyers:s.flyers.length,runner0:s.flyers[0]?.runner};})()");
  console.log(`[prints] kite encounter: ${JSON.stringify(kite)}`);
  if (kite) {
    const r = kite.runner0;
    await setCamera(cdp, [r[0] + 9, r[1] + 4.2, r[2] + 11], [r[0], r[1] - 0.6, r[2]]);
    await settle(cdp, 60, 1 / 30, 12);
    await capture(cdp, "kite-runners");
  }

  if (process.env.SF_SKIP_BUDGET) {
    console.log(`[prints] done → ${OUT}`);
    try { process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ }
    return;
  }

  // Budget: a WORST-CASE pool, drawn vs. hidden, alternating which goes first.
  // Fill every slot with prints spread over the sand in front of a fixed camera
  // — far more than any real beach — then measure. Alternating the order cancels
  // the drift from whatever else is still streaming in.
  await evaluate(cdp, `(()=>{const s=window.__sf,sp=s.sandPrints,p=s.player.renderPosition;
    for(let i=0;i<1200;i++){const a=i*0.61,r=0.6+ (i%140)*0.19;
      sp.stamp(p.x+Math.cos(a)*r, p.z+Math.sin(a)*r, Math.cos(a*1.7), Math.sin(a*1.7), i%2, 1);}
    return sp.debugState;})()`);
  const stress = await evaluate(cdp, `(()=>{const s=window.__sf,p=s.player.renderPosition,g=s.map.groundTop(p.x,p.z);
    return [p.x,g,p.z];})()`);
  await setCamera(cdp, [stress[0] + 6, stress[1] + 4.5, stress[2] + 9], [stress[0], stress[1], stress[2]]);
  await settle(cdp, 20, 1 / 60, 8);
  const live = await evaluate(cdp, "JSON.stringify(window.__sf.sandPrints.debugState)");
  const show = (on) => evaluate(cdp, `(()=>{const m=window.__sf.scene.children.find(o=>o.name==='sand_prints');m.visible=${on};return m.visible;})()`);
  const on = [];
  const off = [];
  for (let round = 0; round < 2; round++) {
    const order = round === 0 ? [false, true] : [true, false];
    for (const state of order) {
      await show(state);
      await settle(cdp, 5, 1 / 60, 4);
      (state ? on : off).push(await frameCost(cdp, 45));
    }
  }
  await show(true);
  const mean = (rows, key) => +(rows.reduce((s, r) => s + r[key], 0) / rows.length).toFixed(3);
  const budget = {
    live: JSON.parse(live),
    drawn: { avg: mean(on, "avg"), p95: mean(on, "p95"), calls: on[0].calls },
    hidden: { avg: mean(off, "avg"), p95: mean(off, "p95"), calls: off[0].calls },
    deltaMs: +(mean(on, "avg") - mean(off, "avg")).toFixed(3),
    rounds: { on, off }
  };
  writeFileSync(path.join(OUT, "budget.json"), JSON.stringify(budget, null, 2));
  console.log(`[prints] budget ${JSON.stringify(budget)}`);

  console.log(`[prints] done → ${OUT}`);
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ }
}
main().catch((e) => { console.error("[prints] FAIL", e); process.exitCode = 1; });
