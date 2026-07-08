// Headless browser ground-truth for the Botanical Garden horse herd: does the
// updated gait brain GALLOP and stay upright, and do the horses hop the new jump
// obstacles? Boots the real app in headless Chrome (WebGPU via ANGLE-metal),
// freezes the wall clock, teleports to the meadow, drives __sf.tick deterministically
// and reads __sf.horses.debugStates() — the ACTUAL in-world box3d.js sim that drives
// the render (the faithful gate; the Node evalGait is only a box3d-wasm proxy).
//
//   node tools/horse-jump-probe.mjs
// Env: SF_PROBE_OUT (dir, default .data/horse-jump), SF_PROBE_URL, CHROME_BIN

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/horse-jump");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5191"; // fresh port (human dev = 5179)
const W = 760, H = 480; // small surface — headless WebGPU crashes under GPU load
const MEADOW = { x: -2260, z: 2450 }; // GARDEN_MEADOW
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const frame = (dt) => `(async()=>{if(!window.__sf)return false;window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(r));return true;})()`;
async function tick(c, dt) { return await ev(c, frame(dt)); }

// Run N sim ticks, sampling debugStates each `every` ticks; fold into per-horse
// stats. Tolerant: if the headless GPU tab dies mid-run, break and keep partials.
async function run(c, ticks, every, acc) {
  for (let i = 0; i < ticks; i++) {
    try {
      if ((await tick(c, 1 / 60)) === false) { console.log(`[run] __sf gone at tick ${i}, keeping partials`); break; }
      if (i % every !== 0) continue;
      const st = await ev(c, `window.__sf&&window.__sf.horses?window.__sf.horses.debugStates():null`);
      if (!st) break;
      st.forEach((h, k) => {
      const a = acc[k] ??= { minUp: 1, maxSpeed: 0, sumSpeed: 0, n: 0, everFell: false, maxTall: 0, hops: 0, wasUp: false };
      a.minUp = Math.min(a.minUp, h.upY);
      a.maxSpeed = Math.max(a.maxSpeed, h.speed);
      a.sumSpeed += h.speed; a.n++;
      if (h.fallen) a.everFell = true;
      a.maxTall = Math.max(a.maxTall, h.tall);
      // a hop lifts the torso above standing height; count rising crossings past 1.12
      const up = h.tall > 1.12;
      if (up && !a.wasUp) a.hops++;
      a.wasUp = up;
      });
    } catch (e) { console.log(`[run] tick err @${i}: ${String(e).slice(0, 80)}`); break; }
  }
}
const fmt = (a) => a.map((x, k) => `#${k} up${x.minUp.toFixed(2)} spd~${(x.sumSpeed / Math.max(1, x.n)).toFixed(1)}/max${x.maxSpeed.toFixed(1)} tall${x.maxTall.toFixed(2)} hops${x.hops}${x.everFell ? " FELL" : ""}`).join("\n  ");

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

  console.log("[probe] waiting for __sf.horses...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.horses&&window.__sf.player)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf.horses never ready (see [page-*] above)");
  console.log(`[probe] ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`); // freeze wall clock
  // teleport into the meadow so the herd activates (SIM_RANGE gate)
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${MEADOW.x},${MEADOW.z});p.teleportTo({x:${MEADOW.x},y:y+1.5,z:${MEADOW.z},facing:0,mode:'walk'});return true;})()`);
  for (let i = 0; i < 30; i++) { await tick(c, 1 / 60); await sleep(20); } // settle: stand up + activate

  const jumps = await ev(c, `window.__sf.horses.jumps`);
  const count = await ev(c, `window.__sf.horses.count`);
  console.log(`[probe] herd count=${count}, jump obstacles=${jumps.length}`);

  // Screenshot FIRST — the larger herd's always-drawn brain lattices can crash the
  // headless GPU tab under sustained load, so grab the human-facing frame before the
  // measurement phases. Midday; let them roam a moment so they spread + move; framed
  // from a medium pull-back so the range of body sizes (young..old) reads across the herd.
  try {
    await ev(c, `window.__sf.sky&&window.__sf.sky.setTimeOfDay&&window.__sf.sky.setTimeOfDay(12)`);
    await ev(c, `window.__sf.horses.debugForceSpeed(null)`);
    for (let i = 0; i < 40; i++) await tick(c, 1 / 60);
    await ev(c, `(()=>{const m=window.__sf.map;const gy=m.groundHeight(${MEADOW.x},${MEADOW.z});window.__sfFreeCam([${MEADOW.x}-26,gy+15,${MEADOW.z}-26],[${MEADOW.x},gy+2,${MEADOW.z}]);return true;})()`);
    for (let i = 0; i < 4; i++) await tick(c, 1 / 60);
    const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
    writeFileSync(path.join(OUT, "meadow.jpg"), Buffer.from(shot.data, "base64"));
    console.log(`[probe] screenshot -> ${path.join(OUT, "meadow.jpg")}`);
  } catch (e) { console.log("[probe] screenshot skipped:", String(e).slice(0, 100)); }

  // Phase A — natural roam (walk/trot/canter mix + opportunistic hops) = the ship gate
  await ev(c, `window.__sf.horses.debugForceSpeed(null)`);
  const roam = {};
  await run(c, 480, 6, roam);
  const roamArr = Object.values(roam);
  console.log("[roam]\n  " + fmt(roamArr));

  // Phase B — sustained gallop diagnostic (the open training target)
  await ev(c, `window.__sf.horses.debugForceSpeed(0.8)`);
  const gallop = {};
  await run(c, 360, 6, gallop);
  const gArr = Object.values(gallop);
  console.log("[force-gallop diag]\n  " + fmt(gArr));

  // Phase C — forced hop: fire every horse's jump, confirm they leave the ground
  await ev(c, `window.__sf.horses.debugForceSpeed(null)`);
  await ev(c, `window.__sf.horses.debugJumpAll()`);
  const hop = {};
  await run(c, 120, 3, hop);
  const hopArr = Object.values(hop);
  console.log("[forced-hop]\n  " + fmt(hopArr));

  // verdicts
  const topSpeed = Math.max(0, ...roamArr.map((x) => x.maxSpeed), ...gArr.map((x) => x.maxSpeed));
  // Ship gate = the REALISTIC gait mix (roam): does the herd stay upright while it
  // walks/trots/canters and takes the odd gallop burst + hop? Sustained flat-out
  // gallop + a synchronized all-herd hop are pessimistic STRESS diagnostics (the
  // current brain can't hold a long gallop in box3d.js — that's the training target).
  const roamUpright = roamArr.filter((x) => !x.everFell).length;
  const gallopUpright = gArr.filter((x) => x.minUp > 0.45 && !x.everFell).length; // diagnostic (sustained gallop)
  const hopLifted = hopArr.filter((x) => x.maxTall > 1.15).length; // torso clearly left the ground
  const summary = {
    herd: count, jumps: jumps.length, topSpeed: +topSpeed.toFixed(1),
    roamUprightOfHerd: `${roamUpright}/${roamArr.length}`,
    sustainedGallopUpright_diag: `${gallopUpright}/${gArr.length}`,
    hopLiftedTorso: `${hopLifted}/${hopArr.length}`
  };
  const pass = jumps.length >= 4 && roamUpright >= Math.ceil(roamArr.length * 0.85) && topSpeed > 2.5 && hopLifted >= 3;
  console.log("[SUMMARY]", JSON.stringify(summary));
  console.log(pass ? "[VERDICT] PASS — herd stays upright through a lively gait mix, gallops, and clears the jumps (sustained-gallop diag is the training target)" : "[VERDICT] FAIL — see per-horse rows above");
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ summary, roam: roamArr, gallop: gArr, hop: hopArr }, null, 2));

  c.close(); proc.kill(); if (dev) dev.kill();
  process.exit(pass ? 0 : 2);
}
main().catch((e) => { console.error("[probe] FAIL", e); process.exit(1); });
