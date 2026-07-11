// Deterministic 15s hoverboard-customizer showcase video.
//
// Boots the app headless (WebGPU via ANGLE-metal), pins the clock
// (__sfManual), solos the BOARD LAB panel (hud.soloPanel), and drives a
// scripted timeline frame-by-frame at a fixed dt: a visible fake cursor
// clicks colors / deck art / shape+fins, drags the XY pads (plume + voice)
// and picks a hum — then the panel closes, the chase cam takes over and the
// player boosts off the Corona Heights summit and ollies so the hover plumes
// read. Every frame is screenshotted and ffmpeg-assembled at 60fps, so GPU
// speed never affects smoothness.
//
//   node tools/capture-board-video.mjs           # full 15s capture + encode
//   node tools/capture-board-video.mjs stills    # preview stills only (fast-ish)
//
// Env: SF_BV_URL (default http://127.0.0.1:5193 — fresh server, never the
// shared human vite), SF_BV_TIME (default 19.9 — July sunset), SF_BV_OUT,
// SF_BV_FROM/SF_BV_TO (partial re-render), CHROME_BIN.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.argv[2]; // undefined | "stills" | "debug"
const STILLS = MODE === "stills";
const DEBUG = MODE === "debug";
const W = 1920, H = 1080;
const FPS = 60;
const DURATION = 15;
const TOTAL = FPS * DURATION;
const DT = 1 / FPS;
const SERVER_URL = process.env.SF_BV_URL ?? "http://127.0.0.1:5193";
const TIME = Number(process.env.SF_BV_TIME ?? 20.15);
const WORK = path.join(ROOT, ".data", "board-video");
const RAW = path.join(WORK, "raw");
const OUT_MP4 = process.env.SF_BV_OUT ? path.resolve(ROOT, process.env.SF_BV_OUT) : path.join(ROOT, "dist", "reel", "board-customizer-15s.mp4");
// preview stills sampled across the timeline (frame indices)
const STILL_FRAMES = [12, 70, 140, 230, 310, 330, 420, 470, 540, 585, 615, 665, 700, 770, 820, 880];

// ---- shot staging -----------------------------------------------------------
// Corona Heights summit platform, facing NE past the crags toward downtown.
const PX = 412, PZ = 2758, FACING = 2.25;
// phase A free camera: slow push-in, player left-of-frame (panel sits right)
const CAM_BACK0 = 7.4, CAM_BACK1 = 6.2, CAM_UP0 = 2.9, CAM_UP1 = 2.4;
const CAM_SIDE = 4.2; // shift target sideways so the board sits left of center
const PHASE_B = 10.0; // customization ends, riding begins
const CLOSE_T = 9.55; // click the panel toggle shut
const RIDE_T = 10.25; // throttle on
const BOOST_T = 10.9; // boost on
const JUMP_T = 12.7; // ollie

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function findChrome() {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    if (c.includes("/") && !existsSync(c)) continue;
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
  console.log(`[bv] starting Vite at ${SERVER_URL}`);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"], detached: true
  });
  await waitHttp(SERVER_URL, 60000, "vite");
  return child;
}
function runProcess(cmd, args) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
    c.once("error", rej);
    c.once("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });
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
const frameExpr = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function settle(c, n, gap = 55) { for (let i = 0; i < n; i++) { await ev(c, frameExpr(0)); await sleep(gap); } }

let ownedDev = null, chromeProc = null, activeCdp = null;
function cleanup() {
  try { activeCdp?.close(); } catch {}
  try { chromeProc?.kill(); } catch {}
  try { if (ownedDev) process.kill(-ownedDev.pid); } catch {}
  activeCdp = chromeProc = ownedDev = null;
}

// ---- easing / cursor path ---------------------------------------------------
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const lerp = (a, b, u) => a + (b - a) * u;

/** Piecewise cursor path over waypoints [{t,x,y}] with eased segments. */
function cursorAt(keys, t) {
  if (t <= keys[0].t) return { x: keys[0].x, y: keys[0].y };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t <= b.t) {
      const u = easeInOut(Math.min(1, Math.max(0, (t - a.t) / Math.max(1e-4, b.t - a.t))));
      return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) };
    }
  }
  const last = keys[keys.length - 1];
  return { x: last.x, y: last.y };
}

