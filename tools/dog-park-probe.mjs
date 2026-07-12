// Headless verification probe for the Corona Heights dog park overhaul. Boots
// the app in headless Chrome (WebGPU via ANGLE-metal), pins the clock, then:
//   A. samples ~25 simulated seconds of dog/owner/ball state near the park and
//      asserts locomotion caps, owner clearance, ball flight/roll/bounds and
//      the wood fence swap (no chain-link LineSegments left);
//   B. screenshots the fence, the whole run, a fetch pair and the gate sign.
// Any page exception or console.error during the whole run fails the probe.
//
//   node tools/dog-park-probe.mjs
// Env:
//   SF_PROBE_OUT  out dir (default .data/dog-park-probe)
//   SF_PROBE_URL  existing vite (default http://127.0.0.1:5191)
//   SF_TIME       time of day hours (default 13.5)

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/dog-park-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5191";
const TIME = Number(process.env.SF_TIME ?? 13.5);
const W = 1280, H = 720;
const DT = 1 / 30;
const SIM_SECONDS = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirror of src/world/coronaHeights/layout.ts CORONA_DOG_PARK (metres, +x east +z south).
const DOG_PARK = [
  [325.72, 2728.49], [330.12, 2729.44], [339.39, 2730.28], [358.81, 2718.47],
  [387.78, 2707.78], [401.72, 2705.57], [410.71, 2706.15], [405.81, 2695.76],
  [410.34, 2682.36], [408.82, 2678.87], [399.63, 2678.48], [386.37, 2682.08],
  [358.43, 2694.09], [341.07, 2707.59], [330.49, 2720.34]
];

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function distToPolygonEdge(x, z, polygon) {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, az] = polygon[i];
    const [bx, bz] = polygon[(i + 1) % polygon.length];
    const ex = bx - ax, ez = bz - az;
    const ll = ex * ex + ez * ez;
    const t = ll > 1e-9 ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / ll)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + ex * t), z - (az + ez * t)));
  }
  return best;
}

