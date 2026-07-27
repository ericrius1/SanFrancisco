// Third-person swimming in the OPEN OCEAN: does the body read as being IN the
// water, and does the stroke read as swimming?
//
// tools/sutro-swim-probe.mjs already covers the pool (a registered swim volume,
// still surface, built basin). This one covers the bay/ocean case, which is a
// different code path: `waterHeight()` swell instead of a flat surfaceY, the
// displaced hero/near sheets instead of a static sheet, and the chase camera
// rather than a freecam — i.e. exactly what the player actually sees.
//
// Captures a BURST across the stroke cycle, because a single frame cannot show
// whether an animation cycles, and reports the geometry (body vs waterline)
// that decides whether the swimmer looks submerged.
//
//   node tools/swim-look-probe.mjs [spot] [tag]
//
// env: SF_PROBE_URL (default http://127.0.0.1:5241), SF_PROBE_OUT, SF_HOURS,
//      SF_FRAMES (burst length, default 6), SF_STRIDE (ticks between frames)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? path.join(process.env.TMPDIR ?? "/tmp", "sf-swim-look"));
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5241";
const W = Number(process.env.SF_W ?? 1600);
const H = Number(process.env.SF_H ?? 1000);
const HOUR = Number(process.env.SF_HOURS ?? 15);
const FRAMES = Number(process.env.SF_FRAMES ?? 6);
const STRIDE = Number(process.env.SF_STRIDE ?? 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPOTS = {
  // Off the Lands End shore — the report's location, and deep enough that the
  // walk controller's `bed < waterY - 1.0` swim test passes.
  landsEnd: { x: -6250, z: 1117 },
  // Ocean Beach shallows: the swim/wade boundary, where a swimmer is most
  // likely to look like they are lying on the ground.
  shallow: { x: -6060, z: 3200 },
  // Open bay, deep water, no terrain nearby.
  bay: { x: -700, z: -2440 }
};
const WHERE = process.argv[2] ?? "landsEnd";
const TAG = process.argv[3] ?? WHERE;
const SPOT = SPOTS[WHERE] ?? SPOTS.landsEnd;

const findChrome = () => {
  for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)) {
    if (c.includes("/") && !existsSync(c)) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
};
const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
async function waitHttp(url, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); }
  throw new Error(`timeout ${url}`);
}
class Cdp {
  #ws; #id = 1; #p = new Map();
  constructor(u) { this.#ws = new WebSocket(u); }
  async open() {
    await new Promise((res, rej) => {
      this.#ws.addEventListener("open", res, { once: true });
      this.#ws.addEventListener("error", rej, { once: true });
    });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) return;
      const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.#p.set(id, { res, rej, method }));
  }
  close() { this.#ws.close(); }
}
async function ev(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
}
// Page.captureScreenshot returns the COMPOSITOR's last presented surface, not
// the last WebGPU submit — see the same note in tools/water-look-probe.mjs.
async function capture(c) {
  let prev = null;
  for (let i = 0; i < 6; i++) {
    await ev(c, `(async()=>{const sf=window.__sf;sf.pipeline.render();
      await sf.renderer.backend.device.queue.onSubmittedWorkDone();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`);
    await sleep(200);
    const { data } = await c.send("Page.captureScreenshot", { format: "png" });
    if (prev !== null && data === prev) return data;
    prev = data;
  }
  return prev;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  await waitHttp(SERVER_URL, 4000);
  const port = await freePort();
  const proc = spawn(findChrome(), [
    `--user-data-dir=${path.join(OUT, "chrome-" + TAG)}`, "--headless=new",
    `--remote-debugging-port=${port}`, "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`,
    `${SERVER_URL}/?autostart=1&fullfps=1&profile=1`
  ], { cwd: ROOT, stdio: "ignore" });

  let page;
  await sleep(2500);
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
  await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Input.enable").catch(() => {});
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) {
    try {
      if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer?.backend?.device&&window.__sf.renderIdle?.()&&window.__sf.worldArrival?.snapshot?.state==='idle'&&!window.__sf.player.worldArrivalHeld)`)) { ready = true; break; }
    } catch {}
    await sleep(600);
  }
  if (!ready) throw new Error("app never ready");

  const gen = await ev(c, `(()=>{const sf=window.__sf;const g=sf.worldArrival.snapshot.generation;sf.teleportToTarget(${SPOT.x},${SPOT.z},'swim look');return g;})()`);
  const aT0 = Date.now();
  while (Date.now() - aT0 < 180000) {
    if (await ev(c, `(()=>{const a=window.__sf.worldArrival.snapshot;return a.generation>${gen}&&a.state==='idle'&&!window.__sf.player.worldArrivalHeld;})()`)) break;
    await sleep(400);
  }

  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  // worldArrival reports "idle" while the arrival FLIGHT is still in the air:
  // the coordinator keeps re-asserting plane mode and driving the capsule at
  // ~95 m/s, silently overriding any teleport issued into that window. Wait for
  // the aircraft to actually be gone before touching the player.
  const fT0 = Date.now();
  while (Date.now() - fT0 < 120000) {
    const st = await ev(c, `(async()=>{const sf=window.__sf,dev=sf.renderer.backend.device;
      for(let i=0;i<30;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}
      return {mode:sf.player.mode,speed:Math.hypot(sf.player.velocity.x,sf.player.velocity.z)};})()`);
    if (st.mode === "walk" && st.speed < 6) { console.log(`[swim] arrival flight landed: ${JSON.stringify(st)}`); break; }
    await sleep(300);
  }

  await ev(c, `(()=>{const sf=window.__sf;sf.dynRes?.setEnabled?.(false);sf.hud?.setHidden?.(true);
    sf.remotes?.setTagsVisible?.(false);
    for(const a of sf.remotes?.avatars?.values?.()??[])a.root.visible=false;
    const l=document.getElementById('loading');if(l)l.style.display='none';
    const canvas=sf.renderer.domElement;
    for(const el of document.body.querySelectorAll('*')){if(el!==canvas&&!el.contains(canvas))el.style.visibility='hidden';}
    sf.sky.setCivilTime({year:2026,month:7,day:26,hour:${HOUR}});return true;})()`);

  // Water sheets must be PARENTED, not merely visible — warmHiddenRoot forces
  // visible=true on a detached root (see tools/water-look-probe.mjs).
  const wT0 = Date.now();
  while (Date.now() - wT0 < 120000) {
    if (await ev(c, `(()=>{const w=window.__sf.water;return !!w.near.parent&&!!w.far.parent&&w.near.visible;})()`)) break;
    await ev(c, `(async()=>{const sf=window.__sf;for(let i=0;i<10;i++){sf.tick(1/60);await sf.renderer.backend.device.queue.onSubmittedWorkDone();}return true;})()`);
    await sleep(400);
  }

  // Drop the capsule in and let buoyancy settle it to the swim waterline.
  // teleportToTarget FLIES the player in, so they arrive in `plane` mode at
  // ~95 m/s and the arrival "idle" flag goes true before the flight has landed.
  // A single teleportTo issued into that window is simply overridden by the
  // aircraft. Settle first, then teleport, then ASSERT the embodiment actually
  // took — otherwise every reading below describes a plane, not a swimmer.
  for (let attempt = 0; attempt < 12; attempt++) {
    await ev(c, `(async()=>{const sf=window.__sf,dev=sf.renderer.backend.device;
      for(let i=0;i<60;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}
      sf.player.teleportTo({x:${SPOT.x},y:1.5,z:${SPOT.z},facing:1.2,mode:'walk'});
      sf.chase.yaw=1.2; sf.chase.pitch=0.0; sf.chase.zoom=0.55; // pitch 0: aim.y feeds vSwim, so a pitched camera makes W dive
      for(let i=0;i<120;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}
      return true;})()`);
    const st = await ev(c, `(()=>({mode:window.__sf.player.mode,swim:window.__sf.player.swimming}))()`);
    if (st.mode === "walk") { console.log(`[swim] embodiment settled: ${JSON.stringify(st)}`); break; }
    await sleep(400);
  }

  // Drive the swimmer through the Input SET rather than synthetic key events.
  // CDP-dispatched keys were observed to knock the embodiment back into `plane`
  // at 95 m/s; `input.keys` is the same rail the controller reads every frame
  // (src/core/input.ts:157), so this is the real movement path with none of the
  // focus/binding ambiguity. A moving swimmer is required: the stroke cadence
  // and the wake rings are both speed-driven now.
  if (!process.env.SF_IDLE) {
    await ev(c, `(()=>{window.__sf.input.keys.add('KeyW');return [...window.__sf.input.keys];})()`);
    await ev(c, `(async()=>{const sf=window.__sf,dev=sf.renderer.backend.device;
      for(let i=0;i<150;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}return true;})()`);
  }

  const shots = [];
  for (let f = 0; f < FRAMES; f++) {
    const state = await ev(c, `(async()=>{const sf=window.__sf,dev=sf.renderer.backend.device;
      for(let i=0;i<${STRIDE};i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}
      const p=sf.player.position, t=performance.now()/1000;
      const wy=sf.waterHeightAt?sf.waterHeightAt(p.x,p.z):(sf.map.waterHeight?sf.map.waterHeight(p.x,p.z,t):null);
      const bed=sf.map.groundTop(p.x,p.z);
      return {swimming:sf.player.swimming,
        player:[+p.x.toFixed(2),+p.y.toFixed(3),+p.z.toFixed(2)],
        waterY: wy===null?null:+wy.toFixed(3), bed:+bed.toFixed(2),
        submersion: wy===null?null:+(wy-p.y).toFixed(3),
        camY:+sf.camera.position.y.toFixed(2),
        speed:+Math.hypot(sf.player.velocity.x,sf.player.velocity.z).toFixed(3),
        mode:sf.player.mode,
        rig:(()=>{const m=sf.player.meshes&&sf.player.meshes.walk;if(!m)return null;
          const out={};m.traverse(o=>{if(/hip|torso|head|armL|armR|legL/i.test(o.name))
            out[o.name]=[+o.rotation.x.toFixed(3),+o.rotation.y.toFixed(3),+o.rotation.z.toFixed(3)];});
          out.__root=[+m.rotation.x.toFixed(3),+m.rotation.y.toFixed(3),+m.rotation.z.toFixed(3)];
          out.__names=[];m.traverse(o=>{if(o.name)out.__names.push(o.name);});
          out.__names=out.__names.slice(0,14);
          return out;})()};})()`);
    writeFileSync(path.join(OUT, `${TAG}-${f}.png`), Buffer.from(await capture(c), "base64"));
    shots.push({ frame: f, ...state });
    console.log(`[swim] ${TAG}-${f}.png  ${JSON.stringify(state)}`);
  }

  writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify({ spot: WHERE, SPOT, shots }, null, 2));
  c.close(); proc.kill(); process.exit(0);
}

main().catch((e) => { console.error("[swim] FAILED:", e.message); process.exit(1); });