// ---- in-page bootstrap (cursor + per-frame op applier) ------------------------
const BOOTSTRAP = `(()=>{ if(window.__bv) return true;
  const cur=document.createElement('div');
  cur.style.cssText='position:fixed;left:0;top:0;width:26px;height:30px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 1.5px 2.5px rgba(0,0,0,0.6))';
  cur.innerHTML='<svg width="26" height="30" viewBox="0 0 26 30"><path d="M2 1 L2 23.2 L7.7 17.9 L11.5 26.4 L15.4 24.6 L11.7 16.3 L19.4 15.7 Z" fill="#fff" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const pulse=document.createElement('div');
  pulse.style.cssText='position:fixed;left:0;top:0;width:46px;height:46px;border-radius:50%;border:2.5px solid rgba(255,255,255,0.95);box-shadow:0 0 14px rgba(140,240,255,0.9);z-index:2147483646;pointer-events:none;opacity:0';
  document.body.appendChild(pulse); document.body.appendChild(cur);
  window.__bv={apply(op){
    const sf=window.__sf;
    if(op.cursor){cur.style.transform='translate('+(op.cursor.x-2)+'px,'+(op.cursor.y-1)+'px) scale('+op.cursor.s+')';cur.style.opacity=op.cursor.o;}
    if(op.pulse){pulse.style.transform='translate('+(op.pulse.x-23)+'px,'+(op.pulse.y-23)+'px) scale('+op.pulse.s+')';pulse.style.opacity=op.pulse.o;}
    else pulse.style.opacity=0;
    if(op.cam) window.__sfFreeCam(op.cam.eye,op.cam.target);
    if(op.camRelease){
      // hand off to the chase cam from roughly where the free cam ended
      window.__sfFreeCam(null);
      const p=sf.player,T=sf.THREE;
      const d=new T.Vector3(Math.sin(op.camRelease.facing),0,Math.cos(op.camRelease.facing));
      const eye=p.position.clone().addScaledVector(d,-op.camRelease.back); eye.y+=op.camRelease.up;
      sf.chase.camera.position.copy(eye);
      sf.chase.camera.lookAt(p.position.x,p.position.y+1.1,p.position.z);
      sf.input.suspended=false;
    }
    for(const k of op.keysAdd||[]) sf.input.keys.add(k);
    for(const k of op.keysDel||[]) sf.input.keys.delete(k);
    if(op.jump) sf.player.requestBoardJump();
  }};
  return true;
})()`;

// Measure every click/drag target once the panel is open. Centers in CSS px.
const MEASURE = `(()=>{
  const panel=document.querySelector('.board-panel');
  if(!panel) return {error:'no panel'};
  const center=(el)=>{const b=el.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};};
  const rect=(el)=>{const b=el.getBoundingClientRect();return {left:b.left,top:b.top,width:b.width,height:b.height};};
  const rows=[...panel.querySelectorAll('.avatar-row')];
  const swatchRows=rows.filter(r=>r.querySelector('.avatar-swatch'));
  const choiceRows=rows.filter(r=>r.querySelector('.avatar-choice')&&!r.querySelector('.avatar-swatch'));
  const centers=(row)=>[...row.querySelectorAll('.avatar-swatch,.avatar-choice')].map(center);
  const pads={};
  for(const kind of ['surface','motion','sound','thrust','plume']){
    const pad=panel.querySelector('.board-lab-'+kind+' .board-xy-pad');
    pads[kind]=pad?rect(pad):null;
  }
  const pr=panel.getBoundingClientRect();
  return {
    panel:{left:pr.left,top:pr.top,width:pr.width,height:pr.height,scrollable:panel.scrollHeight>panel.clientHeight+1,clientHeight:panel.clientHeight,scrollHeight:panel.scrollHeight},
    deck:centers(swatchRows[0]||{querySelectorAll:()=>[]}),
    ink:swatchRows[1]?centers(swatchRows[1]):[],
    glow:swatchRows[2]?centers(swatchRows[2]):[],
    shape:choiceRows[0]?centers(choiceRows[0]):[],
    fins:choiceRows[1]?centers(choiceRows[1]):[],
    tex:choiceRows[2]?centers(choiceRows[2]):[],
    wave:choiceRows[3]?centers(choiceRows[3]):[],
    note:choiceRows[4]?centers(choiceRows[4]):[],
    pads,
    toggle:center(document.querySelector('.board-toggle'))
  };
})()`;