// screenshots: [name, x, z, facing(rad), backDist, upHeight] — freeCam pulls the
// eye `back` behind the target along facing (dx=sin f, dz=cos f).
const VIEWS = [
  // Standing just outside the sunlit south fence run, looking NE along the
  // panels so plank grain, posts and caps read at close range.
  ["fence_closeup", 376, 2711, 2.16, 12, 1.55],
  // Elevated overview from NW (downslope) with the whole dog run + hill behind.
  ["park_wide", 368, 2704, 0.822, 38, 22],
  // The ball owner's corner — shot is taken once the golden is back at heel.
  ["fetch_moment", 344, 2714, -0.91, 11.4, 1.8],
  // Gate + sign corner from inside the park, where the painted sign face and
  // the cross-braced gate leaf both point.
  ["gate_sign", 326.5, 2728, -0.83, 8, 1.7]
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
let ownedDev = null;
let chromeProc = null;
let activeCdp = null;
function cleanup() {
  try { activeCdp?.close(); } catch {}
  try { chromeProc?.kill(); } catch {}
  try { ownedDev?.kill(); } catch {}
  activeCdp = null;
  chromeProc = null;
  ownedDev = null;
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(0)); await sleep(60); } }
async function teleport(c, x, z, facing) {
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:${facing},mode:'walk'});return true;})()`);
}
async function freeCam(c, x, z, facing, back, up) {
  return ev(c, `(()=>{const m=window.__sf.map;const gy=m.groundHeight(${x},${z});
    const dx=Math.sin(${facing}),dz=Math.cos(${facing});
    const eye=[${x}-dx*${back}, gy+${up}, ${z}-dz*${back}];
    window.__sfFreeCam(eye,[${x}+dx*60, gy+${Math.max(4, up * 0.35)}, ${z}+dz*60]);return eye;})()`);
}
async function settleCamera(c, eye) {
  for (let i = 0; i < 180; i++) {
    await tick(c, 0);
    const p = await ev(c, `[window.__sf.camera.position.x,window.__sf.camera.position.y,window.__sf.camera.position.z]`);
    if (Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) < 0.05) return;
    await sleep(50);
  }
  throw new Error("free camera never acquired the render pose");
}
/** The deferred render warmup (pipeline.warmup) makes every tick early-return
 * for several REAL seconds once the streamed world settles — sim, camera and
 * cineHook all freeze. Use the park's own visibility gate as a heartbeat: the
 * live world update rewrites coronaHeights.group.visible every frame, so a
 * cleared flag that comes back true proves the full sim path ran. Needs the
 * camera already near the park. Sleeps let the async warmup actually finish. */
async function waitWorldLive(c, label) {
  for (let i = 0; i < 200; i++) {
    const live = await ev(c, `(()=>{
      const ch = window.__sf.coronaHeights;
      ch.group.visible = false;
      window.__sf.tick(${DT});
      return ch.group.visible;
    })()`);
    if (live) {
      if (i > 0) console.log(`[probe] world live for ${label} after ${(i * 0.3).toFixed(1)}s`);
      return;
    }
    await sleep(300);
  }
  throw new Error(`world never went live (${label}) — render warmup stuck?`);
}

/* ------------------------------------------------------ part A: behavior */

async function checkFence(c) {
  const r = await ev(c, `(()=>{
    const s = window.__sf.scene;
    const g = s.getObjectByName("corona_dog_park_fence");
    if (!g) return { found: false };
    let instanced = 0;
    const kids = g.children.map((k) => k.type + ":" + (k.name || "?"));
    for (const k of g.children) if (k.isInstancedMesh) instanced++;
    let chainlink = 0;
    s.traverse((o) => { if (o.isLineSegments && o.name === "corona_dog_park_chainlink") chainlink++; });
    return { found: true, instanced, kids, chainlink };
  })()`);
  console.log("[probe] fence check:", JSON.stringify(r));
  return r;
}

async function sampleBehavior(c) {
  const chunks = Math.round(SIM_SECONDS / DT / 30);
  const samples = [];
  let retries = 0;
  for (let i = 0; i < chunks; i++) {
    // heartbeat ticks bracket each chunk — a chunk that starts or ends with the
    // loop warmup-frozen is discarded and retried once the world is live again
    const part = await ev(c, `(()=>{
      const sf = window.__sf, ch = sf.coronaHeights;
      ch.group.visible = false;
      sf.tick(${DT});
      if (!ch.group.visible) return null;
      const ball = sf.scene.getObjectByName("corona_tennis_ball");
      const out = [];
      for (let k = 0; k < 30; k++) {
        sf.tick(${DT});
        out.push({
          dogs: ch.dogs.map((d) => ({ x: d.x, z: d.z, s: d.speed, sc: d.style.scale })),
          owners: ch.owners.map((o) => ({ x: o.rig.group.position.x, z: o.rig.group.position.z })),
          ball: {
            x: ball.position.x, y: ball.position.y, z: ball.position.z,
            g: sf.map.groundTop(ball.position.x, ball.position.z)
          }
        });
      }
      ch.group.visible = false;
      sf.tick(${DT});
      return ch.group.visible ? out : null;
    })()`);
    if (!part) {
      if (++retries > 6) throw new Error("behavior sampling kept hitting a frozen world");
      console.log(`\n[probe] chunk ${i} frozen (render warmup) — waiting for the world`);
      await waitWorldLive(c, `chunk ${i}`);
      i--;
      continue;
    }
    samples.push(...part);
    process.stdout.write(`\r[probe] simulated ${((i + 1) * 30 * DT).toFixed(0)}s / ${SIM_SECONDS}s`);
  }
  process.stdout.write("\n");
  return samples;
}

function runAssertions(samples, fence, audio, nature, pageErrors) {
  const results = [];
  const push = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} — ${detail}`);
  };

  const nDogs = samples[0].dogs.length;
  const maxSpeed = new Array(nDogs).fill(0);
  const travelled = new Array(nDogs).fill(0);
  for (let t = 0; t < samples.length; t++) {
    const s = samples[t];
    for (let i = 0; i < nDogs; i++) {
      maxSpeed[i] = Math.max(maxSpeed[i], s.dogs[i].s);
      if (t > 0) travelled[i] += Math.hypot(s.dogs[i].x - samples[t - 1].dogs[i].x, s.dogs[i].z - samples[t - 1].dogs[i].z);
    }
  }
  const overallMax = Math.max(...maxSpeed);
  const allMove = travelled.every((d) => d > 1);
  push(
    "dog-speed-cap",
    overallMax >= 4 && overallMax <= 8.5 && allMove,
    `max speed ${overallMax.toFixed(2)} m/s (per dog: ${maxSpeed.map((v) => v.toFixed(2)).join(", ")}); travelled ${travelled.map((v) => v.toFixed(1)).join(", ")} m`
  );

  const scales = samples[0].dogs.map((d) => d.sc);
  const smallest = scales.indexOf(Math.min(...scales));
  const largest = scales.indexOf(Math.max(...scales));
  push(
    "small-dogs-slower",
    maxSpeed[smallest] < maxSpeed[largest],
    `smallest (scale ${scales[smallest]}) max ${maxSpeed[smallest].toFixed(2)} vs largest (scale ${scales[largest]}) max ${maxSpeed[largest].toFixed(2)}`
  );

  const settleTicks = Math.round(5 / DT);
  let minClear = Infinity;
  for (let t = settleTicks; t < samples.length; t++) {
    const s = samples[t];
    for (const d of s.dogs) for (const o of s.owners) minClear = Math.min(minClear, Math.hypot(d.x - o.x, d.z - o.z));
  }
  push("no-owner-intersect", minClear > 0.75, `min dog↔owner distance after 5 s: ${minClear.toFixed(3)} m`);

  let airRun = 0, maxAirRun = 0, rollRun = 0, maxRollRun = 0;
  for (let t = 0; t < samples.length; t++) {
    const b = samples[t].ball;
    const height = b.y - b.g;
    airRun = height > 0.5 ? airRun + 1 : 0;
    maxAirRun = Math.max(maxAirRun, airRun);
    let rolling = false;
    if (t > 0 && height < 0.35) {
      const prev = samples[t - 1].ball;
      const v2d = Math.hypot(b.x - prev.x, b.z - prev.z) / DT;
      rolling = v2d > 1;
    }
    rollRun = rolling ? rollRun + 1 : 0;
    maxRollRun = Math.max(maxRollRun, rollRun);
  }
  const rollNeed = Math.round(0.5 / DT);
  push(
    "ball-flies-and-rolls",
    maxAirRun >= 5 && maxRollRun >= rollNeed,
    `longest airborne run ${maxAirRun} ticks (need ≥5), longest grounded roll >1 m/s ${maxRollRun} ticks (need ≥${rollNeed})`
  );

  let worstOut = 0;
  for (const s of samples) {
    const b = s.ball;
    if (!pointInPolygon(b.x, b.z, DOG_PARK)) worstOut = Math.max(worstOut, distToPolygonEdge(b.x, b.z, DOG_PARK));
  }
  push("ball-in-bounds", worstOut <= 0.3, `worst excursion outside polygon: ${worstOut.toFixed(3)} m (tolerance 0.3)`);

  push(
    "fence-is-wood",
    fence.found && fence.instanced >= 3 && fence.chainlink === 0,
    fence.found
      ? `group present, ${fence.instanced} InstancedMesh children [${fence.kids.join(", ")}], chainlink LineSegments: ${fence.chainlink}`
      : "corona_dog_park_fence group missing"
  );

  push(
    "dog-bark-audio-live",
    audio.context === "running" &&
      audio.layerGain > 0.5 &&
      nature.always > 0.01 &&
      audio.cueCounts.chase + audio.cueCounts.return > 0,
    `ctx ${audio.context}, dog layer ${audio.layerGain}, FX tap ${nature.always}, cues ${JSON.stringify(audio.cueCounts)}, last ${JSON.stringify(audio.lastVocal)}`
  );

  push(
    "dog-idle-bark-sparse",
    audio.ambientCount >= 1 && audio.ambientCount <= 2,
    `${audio.ambientCount} park-wide idle bark(s) in ${SIM_SECONDS}s (expected 1-2)`
  );

  push(
    "no-console-errors",
    pageErrors.length === 0,
    pageErrors.length === 0 ? "clean run" : `${pageErrors.length} error(s): ${pageErrors.slice(0, 3).join(" | ").slice(0, 400)}`
  );

  return results;
}

