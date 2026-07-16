// Does the wildlands grass ring follow the CAMERA instead of the player? Hold the
// player still on a flat spot, orbit the free camera around them, and watch the
// grass instance centroid + screenshot. If the centroid slides with the camera
// (and grass re-scatters when you only look around), the ring is camera-locked.
//
//   node tools/grass-orbit.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/grass-orbit");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5192";
const TIME = Number(process.env.SF_TIME ?? 13.5);
const [FX, FZ] = (process.env.SF_XZ ?? "-3760,2250").split(",").map(Number); // flat GG Park speedway meadow
const W = 1500, H = 850;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isFile(p) { try { return existsSync(p); } catch { return false; } }
async function findChrome() { for (const c of [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) { if (c.includes("/") && !(await isFile(c))) continue; return c; } throw new Error("No Chrome"); }
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); }); }
async function waitHttp(url, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {} await sleep(300); } throw new Error(`timeout ${label}`); }
async function startDevIfNeeded() { try { await waitHttp(SERVER_URL, 2500, "vite"); return null; } catch {} const relay = await freePort(); const vitePort = Number(new URL(SERVER_URL).port); console.log(`[probe] starting Vite ${SERVER_URL}`); const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"] }); await waitHttp(SERVER_URL, 60000, "vite"); return child; }
class Cdp { #ws; #id = 1; #p = new Map(); constructor(u) { this.#ws = new WebSocket(u); } async open() { await new Promise((res, rej) => { this.#ws.addEventListener("open", res, { once: true }); this.#ws.addEventListener("error", rej, { once: true }); }); this.#ws.addEventListener("message", (e) => { const m = JSON.parse(e.data.toString()); if (!m.id) { if (this.onEvent) this.onEvent(m); return; } const p = this.#p.get(m.id); if (!p) return; this.#p.delete(m.id); m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {}); }); } send(method, params = {}) { const id = this.#id++; this.#ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.#p.set(id, { res, rej, method })); } close() { this.#ws.close(); } }
async function ev(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`); return r.result?.value; }
const frame = (dt) => `(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()`;
async function settle(c, n) { for (let i = 0; i < n; i++) { await ev(c, frame(1 / 60)); await sleep(45); } }

// centroid of the wildlands grass instances (the ring center) + count. The
// compact path stores anchorXYZ/yaw directly instead of a 4x4 instance matrix.
const CENTROID = `(() => {
  const sf = window.__sf, THREE = sf.THREE, m4 = new THREE.Matrix4(), p = new THREE.Vector3();
  let sx = 0, sz = 0, n = 0, minY = 1e9, maxY = -1e9;
  const g = sf.wildlands && sf.wildlands.grass && sf.wildlands.grass.group;
  const field = g?.userData?.foliageField?.stats;
  if (g?.userData?.grassStats?.gpuGenerated && field?.ready) {
    const cam = sf.camera.position, pl = sf.player.position;
    return {
      grassCentroid: [Math.round(field.centerX), Math.round(field.centerZ)],
      grassN: g.userData.grassStats.count,
      camXZ:[Math.round(cam.x),Math.round(cam.z)],
      playerXZ:[Math.round(pl.x),Math.round(pl.z)]
    };
  }
  if (g) g.traverse(o => {
    if (!/grass/i.test(o.name)) return;
    const compact = o.geometry?.getAttribute?.('aGrassTransform');
    if (compact) {
      const count = o.geometry.instanceCount;
      const step = Math.max(1, (count/300)|0);
      for (let i=0;i<count;i+=step){ sx+=compact.getX(i); sz+=compact.getZ(i); n++; }
      return;
    }
    if (o.isInstancedMesh) {
      const step = Math.max(1, (o.count/300)|0);
      for (let i=0;i<o.count;i+=step){ o.getMatrixAt(i,m4); p.setFromMatrixPosition(m4); if (p.lengthSq()<1) continue; sx+=p.x; sz+=p.z; n++; }
    }
  });
  const cam = sf.camera.position, pl = sf.player.position;
  return { grassCentroid: n?[Math.round(sx/n), Math.round(sz/n)]:null, grassN: n, camXZ:[Math.round(cam.x),Math.round(cam.z)], playerXZ:[Math.round(pl.x),Math.round(pl.z)] };
})()`;

const GRASS_STATE = `(() => {
  const group = window.__sf?.wildlands?.grass?.group;
  if (!group) return null;
  const attached = group.parent === window.__sf.scene;
  const meshes = [];
  group.traverse((object) => {
    if (!/wildlands_grass_/i.test(object.name) || !object.isMesh) return;
    let effectiveVisible = attached && object.visible;
    for (let parent = object.parent; parent; parent = parent.parent) effectiveVisible &&= parent.visible;
    meshes.push({
      name: object.name,
      count: object.userData?.grassLastCount ?? object.geometry?.instanceCount ?? object.count ?? 0,
      visible: object.visible,
      effectiveVisible
    });
  });
  return {
    attached,
    groupVisible: group.visible,
    meshes: meshes.length,
    visible: meshes.filter((mesh) => mesh.effectiveVisible && mesh.count > 0).length,
    hidden: meshes.filter((mesh) => !mesh.effectiveVisible && mesh.count > 0).map((mesh) => mesh.name),
    instances: meshes.reduce((sum, mesh) => sum + mesh.count, 0),
    stats: group.userData.grassStats ?? null,
    streaming: group.userData.grassStreaming ?? null
  };
})()`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevIfNeeded();
  const chrome = await findChrome();
  const port = await freePort();
  // A fresh profile keeps a prior probe's persisted player position from
  // activating Wildlands during the next run's clean-boot lazy-load check.
  const proc = spawn(chrome, [`--user-data-dir=${path.join(OUT, `chrome-${process.pid}`)}`, "--headless=new", `--remote-debugging-port=${port}`, "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal", "--hide-scrollbars", "--mute-audio", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart=1&fullfps=1&profile=1`], { cwd: ROOT, stdio: "ignore" });
  await sleep(2500);
  let page; for (let i = 0; i < 60; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1") && t.webSocketDebuggerUrl); if (page) break; } catch {} await sleep(400); }
  if (!page) throw new Error("no page");
  const c = new Cdp(page.webSocketDebuggerUrl);
  c.onEvent = (m) => { if (m.method === "Runtime.exceptionThrown") console.log("[exc]", (m.params.exceptionDetails.exception||{}).description||m.params.exceptionDetails.text); };
  await c.open(); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  console.log("[probe] waiting __sf...");
  const t0 = Date.now(); let ready = false;
  // Wildlands is intentionally absent at clean boot. Wait only for fundamentals,
  // then activate the region by teleporting before expecting its lazy owner.
  while (Date.now() - t0 < 150000) { try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.camera)`)) { ready = true; break; } } catch {} await sleep(600); }
  if (!ready) throw new Error("never ready");
  console.log("[probe] ready");
  await ev(c, `(()=>{const s=window.__sf.sky;s.cycleEnabled=false;s.setTimeOfDay(${TIME});return true;})()`);
  const bootState = await ev(c, `(()=>({
    wildlandsPresent:!!window.__sf.wildlands,
    trace:window.__sf.lazyRegionTimings?.wildlands??null,
    generation:window.__sf.worldArrival.snapshot.generation
  }))()`);
  // The broader post-reveal coordinator may have recorded a request by the
  // time this probe gains CDP control; construction or attachment at clean boot
  // is the meaningful regression here.
  if (bootState.wildlandsPresent) {
    throw new Error(`wildlands was not lazy at clean boot: ${JSON.stringify(bootState)}`);
  }
  // Use the real covered destination coordinator. A direct player teleport can
  // bypass terrain readiness and produce a visually meaningless white/empty
  // meadow even when grass streaming itself is correct.
  const activationStarted = Date.now();
  await ev(c, `window.__sf.teleportToTarget(${FX},${FZ},'Wildlands grass probe')`);
  const regionStart = Date.now();
  while (Date.now() - regionStart < 90000) {
    if (await ev(c, `!!window.__sf.wildlands?.grass?.group`).catch(() => false)) break;
    await sleep(100);
  }
  if (!(await ev(c, `!!window.__sf.wildlands?.grass?.group`).catch(() => false))) {
    throw new Error("wildlands lazy owner never activated after entering Golden Gate Park");
  }
  const ownerObservedMs = Date.now() - activationStarted;
  let grassState = await ev(c, GRASS_STATE);
  console.log(`[probe] grass owner constructed after ${ownerObservedMs}ms`, JSON.stringify(grassState));

  // The arrival handoff only waits for one dense, focus-containing tile from
  // each visual layer. The rest of the outer ring is intentionally optional
  // background work, so record both milestones instead of conflating them.
  while (
    Date.now() - activationStarted < 120000 &&
    (!grassState?.attached ||
      !grassState?.streaming?.criticalReady ||
      grassState.streaming.criticalLayers < 4 ||
      grassState.visible < 4)
  ) {
    await sleep(100);
    grassState = await ev(c, GRASS_STATE);
  }
  if (!grassState?.attached || !grassState?.streaming?.criticalReady || grassState.visible < 4) {
    throw new Error(`wildlands critical grass coverage never became renderable: ${JSON.stringify(grassState)}`);
  }
  const criticalRenderableMs = Date.now() - activationStarted;
  const criticalGrassState = grassState;
  // Critical grass can become renderable while the destination coordinator is
  // still finishing collision or tree preparation. Wait for the actual covered
  // arrival contract instead of assuming those independent lanes finish in a
  // particular order.
  let arrival = await ev(c, `({...window.__sf.worldArrival.snapshot})`);
  while (Date.now() - activationStarted < 120000 && (arrival.state !== "idle" || arrival.active)) {
    await sleep(100);
    arrival = await ev(c, `({...window.__sf.worldArrival.snapshot})`);
  }
  if (arrival.state !== "idle" || arrival.active) {
    throw new Error(`covered Wildlands arrival did not settle: ${JSON.stringify(arrival)}`);
  }
  const nearTrees = await ev(c, `(()=>{
    const group=window.__sf.wildlands?.trees?.group;
    return group?.userData?.nativeTreeNearLodStats?.()??null;
  })()`);
  const expectsCloseDetail = (nearTrees?.closestCandidate?.distance ?? Infinity) < (nearTrees?.nearRadius ?? 0);
  if (!nearTrees || (expectsCloseDetail && nearTrees.active === 0) || nearTrees.failedDesigns?.length) {
    throw new Error(`wildlands close tree detail did not become active: ${JSON.stringify(nearTrees)}`);
  }
  console.log(`[probe] close tree detail active`, JSON.stringify(nearTrees));
  const treeAttachStarted = Date.now();
  while (Date.now() - treeAttachStarted < 5000) {
    if (await ev(c, `!!window.__sf.wildlands?.trees?.group?.parent`).catch(() => false)) break;
    await sleep(100);
  }
  // The app intentionally schedules native-tree attachment as background
  // enrichment after destination-essential grass. A focused foliage probe need
  // not wait for unrelated deferred world owners; attach the already-prepared
  // group only inside this throwaway browser when the coordinator has not yet
  // reached it.
  const probeAttachedTrees = await ev(c, `(()=>{const sf=window.__sf,group=sf.wildlands?.trees?.group;
    if(!group?.parent){group.visible=true;sf.scene.add(group);return true;}return false;})()`);
  const nearTreeRenderState = await ev(c, `(()=>{
    const sf=window.__sf,group=sf.wildlands?.trees?.group,meshes=[];
    let attached=false;for(let node=group;node;node=node.parent)if(node===sf.scene)attached=true;
    group?.traverse((object)=>{
      if(!object.isMesh||!/(canopy|grove)/i.test(object.name))return;
      let effective=attached;
      for(let node=object;node;node=node.parent)effective&&=node.visible;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      meshes.push({name:object.name,effective,count:object.geometry?.instanceCount??object.count??0,
        triangles:Math.round((object.geometry?.index?.count??object.geometry?.attributes?.position?.count??0)/3),
        textured:materials.some((material)=>!!material?.map)});
    });
    return{attached,visibleMeshes:meshes.filter((mesh)=>mesh.effective&&mesh.count>0),allMeshes:meshes};
  })()`);
  nearTreeRenderState.probeAttached = probeAttachedTrees;
  if (!nearTreeRenderState.attached || nearTreeRenderState.visibleMeshes.length === 0) {
    throw new Error(`wildlands close tree batches are not renderable: ${JSON.stringify(nearTreeRenderState)}`);
  }
  console.log(`[probe] close tree render state`, JSON.stringify(nearTreeRenderState));

  // Worst-case forced cull classification plus drift-controlled whole-tree GPU
  // A/B/A. If the coarse CPU classifier is already tiny, replacing lazy chunk
  // ownership with a global compute/indirect forest would be a net architectural
  // loss even when hiding all tree raster work is measurably useful.
  const treeProfile = await ev(c, `(async()=>{
    const sf=window.__sf, trees=sf.wildlands.trees, group=trees.group, dev=sf.renderer.backend.device;
    const samples=[];
    for(let i=0;i<240;i++){
      const a=i*0.61803398875*Math.PI*2,r=30+(i%7)*19;
      const t=performance.now();group.userData.nativeTreeLodProbeAt(${FX}+Math.cos(a)*r,${FZ}+Math.sin(a)*r);
      samples.push(performance.now()-t);
    }
    group.userData.nativeTreeLodProbeAt(${FX},${FZ});
    samples.sort((a,b)=>a-b);
    const measure=async(visible)=>{
      group.visible=visible;
      for(let i=0;i<8;i++){sf.tick(1/60);await dev.queue.onSubmittedWorkDone();}
      const xs=[];sf.renderer.info.autoReset=false;sf.renderer.info.reset();
      for(let i=0;i<24;i++){const t=performance.now();sf.tick(1/60);await dev.queue.onSubmittedWorkDone();xs.push(performance.now()-t);}
      const render={draws:sf.renderer.info.render.drawCalls??sf.renderer.info.render.calls,triangles:sf.renderer.info.render.triangles};
      sf.renderer.info.autoReset=true;xs.sort((a,b)=>a-b);return{p50:xs[12],render};
    };
    const on0=await measure(true),off=await measure(false),on1=await measure(true);
    return{cull:{p50:samples[120],p95:samples[228],max:samples[239]},gpu:{on0,off,on1,treeCostMs:(on0.p50+on1.p50)/2-off.p50}};
  })()`);
  const treeLodState = await ev(c, `window.__sf.wildlands.trees.group.userData.nativeTreeLodTransitionStats()`);
  console.log(`[probe] native tree cull/raster profile`, JSON.stringify(treeProfile));
  console.log(`[probe] native tree horizon state`, JSON.stringify({
    residentChunks: treeLodState.residentChunks,
    visibleDraws: treeLodState.visibleDraws,
    visibleTriangles: treeLodState.visibleTriangles,
    landscapeInstances: treeLodState.chunks.reduce((sum,chunk)=>sum+chunk.landscapeInstances,0),
    horizonInstances: treeLodState.chunks.reduce((sum,chunk)=>sum+chunk.horizonInstances,0)
  }));
  console.log(`[probe] critical grass coverage attached + renderable ${criticalRenderableMs}ms after activation`, JSON.stringify(criticalGrassState));

  while (
    Date.now() - activationStarted < 120000 &&
    (grassState?.streaming?.pendingJobs !== 0 ||
      !grassState?.meshes ||
      grassState.visible !== grassState.meshes)
  ) {
    await sleep(100);
    grassState = await ev(c, GRASS_STATE);
  }
  if (grassState?.streaming?.pendingJobs !== 0 || !grassState?.meshes || grassState.visible !== grassState.meshes) {
    throw new Error(`wildlands full grass ring never settled: ${JSON.stringify(grassState)}`);
  }
  const fullRenderableMs = Date.now() - activationStarted;
  const lazyTrace = await ev(c, `window.__sf.lazyRegionTimings?.wildlands ?? null`);
  console.log(`[probe] full grass ring settled + renderable ${fullRenderableMs}ms after activation`, JSON.stringify(grassState));
  console.log(`[probe] wildlands trace ${JSON.stringify(lazyTrace)}`);

  await ev(c, `window.__sfManual&&window.__sfManual(true)`);

  if (nearTrees.closest) {
    const target = nearTrees.closest;
    await ev(c, `(()=>{const sf=window.__sf,tx=${target.x},tz=${target.z};
      const dx=tx-(${FX}),dz=tz-(${FZ}),length=Math.hypot(dx,dz)||1;
      const ex=tx-dx/length*55,ez=tz-dz/length*55;
      window.__sfFreeCam([ex,sf.map.groundHeight(ex,ez)+12,ez],[tx,sf.map.groundHeight(tx,tz)+25,tz]);return true;})()`);
    await settle(c, 12);
    const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true });
    writeFileSync(path.join(OUT, "near_tree_detail.jpg"), Buffer.from(shot.data, "base64"));
  }

  // orbit the free camera AROUND the stationary player; look inward.
  // If the grass centroid tracks the camera, the ring is camera-locked.
  console.log(`\nplayer held at ${FX},${FZ}. Orbiting camera; watch grassCentroid vs camXZ vs playerXZ:`);
  const R = 10; // camera boom radius
  const orbit = [];
  for (const deg of [0, 90, 180, 270, 45, 225]) {
    const a = (deg * Math.PI) / 180;
    // place the eye on a circle of radius R around the player, looking at the player
    await ev(c, `(()=>{const gy=window.__sf.map.groundHeight(${FX},${FZ});
      window.__sfFreeCam([${FX}+Math.sin(${a})*${R}, gy+2, ${FZ}+Math.cos(${a})*${R}], [${FX}, gy+1, ${FZ}]);return true;})()`);
    await settle(c, 16); // let the ring react to the moved camera
    const s = await ev(c, CENTROID);
    const shot = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 84, fromSurface: true });
    writeFileSync(path.join(OUT, `orbit_${deg}.jpg`), Buffer.from(shot.data, "base64"));
    const drift = s.grassCentroid ? Math.hypot(s.grassCentroid[0] - FX, s.grassCentroid[1] - FZ) : -1;
    orbit.push({ deg, ...s, drift });
    console.log(`  cam@${String(deg).padStart(3)}°  camXZ=${JSON.stringify(s.camXZ)} playerXZ=${JSON.stringify(s.playerXZ)}  grassCentroid=${JSON.stringify(s.grassCentroid)} (drift from player ${drift.toFixed(1)}m, n=${s.grassN})`);
  }
  writeFileSync(path.join(OUT, "result.json"), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    serverUrl: SERVER_URL,
    focus: { x: FX, z: FZ },
    bootState,
    arrival,
    nearTrees,
    nearTreeRenderState,
    treeProfile,
    treeLodState,
    ownerObservedMs,
    criticalRenderableMs,
    fullRenderableMs,
    criticalGrassState,
    grassState,
    lazyTrace,
    orbit
  }, null, 2)}\n`);
  console.log("\n=== orbit test done ===");
  c.close(); proc.kill(); if (dev) dev.kill(); process.exit(0);
}
main().catch((e) => { console.error("[probe] FAILED", e); process.exit(1); });