// ---- timeline construction ---------------------------------------------------
/** Build the phase-A interaction plan from measured target centers. */
function buildPlan(m) {
  const clicks = []; // {t, x, y}
  const drags = [];  // {t0, t1, from:{x,y}, to:{x,y}}
  const keys = [{ t: 0.15, x: W * 0.42, y: H * 0.62 }]; // cursor starts over the board

  const pad = (kind, u, v) => {
    const r = m.pads[kind];
    return { x: r.left + r.width * u, y: r.top + r.height * v };
  };
  const visit = (t, p) => {
    keys.push({ t: t - 0.16, x: p.x, y: p.y });
    keys.push({ t: t + 0.22, x: p.x, y: p.y });
    clicks.push({ t, x: p.x, y: p.y });
  };
  const drag = (t0, t1, a, b) => {
    keys.push({ t: t0 - 0.18, x: a.x, y: a.y });
    keys.push({ t: t0, x: a.x, y: a.y });
    keys.push({ t: t1, x: b.x, y: b.y });
    keys.push({ t: t1 + 0.2, x: b.x, y: b.y });
    drags.push({ t0, t1, from: a, to: b });
  };

  visit(1.0, m.deck[3]);   // deck color #1
  visit(1.75, m.deck[6]);  // deck color #2
  visit(2.5, m.glow[2]);   // glow color
  visit(3.35, m.tex[4]);   // deck art: plasma
  visit(4.15, m.tex[0]);   // deck art: aurora
  visit(5.0, m.shape[2]);  // shape: manta (geometry morph)
  visit(5.8, m.fins[3]);   // fins: halo ring (geometry morph)
  drag(6.5, 7.4, pad("plume", 0.25, 0.8), pad("plume", 0.88, 0.18)); // plume reach+shimmer up
  drag(7.9, 8.7, pad("sound", 0.2, 0.7), pad("sound", 0.82, 0.25)); // voice tone/LFO
  visit(9.15, m.wave[3]);  // hum: choir
  visit(CLOSE_T, m.toggle); // close the panel
  // cursor drifts off toward the vista as it fades
  keys.push({ t: PHASE_B + 0.6, x: W * 0.55, y: H * 0.42 });
  keys.sort((a, b) => a.t - b.t);
  return { clicks, drags, keys };
}

/** Everything that must happen on frame i, as one op object for __bv.apply. */
function opForFrame(plan, i) {
  const t = i * DT;
  const op = { keysAdd: [], keysDel: [] };

  // cursor + press scale + fade-out after phase A
  const pos = cursorAt(plan.keys, t);
  const pressing = plan.clicks.some((cl) => t >= cl.t && t < cl.t + 0.1) || plan.drags.some((d) => t >= d.t0 && t <= d.t1);
  const o = t < PHASE_B ? 1 : Math.max(0, 1 - (t - PHASE_B) / 0.45);
  op.cursor = { x: pos.x, y: pos.y, s: pressing ? 0.86 : 1, o };

  // click pulse ring (0.38s life, driven manually — CSS anims don't advance here)
  for (const cl of plan.clicks) {
    const u = (t - cl.t) / 0.38;
    if (u >= 0 && u < 1) op.pulse = { x: cl.x, y: cl.y, s: 0.35 + u * 1.15, o: 0.9 * (1 - u) };
  }

  // camera: phase A slow push-in via free cam; release to chase at PHASE_B
  if (t < PHASE_B) {
    const u = easeInOut(t / PHASE_B);
    const back = lerp(CAM_BACK0, CAM_BACK1, u), up = lerp(CAM_UP0, CAM_UP1, u);
    const dx = Math.sin(FACING), dz = Math.cos(FACING);
    // perpendicular offset pushes the board left-of-frame (panel lives right)
    const px = Math.cos(FACING), pz = -Math.sin(FACING);
    op.cam = {
      eye: [PX - dx * back + px * CAM_SIDE * 0.4, `GY+${up}`, PZ - dz * back + pz * CAM_SIDE * 0.4],
      target: [PX + dx * 3 + px * CAM_SIDE, `GY+${1.0}`, PZ + dz * 3 + pz * CAM_SIDE]
    };
  } else if (i === Math.round(PHASE_B * FPS)) {
    op.camRelease = { facing: FACING, back: CAM_BACK1, up: CAM_UP1 };
  }

  // ride + jump
  if (i === Math.round(RIDE_T * FPS)) op.keysAdd.push("KeyW");
  if (i === Math.round(BOOST_T * FPS)) op.keysAdd.push("ShiftLeft");
  if (i === Math.round(JUMP_T * FPS)) op.jump = true;
  return op;
}