/* --------------------------------------------------------------- driver */

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  ownedDev = dev;
  const chrome = await findChrome();
  const port = await freePort();
  const profile = path.join(OUT, "chrome");
  const proc = spawn(chrome, [
    `--user-data-dir=${profile}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars", "--mute-audio",
    `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`
  ], { cwd: ROOT, stdio: "ignore" });
  chromeProc = proc;
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
  activeCdp = c;
  const pageErrors = [];
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      pageErrors.push(`exception: ${String(text).slice(0, 300)}`);
      console.log("[page-exception]", String(text).slice(0, 300));
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const text = m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300);
      pageErrors.push(`console.error: ${text}`);
      console.log("[page-error]", text);
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.player)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready (see [page-exception]/[page-error] above)");
  console.log(`[probe] __sf ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`); // freeze wall clock
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${TIME});return true;})()`);
  await settle(c, 12);

  // ---- part A: teleport to the park to stream tiles/colliders, then PIN the
  // camera there with the free cam — the activity sim gates on CAMERA distance
  // to the summit, and the chase camera takes many simulated seconds to fly in
  // from spawn after a teleport, which would freeze the park mid-window.
  await teleport(c, 368, 2703, 2.3);
  await settle(c, 16);
  const eyeA = await freeCam(c, 368, 2703, 2.3, 20, 8);
  await waitWorldLive(c, "part A");
  await settleCamera(c, eyeA);
  await waitWorldLive(c, "part A post-settle"); // warmup can also fire mid-settle
  const gateTicks = await ev(c, `(()=>{
    const sf = window.__sf;
    for (let i = 0; i < 300; i++) {
      sf.tick(${DT});
      if (sf.coronaHeights.activity.visible) return i;
    }
    return -1;
  })()`);
  if (gateTicks < 0) throw new Error("dog park activity gate never opened (camera outside 420 m?)");
  console.log(`[probe] activity gate open after ${gateTicks} ticks`);
  await ev(c, `window.__sf.nature.unlock()`);
  await sleep(120);
  // Deterministic smoke cue through the world's real callback boundary. Owner
  // loops remain probabilistic by design, so they cannot be the only proof.
  await ev(c, `(()=>{
    const sf=window.__sf, ch=sf.coronaHeights, oldRandom=Math.random;
    const dog=ch.dogs[0], oldController=dog.controller;
    sf.tick(${DT});
    try {
      Math.random=()=>0;
      dog.controller="player";
      ch.cueDogAudio(dog,"chase");
      sf.dogParkAudio.update(${DT},sf.player.renderPosition);
    } finally {
      dog.controller=oldController;
      Math.random=oldRandom;
    }
    return sf.dogParkAudio.debugState;
  })()`);
  const fence = await checkFence(c);
  const samples = await sampleBehavior(c);
  const audio = await ev(c, `window.__sf.dogParkAudio.debugState`);
  const nature = await ev(c, `window.__sf.nature.debugState`);
  console.log(`[probe] dog audio: ${JSON.stringify(audio)}; FX tap ${nature.always}`);
  writeFileSync(path.join(OUT, "behavior.json"), JSON.stringify(samples));
  console.log(`[probe] ${samples.length} samples → ${path.join(OUT, "behavior.json")}`);

  // ---- part B: static screenshots (summit-probe freeze pattern).
  // A concurrent editing session can push a Vite full-reload mid-run; re-arm
  // the frozen clock and retry the view instead of aborting.
  const rearm = async () => {
    const t = Date.now();
    while (Date.now() - t < 90000) {
      try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.player)`)) break; } catch {}
      await sleep(800);
    }
    await ev(c, `window.__sfManual&&window.__sfManual(true)`);
    await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${TIME});return true;})()`);
    await settle(c, 8);
  };

  const shotPaths = [];
  const shoot = async (name, x, z, facing, back, up) => {
    await waitWorldLive(c, name); // camera is still pinned near the park here
    if (name === "fetch_moment") {
      // run the sim until the golden is back at the ball owner's heel so the
      // pair reads as a pair (bounded — falls through to whatever pose exists)
      const heel = await ev(c, `(()=>{
        const sf = window.__sf, ch = sf.coronaHeights;
        for (let i = 0; i < 900; i++) {
          sf.tick(${DT});
          const d = ch.dogs[0], o = ch.owners[0].rig.group.position;
          if (Math.hypot(d.x - o.x, d.z - o.z) < 4) return i;
        }
        return -1;
      })()`);
      console.log(`[probe] fetch_moment heel wait: ${heel} ticks`);
    }
    await teleport(c, x, z, facing);
    await settle(c, 16); // stream tiles + colliders
    await teleport(c, 340, 2840, facing); // park the avatar downslope, out of frame
    await settle(c, 2);
    const eye = await freeCam(c, x, z, facing, back, up);
    await settleCamera(c, eye);
    await ev(c, `window.__sf.sky.setTimeOfDay(${TIME})`);
    for (let i = 0; i < 8; i++) await tick(c, DT);
    const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
    const file = path.join(OUT, `${name}.jpg`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    shotPaths.push(file);
    console.log(`[probe] shot ${name}`);
  };

  let failedViews = 0;
  for (const [name, x, z, facing, back, up] of VIEWS) {
    try {
      await shoot(name, x, z, facing, back, up);
    } catch (e) {
      console.log(`[view-retry] ${name}: ${String(e).slice(0, 120)}`);
      try {
        await rearm();
        await shoot(name, x, z, facing, back, up);
      } catch (e2) {
        failedViews++;
        console.log(`[view-fail] ${name}: ${String(e2).slice(0, 140)}`);
      }
    }
  }

  const results = runAssertions(samples, fence, audio, nature, pageErrors);
  writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, shots: shotPaths, failedViews }, null, 2));
  console.log(`[probe] screenshots + results in ${OUT}`);
  cleanup();
  const failed = results.filter((r) => !r.pass).length;
  if (failed > 0 || failedViews > 0) {
    console.error(`[probe] FAIL — ${failed} assertion(s), ${failedViews} view(s) failed`);
    process.exit(1);
  }
  console.log("[probe] PASS — all assertions green");
  process.exit(0);
}
main().catch((e) => { cleanup(); console.error("[probe] FAIL", e); process.exit(1); });
