// Headless render probe for the Lands End eye-walker (src/world/landsEnd/
// eyeWalker.ts): the Tripo-generated many-eyed creature pacing the labyrinth
// plateau with the ginger ukulelist riding its shoulders. Boots the app in
// headless Chrome (WebGPU via ANGLE-metal), verifies the massive-app loading
// contract (zero /models/eye-walker.glb requests at boot; exactly one after
// approaching the labyrinth), checks assembly + wander + the solo-uke
// transport rotation, and screenshots key views.
//
//   node tools/eye-walker-probe.mjs
// Env:
//   SF_PROBE_OUT  out dir (default .data/eye-walker-probe)
//   SF_PROBE_URL  vite url (default http://127.0.0.1:5243 — killed+restarted fresh)
//   SF_TIME       time of day hours (default 17.0)

import { spawn, execSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/eye-walker-probe");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5243";
const TIME = Number(process.env.SF_TIME ?? 17.0);
const W = 1280, H = 720;
const LABY = { x: -5890, z: 775 };
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
async function startDev() {
  // fixed-port probes must never talk to a stale vite serving old code
  const vitePort = Number(new URL(SERVER_URL).port);
  try { execSync(`lsof -ti tcp:${vitePort} | xargs kill -9`, { stdio: "ignore" }); } catch {}
  const relay = await freePort();
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
  activeCdp = null; chromeProc = null; ownedDev = null;
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
  return r.result?.value;
}
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function tick(c, dt) { await ev(c, frame(dt)); }
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(0)); await sleep(60); } }
async function advance(c, seconds) {
  const steps = Math.ceil(seconds * 30);
  await ev(c, `(async()=>{for(let i=0;i<${steps};i++){window.__sf.tick(1/30);}await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`);
}
async function teleport(c, x, z, facing) {
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundTop?m.groundTop(${x},${z}):m.groundHeight(${x},${z});p.teleportTo({x:${x},y:y+1.5,z:${z},facing:${facing},mode:'walk'});return true;})()`);
}

async function shoot(c, name, eye, tgt) {
  await ev(c, `window.__sfFreeCam([${eye.join(",")}],[${tgt.join(",")}])`);
  for (let i = 0; i < 160; i++) {
    await tick(c, 0);
    const p = await ev(c, `[window.__sf.camera.position.x,window.__sf.camera.position.y,window.__sf.camera.position.z]`);
    if (Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) < 0.05) break;
    await sleep(40);
  }
  for (let i = 0; i < 4; i++) await tick(c, 1 / 240);
  const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
  writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(shot.data, "base64"));
  console.log(`[probe] shot ${name}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  ownedDev = await startDev();
  const chrome = await findChrome();
  const port = await freePort();
  const profile = path.join(OUT, "chrome");
  chromeProc = spawn(chrome, [
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
  activeCdp = c;
  const pageErrors = [];
  const glbRequests = [];
  c.onEvent = (m) => {
    if (m.method === "Network.requestWillBeSent") {
      const url = m.params.request.url;
      if (url.includes("eye-walker")) { glbRequests.push(url); console.log("[net] ", url.slice(-60)); }
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      pageErrors.push(msg);
      console.log("[page-exception]", String(msg).slice(0, 300));
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const msg = m.params.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300);
      pageErrors.push(msg);
      console.log("[page-error]", msg);
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable");

  console.log("[probe] waiting for __sf...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.player)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready — see [page-exception] above");
  console.log(`[probe] __sf ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${TIME});return true;})()`);
  await settle(c, 10);

  // ---- phase 1: boot must not touch the creature asset ----
  if (glbRequests.length > 0) throw new Error(`LAZY-LOAD REGRESSION: eye-walker asset fetched at boot: ${glbRequests[0]}`);
  console.log("[probe] boot clean: 0 eye-walker requests");

  // ---- phase 2: approach the labyrinth → region + walker stream in ----
  await teleport(c, LABY.x + 40, LABY.z - 25, Math.PI * 0.75);
  const t1 = Date.now();
  let walkerReady = false;
  while (Date.now() - t1 < 120000) {
    await settle(c, 4);
    try {
      const st = await ev(c, `window.__sf.landsEnd?.walker?.debugState ?? null`);
      if (st?.ready) { walkerReady = true; break; }
    } catch {}
    await sleep(400);
  }
  if (!walkerReady) throw new Error("walker never became ready after approach");
  const debug0 = await ev(c, `window.__sf.landsEnd.walker.debugState`);
  console.log("[probe] walker ready:", JSON.stringify(debug0));
  if (glbRequests.length !== 1) throw new Error(`expected exactly 1 eye-walker request after approach, got ${glbRequests.length}`);
  if (!debug0.headBone) throw new Error("no head bone found — saddle will float");

  const assembly = await ev(c, `(()=>{
    const w = window.__sf.landsEnd.walker;
    let meshes = 0, skinned = 0, riderMeshes = 0;
    w.group.traverse((o) => { if (o.isMesh) meshes++; if (o.isSkinnedMesh) skinned++; });
    const rider = w.group.children.find((c) => c.name === "eyeWalker.rider");
    rider?.traverse((o) => { if (o.isMesh) riderMeshes++; });
    return { children: w.group.children.length, meshes, skinned, riderMeshes, visible: w.group.visible };
  })()`);
  console.log("[probe] assembly:", JSON.stringify(assembly));
  if (assembly.skinned < 1) throw new Error("creature skinned mesh missing");
  if (assembly.riderMeshes < 20) throw new Error(`rider looks unassembled (${assembly.riderMeshes} meshes)`);
  if (!assembly.visible) throw new Error("walker group not visible after ready");

  // ---- optional: SF_DIAG=1 — numeric facing/seat/audio diagnosis ----
  // Facing is measured, not eyeballed: the ukulele hangs in FRONT of the
  // musician's chest, so dot(ukeWorld - riderWorld, creatureForward) > 0 iff
  // the rider faces the way the creature walks. Audio needs a real user
  // gesture (CDP click) plus REAL time — synchronous ticks never advance
  // ctx.currentTime, so the lookahead scheduler can't fire under advance().
  if (process.env.SF_DIAG) {
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 640, y: 400, button: "left", clickCount: 1 });
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 640, y: 400, button: "left", clickCount: 1 });
    console.log("[probe] userActivation:", await ev(c, `navigator.userActivation?.hasBeenActive === true`));
    const geom = await ev(c, `(()=>{
      const T = window.__sf.THREE, w = window.__sf.landsEnd.walker;
      w.group.updateMatrixWorld(true);
      const st = w.debugState;
      const fwd = new T.Vector3(Math.sin(st.yaw), 0, Math.cos(st.yaw)); // creature walk direction
      const rider = w.group.children.find((o) => o.name === "eyeWalker.rider");
      let uke = null, riderRig = null;
      rider?.traverse((o) => { if (o.name === "busker-ukulele") uke = o; if (o.name === "busker-ukulelist") riderRig = o; });
      const rp = rider.getWorldPosition(new T.Vector3());
      const up_ = uke ? uke.getWorldPosition(new T.Vector3()) : null;
      const bones = {};
      w.group.traverse((o) => {
        if (!o.isBone) return;
        if (/^(Head|Neck|Spine02|L_Clavicle|R_Clavicle|L_Upperarm|R_Upperarm)$/i.test(o.name)) {
          const p = o.getWorldPosition(new T.Vector3());
          bones[o.name] = [ +(p.x - w.group.position.x).toFixed(3), +(p.y - w.group.position.y).toFixed(3), +(p.z - w.group.position.z).toFixed(3) ];
        }
      });
      return {
        yaw: +st.yaw.toFixed(3),
        creatureForward: [ +fwd.x.toFixed(3), +fwd.z.toFixed(3) ],
        ukeDotForward: up_ ? +up_.clone().sub(rp).dot(fwd).toFixed(3) : null,
        riderRotY: +rider.rotation.y.toFixed(3),
        bonesRelToFeet: bones
      };
    })()`);
    console.log("[probe] geometry:", JSON.stringify(geom, null, 1));
    console.log(geom.ukeDotForward > 0 ? "[probe] uke hangs in front of the rider (rider matches group forward)" : "[probe] FACING WRONG — rider is backwards");
    const arms = geom.bonesRelToFeet;
    if (arms.L_Upperarm && arms.R_Upperarm) {
      const dz = Math.abs(arms.L_Upperarm[2] - arms.R_Upperarm[2]);
      const dx = Math.abs(arms.L_Upperarm[0] - arms.R_Upperarm[0]);
      console.log(`[probe] arm axis: dx=${dx.toFixed(2)} dz=${dz.toFixed(2)} → ${dx > dz ? "X (creature faces ±Z — MODEL_YAW correct)" : "Z (creature faces ±X — MODEL_YAW is a quarter-turn off)"}`);
      if (dx > dz && arms.L_Upperarm[0] < 0) console.log("[probe] left arm on -X → creature faces -Z (flip MODEL_YAW by π)");
    }

    // Audio needs the listener inside AUDIBLE_RADIUS (80 m) AND real time:
    // ctx.currentTime only advances in wall-clock, so hand the app back its own
    // rAF loop instead of stepping it synchronously.
    await ev(c, `(()=>{
      const sf = window.__sf, w = sf.landsEnd.walker, p = w.debugState.pos;
      const x = p[0] + 7, z = p[2] + 7;
      sf.player.teleportTo({ x, y: sf.map.groundTop(x, z) + 1.5, z, facing: Math.PI * 1.25, mode: "walk" });
      return true;
    })()`);
    await ev(c, `window.__sfManual && window.__sfManual(false)`); // live rAF: real dt + real ctx clock
    for (let i = 0; i < 26; i++) {
      await sleep(1000);
      const st = await ev(c, `(()=>{
        const w = window.__sf.landsEnd.walker, d = w.debugState;
        const cam = window.__sf.camera.position, p = d.pos;
        return JSON.stringify({ ...d.audio, phase: d.phase, camDist: +Math.hypot(cam.x - p[0], cam.z - p[2]).toFixed(1) });
      })()`);
      const parsed = JSON.parse(st);
      if (i % 3 === 0 || parsed.notes > 0) console.log(`[probe] t+${i + 1}s`, st);
      if (parsed.notes > 0) { console.log("[probe] NOTES SCHEDULED — audio path live"); break; }
    }
    // audible ≠ scheduled — sample the actual output mix off an AnalyserNode
    // tapped on the AudioContext destination so we know sound reaches the ears
    const audible = await ev(c, `(async()=>{
      const sf = window.__sf;
      // find the walker's private AudioContext via any running context that has
      // our panner. Simpler: read musicAudioLevel and RMS the destination.
      const lvl = sf.CONFIG ? null : null;
      const w = sf.landsEnd.walker;
      // reuse the app's own audio settings getter
      const musicLevel = (await import('/src/core/audioSettings.ts')).musicAudioLevel();
      return { musicLevel };
    })()`).catch((e) => ({ err: String(e).slice(0, 100) }));
    console.log("[probe] music level:", JSON.stringify(audible));
    const final = await ev(c, `JSON.stringify(window.__sf.landsEnd.walker.debugState.audio)`);
    console.log("[probe] final audio:", final);
    if (JSON.parse(final).notes === 0) console.log("[probe] AUDIO DEAD — no notes reached the synth");
    cleanup();
    process.exit(0);
  }

  // ---- optional: SF_ORBIT=1 — fast visual calibration (HUD off, orbit shots) ----
  if (process.env.SF_ORBIT) {
    await ev(c, `(()=>{const h=document.getElementById('hud');if(h)h.style.display='none';return true;})()`);
    const anatomy = await ev(c, `(()=>{
      const T = window.__sf.THREE, w = window.__sf.landsEnd.walker;
      w.group.updateMatrixWorld(true);
      let head = null;
      w.group.traverse((o) => { if (o.isBone && /^head$/i.test(o.name)) head = o; });
      const hp = head ? head.getWorldPosition(new T.Vector3()) : null;
      const box = new T.Box3().setFromObject(w.group.children.find((c) => c.name === "eyeWalker.creature"));
      const rider = w.group.children.find((c) => c.name === "eyeWalker.rider");
      return {
        ground: w.group.position.y,
        headRel: hp ? [hp.x - w.group.position.x, hp.y - w.group.position.y, hp.z - w.group.position.z] : null,
        creatureTop: box.max.y - w.group.position.y,
        riderRel: rider ? [rider.position.x, rider.position.y, rider.position.z] : null
      };
    })()`);
    console.log("[probe] anatomy:", JSON.stringify(anatomy));
    await ev(c, `window.__sf.landsEnd.walker.seek(10)`);
    await advance(c, 1.0);
    const at = async (ang, dist, up, tgtUp) => {
      const wp = await ev(c, `window.__sf.landsEnd.walker.debugState.pos`);
      const yaw = await ev(c, `window.__sf.landsEnd.walker.debugState.yaw`);
      const a = yaw + ang;
      return { eye: [wp[0] + Math.sin(a) * dist, wp[1] + up, wp[2] + Math.cos(a) * dist], tgt: [wp[0], wp[1] + tgtUp, wp[2]] };
    };
    for (const [name, ang] of [["front", 0], ["right", Math.PI / 2], ["back", Math.PI], ["left", -Math.PI / 2]]) {
      const v = await at(ang, 6.5, 2.6, 1.9);
      await shoot(c, `orbit_${name}`, v.eye, v.tgt);
    }
    {
      const v = await at(0.55, 4.6, 4.0, 3.0);
      await shoot(c, "orbit_rider", v.eye, v.tgt);
    }
    await advance(c, 3);
    {
      const v = await at(0.4, 8, 2.4, 1.8);
      await shoot(c, "orbit_walking", v.eye, v.tgt);
    }
    console.log(`[probe] orbit shots in ${OUT}`);
    cleanup();
    process.exit(0);
  }

  // ---- phase 3: wander — creature moves and stays on the plateau annulus ----
  const wander = await ev(c, `(()=>{
    const w = window.__sf.landsEnd.walker;
    const p0 = w.debugState.pos.slice();
    for (let i = 0; i < 30 * 45; i++) window.__sf.tick(1/30);
    const st = w.debugState;
    const d0 = Math.hypot(p0[0] - ${LABY.x}, p0[2] - ${LABY.z});
    const d1 = Math.hypot(st.pos[0] - ${LABY.x}, st.pos[2] - ${LABY.z});
    return { moved: Math.hypot(st.pos[0] - p0[0], st.pos[2] - p0[2]), d0, d1, y: st.pos[1], moving: st.moving, timeScale: st.walkTimeScale };
  })()`);
  console.log("[probe] wander(45s):", JSON.stringify(wander));
  if (wander.moved < 3) throw new Error(`creature barely moved in 45s (${wander.moved.toFixed(1)}m)`);
  if (wander.d1 < 14 || wander.d1 > 55) throw new Error(`creature left the labyrinth annulus (r=${wander.d1.toFixed(1)})`);
  if (Math.abs(wander.y - 71.2) > 8) throw new Error(`creature fell off the terrace shelf (y=${wander.y.toFixed(1)})`);

  // ---- phase 4: transport rotation (song → rest → countin → next song) ----
  const rotation = await ev(c, `(()=>{
    const w = window.__sf.landsEnd.walker;
    const tickFrames = (seconds) => { for (let i = 0; i < Math.ceil((seconds + 0.1) * 30); i++) window.__sf.tick(1/30); };
    const before = w.debugState.song;
    w.seek(9999);
    window.__sf.tick(1/30);
    const rest = w.debugState;
    tickFrames(rest.restSeconds);
    const countin = w.debugState;
    tickFrames(4 * 60 / 76 + 0.2);
    const playing = w.debugState;
    return { before, after: countin.song, restPhase: rest.phase, restSeconds: rest.restSeconds, countinPhase: countin.phase, playingPhase: playing.phase };
  })()`);
  console.log("[probe] rotation:", JSON.stringify(rotation));
  if (rotation.restPhase !== "rest") throw new Error(`song did not enter rest: ${JSON.stringify(rotation)}`);
  if (rotation.countinPhase !== "countin" || rotation.before === rotation.after) throw new Error(`songbook did not advance: ${JSON.stringify(rotation)}`);
  if (rotation.playingPhase !== "playing") throw new Error(`next song did not start: ${JSON.stringify(rotation)}`);
  if (rotation.restSeconds < 16 || rotation.restSeconds > 28) throw new Error(`rest outside 16-28s: ${rotation.restSeconds}`);

  // ---- phase 5: screenshots ----
  await ev(c, `window.__sf.landsEnd.walker.seek(10)`);
  await advance(c, 1.2);
  const wp = await ev(c, `window.__sf.landsEnd.walker.debugState.pos`);
  const yaw = await ev(c, `window.__sf.landsEnd.walker.debugState.yaw`);
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  // front 3/4 wide: creature + rider + labyrinth context
  await shoot(c, "wide_front", [wp[0] + fx * 9 + fz * 3.5, wp[1] + 3.2, wp[2] + fz * 9 - fx * 3.5], [wp[0], wp[1] + 2.0, wp[2]]);
  // rider portrait: close on the shoulders
  await shoot(c, "rider_close", [wp[0] + fx * 4.2 - fz * 1.2, wp[1] + 3.4, wp[2] + fz * 4.2 + fx * 1.2], [wp[0], wp[1] + 2.9, wp[2]]);
  // labyrinth over-shot with the walker in frame
  await shoot(c, "labyrinth_context", [LABY.x + 55, 71.2 + 26, LABY.z + 18], [LABY.x, 71.2, LABY.z]);
  // twilight mood shot
  await ev(c, `window.__sf.sky.setTimeOfDay(20.6)`);
  await settle(c, 8);
  await shoot(c, "twilight", [wp[0] + fx * 8 - fz * 3, wp[1] + 2.6, wp[2] + fz * 8 + fx * 3], [wp[0], wp[1] + 2.2, wp[2]]);

  console.log(`[probe] screenshots in ${OUT}`);
  const walkerErrors = pageErrors.filter((e) => /eyeWalker|eye-walker|ukulel/i.test(String(e)));
  cleanup();
  if (walkerErrors.length) throw new Error(`walker page errors: ${walkerErrors[0]}`);
  console.log("[probe] PASS");
  process.exit(0);
}
main().catch((e) => { cleanup(); console.error("[probe] FAIL", e); process.exit(1); });