// mouse events (real CDP input) scheduled in (prevT, t] for frame i
function mouseEventsForFrame(plan, i) {
  const t = i * DT, prev = (i - 1) * DT;
  const evs = [];
  const within = (x) => x > prev && x <= t;
  // hover-follow: while the cursor is visible in phase A, keep the real mouse
  // on it so :hover states read (skip while a drag owns the button)
  const inDrag = plan.drags.find((d) => t >= d.t0 && t <= d.t1);
  const pos = cursorAt(plan.keys, t);
  if (t < PHASE_B && !inDrag) evs.push({ type: "mouseMoved", x: pos.x, y: pos.y, button: "none", buttons: 0 });
  for (const cl of plan.clicks) {
    if (within(cl.t)) evs.push({ type: "mousePressed", x: cl.x, y: cl.y, button: "left", buttons: 1, clickCount: 1 });
    if (within(cl.t + 0.09)) evs.push({ type: "mouseReleased", x: cl.x, y: cl.y, button: "left", buttons: 0, clickCount: 1 });
  }
  for (const d of plan.drags) {
    if (within(d.t0)) {
      evs.push({ type: "mouseMoved", x: d.from.x, y: d.from.y, button: "none", buttons: 0 });
      evs.push({ type: "mousePressed", x: d.from.x, y: d.from.y, button: "left", buttons: 1, clickCount: 1 });
    } else if (t > d.t0 && t < d.t1) {
      evs.push({ type: "mouseMoved", x: pos.x, y: pos.y, button: "left", buttons: 1 });
    }
    if (within(d.t1)) evs.push({ type: "mouseReleased", x: d.to.x, y: d.to.y, button: "left", buttons: 0, clickCount: 1 });
  }
  return evs;
}

