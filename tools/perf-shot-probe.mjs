// Boot headless, settle at a stop, measure frame p50 + save a PNG screenshot.
// Visual + timing sanity in one shot.
//   node tools/perf-shot-probe.mjs [downtown|victorian|meadow|marina|tea|teaBridge|teaInterior|teaMotion|teaServe] [outName]
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Keep Chrome's busy profile outside the Vite root by default. Putting it in
// `.data` makes the dev watcher reload on profile writes and corrupts timings.
const requestedOut = process.env.SF_PROBE_OUT ?? path.join(process.env.TMPDIR ?? "/tmp", "sf-perf-shot");
const OUT = path.isAbsolute(requestedOut) ? requestedOut : path.resolve(ROOT, requestedOut);
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5199";
const FIXED_TIME = process.env.SF_TIME === undefined ? null : Number(process.env.SF_TIME);
const W = Number(process.env.SF_W ?? 1600), H = Number(process.env.SF_H ?? 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let liveDev = null;
let liveChrome = null;
let liveCdp = null;

const WHERE = process.argv[2] ?? "downtown";
const NAME = process.argv[3] ?? WHERE;
const STOPS = {
  downtown: { x: 4117, z: 200, facing: Math.PI },
  victorian: { x: 900, z: 2400, facing: 0.4 },
  meadow: { x: -2260, z: 2450, facing: 2.4 },
  marina: { x: -700, z: -2380, facing: 0.6 },
  embarcadero: { x: 3950, z: -1050, facing: 2.6 },
  fidi: { x: 4260, z: 420, facing: -2.4 },
  tea: { x: -2282.4, z: 2171.4, facing: -1.57 },
  teaBridge: { x: -2280, z: 2195, facing: -1.25 },
  teaInterior: { x: -2272, z: 2168.2, facing: -2.53 },
  teaMotion: { x: -2282.4, z: 2171.4, facing: -1.57 },
  teaServe: { x: -2282.4, z: 2171.4, facing: -1.57 }
};
const STOP = WHERE === "spawn" ? null : (STOPS[WHERE] ?? STOPS.downtown);

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
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
  return r.result?.value;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  liveDev = dev;
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [
    `--user-data-dir=${path.join(OUT, "chrome-" + NAME)}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart=1&fullfps=1&profile=1`
  ], { cwd: ROOT, stdio: "ignore" });
  liveChrome = proc;
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
  liveCdp = c;
  await c.open();
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device&&window.__sf.renderIdle?.()&&window.__sf.worldArrival?.snapshot?.state==='idle'&&!window.__sf.player.worldArrivalHeld)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("app never ready");

  // Cross-city stops must use the same covered arrival path as the live map.
  // The coordinator primes destination visuals and collision before committing;
  // a direct pre-prime player teleport can fall through the newly streamed world.
  if (STOP) {
    const beforeGeneration = await ev(c, `(()=>{const sf=window.__sf;const generation=sf.worldArrival.snapshot.generation;sf.teleportToTarget(${STOP.x},${STOP.z},'performance probe');return generation;})()`);
    const arrivalT0 = Date.now();
    let arrived = false;
    while (Date.now() - arrivalT0 < 180000) {
      try {
        if (await ev(c, `(()=>{const a=window.__sf.worldArrival.snapshot;return a.generation>${beforeGeneration}&&a.state==='idle'&&!window.__sf.player.worldArrivalHeld;})()`)) {
          arrived = true;
          break;
        }
      } catch {}
      await sleep(400);
    }
    if (!arrived) throw new Error(`arrival never settled for ${WHERE}`);
  }

  // The new massive-world boot intentionally starts regional foliage only
  // after destination-critical streaming and a quiet background window. A
  // meadow benchmark is meaningful only once both regional owners have
  // finished their detached compile and joined the live scene.
  if (WHERE === "meadow") {
    const foliageT0 = Date.now();
    let foliageReady = false;
    while (Date.now() - foliageT0 < 300000) {
      try {
        if (await ev(c, `(()=>{const sf=window.__sf;return !!(sf.garden?.group?.parent&&sf.wildlands?.groups?.length&&sf.wildlands.groups.every((group)=>group.parent));})()`)) {
          foliageReady = true;
          break;
        }
      } catch {}
      await sleep(500);
    }
    if (!foliageReady) throw new Error("meadow foliage never joined the live scene");
    // Progressive grass generation is deliberately frame-budgeted. Compare
    // steady-state rendering only after the requested ring has finished; older
    // baselines do not expose this method, so optional chaining keeps the same
    // probe valid on both sides of the A/B.
    await ev(c, `(async()=>{await window.__sf.wildlands?.grass?.whenSettled?.();return true;})()`);
  }
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);
  if (Number.isFinite(FIXED_TIME)) {
    await ev(c, `(()=>{const sky=window.__sf.sky;sky.cycleEnabled=false;sky.setTimeOfDay(${FIXED_TIME});return true;})()`);
  }
  await ev(c, `(()=>{const sf=window.__sf;sf.hud?.setHidden?.(true);sf.remotes?.setTagsVisible?.(false);for(const avatar of sf.remotes?.avatars?.values?.()??[])avatar.root.visible=false;const loading=document.getElementById('loading');if(loading)loading.style.display='none';return true;})()`);
  // Snap the final few metres only after the destination neighbourhood is live,
  // keeping historical comparison shots on their exact authored camera stop.
  if (STOP) await ev(c, `(()=>{const sf=window.__sf;const gy=sf.map.groundTop(${STOP.x},${STOP.z});sf.player.teleportTo({x:${STOP.x},y:gy+1.1,z:${STOP.z},facing:${STOP.facing},mode:'walk'});sf.chase.yaw=${STOP.facing};sf.chase.pitch=0.26;sf.chase.zoom=0.82;return true;})()`);
  // settle with fence-yields so streaming completes
  for (let k = 0; k < 25; k++) {
    await ev(c, `(async()=>{const sf=window.__sf;const dev=sf.renderer.backend.device;for(let i=0;i<30;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}return true;})()`);
    await sleep(250);
  }
  if (WHERE === "tea" || WHERE === "teaMotion" || WHERE === "teaServe") {
    await ev(c, `(()=>{const sf=window.__sf;const o=sf.scene.getObjectByName('tea_master_hiro');if(!o)return false;const p=o.getWorldPosition(new sf.THREE.Vector3());const gy=sf.map.groundTop(p.x,p.z);const eye=[p.x-3.25,gy+1.95,p.z+1.8],target=[p.x,gy+1.2,p.z];window.__probeView={eye,target};window.__sfFreeCam?.(eye,target);return true;})()`);
  } else if (WHERE === "teaBridge") {
    await ev(c, `(()=>{const sf=window.__sf;const o=sf.scene.getObjectByName('japanese_tea_garden_drum_bridge');if(!o)return false;const box=new sf.THREE.Box3().setFromObject(o);const p=box.getCenter(new sf.THREE.Vector3());const eye=[p.x+7.5,p.y+3.2,p.z+7.4],target=[p.x,p.y+0.55,p.z];window.__probeView={eye,target};window.__sfFreeCam?.(eye,target);return true;})()`);
  } else if (WHERE === "teaInterior") {
    await ev(c, `(()=>{const sf=window.__sf;const gallery=sf.scene.getObjectByName('tea_house_original_fusuma_gallery');if(!gallery)return false;const eye=gallery.localToWorld(new sf.THREE.Vector3(0,1.72,3.25)).toArray();const target=gallery.localToWorld(new sf.THREE.Vector3(0,2.03,-4.18)).toArray();window.__probeView={eye,target};window.__sfFreeCam?.(eye,target);return true;})()`);
  }
  const isTeaView = WHERE === "tea" || WHERE === "teaBridge" || WHERE === "teaInterior" || WHERE === "teaMotion" || WHERE === "teaServe";
  if (isTeaView) {
    await ev(c, `(async()=>{const sf=window.__sf;const dev=sf.renderer.backend.device;for(let i=0;i<12;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}return true;})()`);
  }
  if (WHERE === "teaMotion") {
    await ev(c, `(async()=>{
      const sf=window.__sf,dev=sf.renderer.backend.device,guide=()=>sf.japaneseTeaGarden.debugState().guide;
      const actor=sf.scene.getObjectByName('tea_master_hiro');
      const playerState=()=>({x:sf.player.position.x,y:sf.player.position.y,z:sf.player.position.z});
      const interact=()=>sf.japaneseTeaGarden.interact(playerState(),'walk');
      let prev=guide().hiro,maxJointStep=0,maxRootStep=0,serveEnd=null;
      const phases=new Set([guide().phase]),actions=new Set([prev.action]);
      interact();
      for(let frame=0;frame<390;frame++){
        if(frame===70||frame===140||frame===210)interact();
        await Promise.resolve();sf.tick(1/60);await dev.queue.onSubmittedWorkDone();
        const state=guide(),now=state.hiro;phases.add(state.phase);actions.add(now.action);
        for(let i=0;i<now.joints.length;i++){const d=Math.atan2(Math.sin(now.joints[i]-prev.joints[i]),Math.cos(now.joints[i]-prev.joints[i]));maxJointStep=Math.max(maxJointStep,Math.abs(d));}
        maxRootStep=Math.max(maxRootStep,Math.hypot(now.position[0]-prev.position[0],now.position[2]-prev.position[2]));
        if(now.action==='serve')serveEnd={left:now.cupToLeftHand,right:now.cupToRightHand};
        prev=now;
      }
      window.__probeMotion={maxJointStepRad:+maxJointStep.toFixed(5),maxJointStepDeg:+(maxJointStep*180/Math.PI).toFixed(3),maxRootStep:+maxRootStep.toFixed(5),phases:[...phases],actions:[...actions],serveEnd};
      return window.__probeMotion;
    })()`);
  } else if (WHERE === "teaServe") {
    await ev(c, `(async()=>{const sf=window.__sf,dev=sf.renderer.backend.device,p=()=>({x:sf.player.position.x,y:sf.player.position.y,z:sf.player.position.z});sf.japaneseTeaGarden.interact(p(),'walk');for(let i=0;i<75;i++){await Promise.resolve();sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}sf.japaneseTeaGarden.interact(p(),'walk');for(let i=0;i<90;i++){await Promise.resolve();sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}return sf.japaneseTeaGarden.debugState().guide;})()`);
  }
  const m = await ev(c, `(async()=>{
    const dev=window.__sf.renderer.backend.device; const cpu=[], tot=[];
    for(let i=0;i<40;i++){ window.__sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); }
    for(let i=0;i<90;i++){
      const a=performance.now(); window.__sf.tick(1/60);
      const b=performance.now(); await dev.queue.onSubmittedWorkDone();
      cpu.push(b-a); tot.push(performance.now()-a);
    }
    const percentile=(arr,p)=>{arr=[...arr].sort((x,y)=>x-y);return +arr[Math.min(arr.length-1,Math.floor((arr.length-1)*p))].toFixed(2);};
    const sf=window.__sf;
    const root=sf.scene.getObjectByName('japanese_tea_garden');
    const geometries=new Set(),materials=new Set();let meshes=0,instances=0,triangles=0;
    root?.traverse((o)=>{if(!o.isMesh)return;meshes++;const g=o.geometry;const compactCount=g?.isInstancedBufferGeometry&&Number.isFinite(g.instanceCount)?g.instanceCount:1;const count=o.isInstancedMesh?o.count:compactCount;instances+=count;geometries.add(g.uuid);const ma=Array.isArray(o.material)?o.material:[o.material];for(const value of ma)materials.add(value.uuid);const base=g.index?g.index.count/3:(g.attributes.position?.count??0)/3;triangles+=base*count;});
    const citygenStats=sf.citygenRing?.current?.stats?.()??null;
    const citygenNear=sf.citygenRing?.current?.debugEntriesNear?.(
      sf.player.position.x,
      sf.player.position.z,
      citygenStats?.detailCoreRadius??80
    )??[];
    return {
      cpu:percentile(cpu,.5), cpuP90:percentile(cpu,.9),
      tot:percentile(tot,.5), totP90:percentile(tot,.9),
      player:sf.player.position.toArray(), camera:sf.camera.position.toArray(),
      render:{...sf.renderer.info.render}, memory:{...sf.renderer.info.memory},
      citygen:{
        stats:citygenStats,
        nearCount:citygenNear.length,
        nearDetailed:citygenNear.filter((entry)=>entry.state==='detail').length,
        nearMissing:citygenNear.filter((entry)=>entry.state!=='detail').length,
        nearEntries:citygenNear
      },
      garden:{meshes,instances,triangles:Math.round(triangles),geometries:geometries.size,materials:materials.size},
      tea:sf.japaneseTeaGarden?.debugState?.() ?? null,
      motion:window.__probeMotion??null
    };
  })()`);
  if (isTeaView) {
    await ev(c, `(async()=>{const sf=window.__sf,v=window.__probeView;if(!v)return false;for(const avatar of sf.remotes?.avatars?.values?.()??[])avatar.root.visible=false;for(const mesh of Object.values(sf.player.meshes??{}))mesh.visible=false;sf.worldCursor?.setEnabled?.(false);const canvas=sf.renderer.domElement;for(const el of document.body.querySelectorAll('*')){if(el!==canvas&&!el.contains(canvas))el.style.visibility='hidden';}sf.camera.position.fromArray(v.eye);sf.camera.up.set(0,1,0);sf.camera.lookAt(...v.target);sf.camera.updateMatrixWorld();sf.pipeline.render();await sf.renderer.backend.device.queue.onSubmittedWorkDone();return true;})()`);
  }
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, `${NAME}.png`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify(m, null, 2));
  console.log(`[shot:${WHERE}] frame p50/p90 ${m.tot}/${m.totP90}ms  cpu ${m.cpu}/${m.cpuP90}ms  -> ${file}`);
  console.log(JSON.stringify(m));
  c.close(); proc.kill(); if (dev) dev.kill();
  liveCdp = null; liveChrome = null; liveDev = null;
  process.exitCode = 0;
}
main().catch((e) => {
  console.error("[probe] FAIL", e);
  liveCdp?.close();
  liveChrome?.kill();
  liveDev?.kill();
  process.exitCode = 1;
});
