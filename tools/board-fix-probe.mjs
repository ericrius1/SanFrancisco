// Headless board-climb probe. Teleports to a steep street, switches to board
// mode, holds W for 6s and measures horizontal distance travelled + deck pitch
// (forward.y, +ve = nose up). Then a flat ride + ollie sanity (vy peak).
//   node tools/board-fix-probe.mjs <label>        (label = before | after)
// Env: SF_PROBE_URL (own vite; NOT 5179), SF_PROBE_OUT (default .data/board-fix)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Final resting place the caller asked for (inside the project).
const FINAL_OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/board-fix");
// ALL live writes (chrome profile, screenshots, json) go OUTSIDE the project:
// vite watches the project tree (incl. .data/) and a single file write there
// triggers a full page reload that destroys the WebGPU renderer mid-drive. We
// copy the artifacts back into FINAL_OUT only after the browser is closed.
const TMP = path.join(process.env.TMPDIR ?? "/tmp", "sf-board-probe");
const OUT = path.join(TMP, "out");
const PROFILE_ROOT = path.join(TMP, "profile");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5235";
const W = 1280, H = 800;
const LABEL = process.argv[2] ?? "run";
const HILL = { x: Number(process.env.SF_HILL_X ?? 3376), z: Number(process.env.SF_HILL_Z ?? -976) };
const FLAT = { x: Number(process.env.SF_FLAT_X ?? -700), z: Number(process.env.SF_FLAT_Z ?? -2380) };
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
  try { await waitHttp(SERVER_URL, 2000, "existing vite"); return null; } catch {}
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port);
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"]
  });
  await waitHttp(SERVER_URL, 90000, "vite");
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
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 800)}`);
  return r.result?.value;
}
async function shot(c, name) {
  const s = await c.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, name);
  writeFileSync(file, Buffer.from(s.data, "base64"));
  return file;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDev();
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [
    `--user-data-dir=${path.join(PROFILE_ROOT, LABEL + "-" + Date.now())}`, "--headless=new", `--remote-debugging-port=${port}`,
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
  await c.open();
  c._ws?.addEventListener?.("message", () => {});
  await c.send("Page.enable"); await c.send("Runtime.enable");
  // surface boot errors
  c.send("Log.enable").catch(() => {});
  const wsAny = page.webSocketDebuggerUrl;
  const T0 = Date.now();
  const ts = () => ((Date.now() - T0) / 1000).toFixed(1) + "s";
  const dbg = new WebSocket(wsAny);
  dbg.addEventListener("message", (e) => {
    try {
      const m = JSON.parse(e.data.toString());
      if (m.method === "Runtime.exceptionThrown") console.log(ts(), "[page-exc]", (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "").slice(0, 200));
      if (m.method === "Page.frameNavigated" && !m.params?.frame?.parentId) console.log(ts(), "[NAVIGATED]", m.params.frame.url);
      if (m.method === "Page.frameStartedLoading") console.log(ts(), "[loading-start]");
      if (m.method === "Inspector.targetCrashed") console.log(ts(), "[CRASHED]");
    } catch {}
  });
  await new Promise((r) => dbg.addEventListener("open", r, { once: true }));
  dbg.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
  dbg.send(JSON.stringify({ id: 2, method: "Page.enable" }));
  dbg.send(JSON.stringify({ id: 3, method: "Inspector.enable" }));
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  let ready = false;
  let dumped = 0;
  while (Date.now() - t0 < 180000) {
    try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device)`)) { ready = true; break; } } catch (e) { if (Date.now() - t0 > 8000 && !dumped) { console.log("[ready-eval-err]", String(e).slice(0, 200)); dumped = 1; } }
    if (Date.now() - t0 > 15000 && dumped < 2) {
      dumped = 2;
      try { console.log("[state]", await ev(c, `JSON.stringify({sf:typeof window.__sf, hasPlayer:!!(window.__sf&&window.__sf.player), hasRenderer:!!(window.__sf&&window.__sf.renderer), hasBackend:!!(window.__sf&&window.__sf.renderer&&window.__sf.renderer.backend), hasDevice:!!(window.__sf&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device), gpu: !!navigator.gpu, title: document.title, body: (document.body&&document.body.innerText||'').slice(0,120)})`)); } catch (e) { console.log("[state-err]", String(e).slice(0, 200)); }
    }
    await sleep(600);
  }
  if (!ready) throw new Error("app never ready");
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);

  // helpers are re-declared inside EVERY eval (no persisted window state): a vite
  // full-reload could wipe globals mid-run, but each eval re-derives from __sf.
  const P = `const sf=window.__sf; const dev=sf.renderer.backend.device;
    const tick=async(n)=>{ for(let i=0;i<n;i++){ sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); } };
    const key=(code,down)=> window.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{code,bubbles:true}));
    const fwdY=()=>{ const q=sf.player.quaternion; return 2*(q.w*q.x - q.y*q.z); };`;

  // warm-up: let physics async init (collider index / landmark fetch) + tile
  // streaming finish before we drive. Node-side sleeps yield to those promises.
  for (let k = 0; k < 16; k++) {
    try { await ev(c, `(async()=>{ ${P} await tick(20); return true; })()`); } catch {}
    await sleep(250);
  }

  // ---- HILL CLIMB ----  (setup + first 3 s in one eval so the start pos and the
  // held KeyW survive as locals even if a reload struck between evals)
  const setup = await ev(c, `(async()=>{ ${P}
    const X=${HILL.x}, Z=${HILL.z};
    const gy=sf.map.groundHeight(X,Z);
    sf.player.teleportTo({x:X,y:gy+1.6,z:Z,facing:0,mode:'walk'});
    await tick(30);
    const e=3, py=sf.player.position.y;
    const rg=(x,z)=>sf.map.rideGround(x,z,py);
    const gx=rg(X+e,Z)-rg(X-e,Z), gz=rg(X,Z+e)-rg(X,Z-e);
    const gl=Math.hypot(gx,gz)||1e-6, ux=gx/gl, uz=gz/gl;
    const grade=Math.hypot(gx,gz)/(2*e);
    const facing=Math.atan2(-ux,-uz);   // deck fwd = (-sin,-cos) points uphill
    const baseGround=rg(X,Z);
    sf.player.teleportTo({x:X,y:gy+1.6,z:Z,facing,mode:'board'});
    await tick(45); // settle on the hover spring, no throttle
    const sx=sf.player.position.x, sz=sf.player.position.z;
    window.__st={sx,sz,baseGround};
    // drive W first 3 s, sample deck pitch (fwd.y)
    key('KeyW',true);
    let fyMin=9,fyMax=-9,fySum=0;
    for(let i=0;i<180;i++){ await tick(1); const fy=fwdY(); if(fy<fyMin)fyMin=fy; if(fy>fyMax)fyMax=fy; fySum+=fy; }
    return {grade:+grade.toFixed(3), gradePct:+(grade*100).toFixed(1), facing:+facing.toFixed(3),
            baseGround:+baseGround.toFixed(2), sx:+sx.toFixed(2), sz:+sz.toFixed(2),
            dist3s:+Math.hypot(sf.player.position.x-sx, sf.player.position.z-sz).toFixed(2),
            fyMin:+fyMin.toFixed(3), fyMax:+fyMax.toFixed(3), fyAvg3:+(fySum/180).toFixed(3),
            speed3s:+Math.hypot(sf.player.velocity.x,sf.player.velocity.z).toFixed(2)};
  })()`);
  const midShot = await shot(c, `climb-mid-${LABEL}.png`);

  // continue 3 more s (KeyW re-asserted; start read back from window.__st)
  const seg2 = await ev(c, `(async()=>{ ${P}
    const st=window.__st;
    key('KeyW',true);
    let fySum=0;
    for(let i=0;i<180;i++){ await tick(1); fySum+=fwdY(); }
    key('KeyW',false); await tick(2);
    const py=sf.player.position.y;
    const rg=(x,z)=>sf.map.rideGround(x,z,py);
    return {dist6s:+Math.hypot(sf.player.position.x-st.sx, sf.player.position.z-st.sz).toFixed(2),
            fyAvg6:+(fySum/180).toFixed(3),
            fx:+sf.player.position.x.toFixed(2), fz:+sf.player.position.z.toFixed(2),
            climbedH:+(rg(sf.player.position.x,sf.player.position.z)-st.baseGround).toFixed(2)};
  })()`);
  const endShot = await shot(c, `climb-end-${LABEL}.png`);

  // ---- FLAT RIDE + OLLIE ----
  const flat = await ev(c, `(async()=>{ ${P}
    const X=${FLAT.x}, Z=${FLAT.z};
    const gy=sf.map.groundHeight(X,Z);
    sf.player.teleportTo({x:X,y:gy+1.6,z:Z,facing:0,mode:'board'});
    await tick(45);
    const sx=sf.player.position.x, sz=sf.player.position.z;
    key('KeyW',true);
    for(let i=0;i<90;i++){ await tick(1); }               // ~1.5s run-up
    const runDist=Math.hypot(sf.player.position.x-sx, sf.player.position.z-sz);
    const yBefore=sf.player.position.y;
    key('Space',true); await tick(1); key('Space',false); // ollie
    let vyPeak=-9, yPeak=-999;
    for(let i=0;i<45;i++){ await tick(1); if(sf.player.velocity.y>vyPeak)vyPeak=sf.player.velocity.y; if(sf.player.position.y>yPeak)yPeak=sf.player.position.y; }
    key('KeyW',false); await tick(2);
    return {runDist:+runDist.toFixed(2), vyPeak:+vyPeak.toFixed(2), airGain:+(yPeak-yBefore).toFixed(2),
            grade:+(Math.abs(sf.map.rideGround(X+3,Z,gy)-sf.map.rideGround(X-3,Z,gy))/6).toFixed(3)};
  })()`);

  const result = { label: LABEL, hill: HILL, flat: FLAT, setup, seg2, flat_test: flat, midShot, endShot };
  writeFileSync(path.join(OUT, `result-${LABEL}.json`), JSON.stringify(result, null, 2));
  console.log("[RESULT " + LABEL + "] grade=" + setup.gradePct + "% dist3s=" + setup.dist3s + "m dist6s=" + seg2.dist6s + "m climbedH=" + seg2.climbedH + "m  pitch fwd.y avg0-3s=" + setup.fyAvg3 + " avg3-6s=" + seg2.fyAvg6 + " (range " + setup.fyMin + ".." + setup.fyMax + ")  | flat runDist=" + flat.runDist + "m vyPeak=" + flat.vyPeak + " airGain=" + flat.airGain);
  console.log(JSON.stringify(result, null, 2));
  c.close(); proc.kill(); if (dev) dev.kill();
  // browser + vite are down now: safe to drop artifacts into the project.
  mkdirSync(FINAL_OUT, { recursive: true });
  for (const f of [`climb-mid-${LABEL}.png`, `climb-end-${LABEL}.png`, `result-${LABEL}.json`]) {
    try { cpSync(path.join(OUT, f), path.join(FINAL_OUT, f)); } catch {}
  }
  console.log("[artifacts] copied to " + FINAL_OUT);
  process.exit(0);
}
main().catch((e) => { console.error("[board-probe] FAIL", e); process.exit(1); });