async function encode() {
  mkdirSync(path.dirname(OUT_MP4), { recursive: true });
  await runProcess("ffmpeg", [
    "-y", "-framerate", String(FPS), "-i", path.join(RAW, "frame_%05d.jpg"),
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", String(DURATION),
    "-vf", `scale=${W}:${H}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", "16",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-r", String(FPS), "-shortest",
    OUT_MP4
  ]);
}

async function main() {
  const FROM = Math.max(0, Number(process.env.SF_BV_FROM ?? 0));
  const TO = Math.min(TOTAL, Number(process.env.SF_BV_TO ?? TOTAL));
  if (!STILLS && FROM === 0 && TO === TOTAL) await rm(RAW, { recursive: true, force: true });
  mkdirSync(RAW, { recursive: true });
  ownedDev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  chromeProc = spawn(chrome, [
    `--user-data-dir=${path.join(WORK, "chrome")}`, "--headless=new", "--no-first-run", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, "--force-device-scale-factor=1",
    `${SERVER_URL}/?autostart&fullfps`
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
  c.onEvent = (m) => {
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      console.log("[page-exception]", (d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
  };
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log("[bv] waiting for __sf...");
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.sky&&window.__sf.player&&window.__sf.hud&&window.__sf.boardSelector)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("__sf never ready");
  console.log(`[bv] __sf ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  await ev(c, `window.__sfManual(true)`);
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${TIME});return true;})()`);
  // stage: teleport onto the summit already in board mode
  await ev(c, `(()=>{const m=window.__sf.map,p=window.__sf.player;const y=m.groundHeight(${PX},${PZ});p.teleportTo({x:${PX},y:y+1.6,z:${PZ},facing:${FACING},mode:'board'});return true;})()`);
  await settle(c, 45); // stream tiles/foliage/crags
  const snap = async (name) => {
    const s = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
    writeFileSync(path.join(WORK, `${name}.jpg`), Buffer.from(s.data, "base64"));
    console.log(`[bv] snap ${name}`);
  };
  // let the panel show whole at 1080p — its natural content is ~860px, the
  // stock cap is min(78vh,680px) which forces a scrollbar
  // transitions never advance under the pinned headless clock (the panel's
  // opacity fade would stay at 0 forever) — snap everything to final state
  await ev(c, `(()=>{const st=document.createElement('style');st.textContent='.board-panel{max-height:min(94vh,1010px)!important} #hud *,#hud{transition:none!important;animation:none!important}';document.head.appendChild(st);return true;})()`);
  // solo the board panel, open it, install the fake cursor
  await ev(c, `(()=>{window.__sf.hud.soloPanel('board');document.querySelector('.board-toggle').click();return true;})()`);
  await settle(c, 8);
  await ev(c, BOOTSTRAP);
  if (DEBUG) await snap("dbg_open");

  const m = await ev(c, MEASURE);
  if (m.error) throw new Error(m.error);
  console.log(`[bv] panel ${Math.round(m.panel.width)}x${Math.round(m.panel.height)} scrollable=${m.panel.scrollable} (client ${m.panel.clientHeight} / scroll ${m.panel.scrollHeight})`);
  if (m.panel.scrollable) console.log("[bv] WARNING: panel still scrollable — lower targets will be clipped");
  // settle the teleport drop-in (hover spring runs on sim time, dt=0 settles nothing)
  for (let i = 0; i < 100; i++) await ev(c, frameExpr(DT));
  if (DEBUG) await snap("dbg_warm");
  for (const k of ["deck", "glow", "shape", "fins", "tex", "wave"]) {
    if (!m[k] || m[k].length < 4) throw new Error(`target group ${k} missing/short: ${JSON.stringify(m[k])}`);
  }
  for (const k of ["plume", "sound"]) if (!m.pads[k]) throw new Error(`pad ${k} missing`);
  const plan = buildPlan(m);
  // stash ground height for camera expressions
  await ev(c, `window.__bvGY=window.__sf.map.groundHeight(${PX},${PZ});true`);

  // resolve "GY+n" placeholders now that GY exists page-side: send cam coords as expressions
  const applyFrame = async (i) => {
    const op = opForFrame(plan, i);
    let expr;
    if (op.cam) {
      const [ex, ey, ez] = op.cam.eye, [tx, ty, tz] = op.cam.target;
      const num = (v) => (typeof v === "string" ? `window.__bvGY+${v.slice(3)}` : String(v));
      expr = `__bv.apply({...${JSON.stringify({ ...op, cam: undefined })},cam:null});window.__sfFreeCam([${num(ex)},${num(ey)},${num(ez)}],[${num(tx)},${num(ty)},${num(tz)}]);`;
    } else {
      expr = `__bv.apply(${JSON.stringify(op)});`;
    }
    for (const e of mouseEventsForFrame(plan, i)) await c.send("Input.dispatchMouseEvent", { ...e, pointerType: "mouse" });
    await ev(c, `(async()=>{${expr}window.__sf.tick(${DT});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`);
  };

  if (DEBUG) {
    await applyFrame(0);
    await snap("dbg_f0");
    for (let i = 1; i <= 70; i++) await applyFrame(i);
    await snap("dbg_f70"); // just after the first click
    cleanup();
    process.exit(0);
  }

  const stillSet = new Set(STILL_FRAMES);
  console.log(`[bv] ${STILLS ? "stills" : "capture"} run: frames ${FROM}..${TO}`);
  for (let i = FROM; i < TO; i++) {
    await applyFrame(i);
    const want = STILLS ? stillSet.has(i) : true;
    if (want) {
      const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 92, fromSurface: true });
      const name = STILLS ? `still_${String(i).padStart(5, "0")}.jpg` : `frame_${String(i).padStart(5, "0")}.jpg`;
      writeFileSync(path.join(STILLS ? WORK : RAW, name), Buffer.from(shot.data, "base64"));
    }
    if (i % 120 === 0) console.log(`[bv]   ${i}/${TOTAL} (${(i * DT).toFixed(1)}s)`);
  }

  if (!STILLS) {
    const n = (await readdir(RAW)).filter((f) => f.startsWith("frame_")).length;
    if (n < TOTAL * 0.98) throw new Error(`only ${n}/${TOTAL} frames`);
    console.log(`[bv] captured ${n} frames; encoding`);
    await encode();
    console.log(`[bv] wrote ${path.relative(ROOT, OUT_MP4)}`);
  } else {
    console.log(`[bv] stills in ${WORK}`);
  }
  cleanup();
  process.exit(0);
}
main().catch((e) => { cleanup(); console.error("[bv] FAIL", e); process.exit(1); });
