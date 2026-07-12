// STAGE-2 SPIKE: does THREE.BatchedMesh collapse N *unique* geometries into few
// GPU draw executions on THIS Metal/WebGPU backend? Boots the real app (real
// renderer/device), builds 300 unique box-ish geometries three ways and times
// GPU completion of a camera that sees them all:
//   A) 300 separate THREE.Mesh (baseline = 300 draws)
//   B) 1 BatchedMesh with 300 addGeometry + 300 addInstance
//   C) 1 merged BufferGeometry (all 300 concatenated) = 1 draw (best case ref)
// If B ≈ C (fast) -> BatchedMesh collapses on Metal -> use it. If B ≈ A -> it does
// NOT collapse -> fall back to per-chunk static merge for walls.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p){try{await access(p);return true}catch{return false}}
async function findChrome(){for(const c of [process.env.CHROME_BIN,"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)){if(c.includes("/")&&!(await isFile(c)))continue;return c}throw new Error("no chrome")}
function freePort(){return new Promise((res,rej)=>{const s=createServer();s.once("error",rej);s.listen(0,"127.0.0.1",()=>{const{port}=s.address();s.close(()=>res(port))})})}
async function waitHttp(u,ms){const t=Date.now();while(Date.now()-t<ms){try{if((await fetch(u,{cache:"no-store"})).ok)return true}catch{}await sleep(300)}throw new Error("http")}
class Cdp{#ws;#id=1;#p=new Map();constructor(u){this.#ws=new WebSocket(u)}async open(){await new Promise((res,rej)=>{this.#ws.addEventListener("open",res,{once:true});this.#ws.addEventListener("error",rej,{once:true})});this.#ws.addEventListener("message",(e)=>{const m=JSON.parse(e.data.toString());if(m.id){const p=this.#p.get(m.id);if(!p)return;this.#p.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result??{})}})}send(method,params={}){const id=this.#id++;this.#ws.send(JSON.stringify({id,method,params}));return new Promise((res,rej)=>this.#p.set(id,{res,rej}))}close(){this.#ws.close()}}
async function ev(c,e){const r=await c.send("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails.exception?.description||r.exceptionDetails));return r.result?.value}
async function waitEv(c,e,ms){const t=Date.now();while(Date.now()-t<ms){try{if(await ev(c,e))return}catch{}await sleep(300)}throw new Error("eval to "+e)}

const SETUP = `
window.__spike = async function(mode, N) {
  const T = window.__sf.THREE;
  const renderer = window.__sf.renderer;
  const dev = renderer.backend.device;
  renderer.setAnimationLoop(null); // STOP the app loop so this test owns the GPU + info counters
  const scene = new T.Scene();
  scene.add(new T.HemisphereLight(0xffffff, 0x444444, 2.0));
  const cam = new T.PerspectiveCamera(60, 1600/1000, 0.1, 1000);
  cam.position.set(0, 40, 120); cam.lookAt(0, 10, 0);
  // 300 unique box-ish geometries (varied size/segments so they are genuinely distinct)
  const geos = [];
  for (let i = 0; i < N; i++) {
    const w = 2 + (i % 7) * 0.5, h = 4 + (i % 11) * 0.7, d = 2 + (i % 5) * 0.4;
    const g = new T.BoxGeometry(w, h, d, 1 + (i%3), 1 + (i%2), 1);
    g.deleteAttribute('uv');
    geos.push(g.toNonIndexed ? g : g);
  }
  const gx = (i) => ((i % 24) - 12) * 6, gz = (i) => (Math.floor(i / 24) - 6) * 6;
  const mat = new T.MeshStandardNodeMaterial({ color: 0x9a9d9f, roughness: 0.7 });
  let objs = [];
  if (mode === 'A') {
    for (let i = 0; i < N; i++) { const m = new T.Mesh(geos[i], mat); m.position.set(gx(i), 5, gz(i)); m.frustumCulled=false; scene.add(m); objs.push(m); }
  } else if (mode === 'B') {
    let maxV = 0, maxI = 0; for (const g of geos) { maxV += g.attributes.position.count; const idx = g.index; maxI += idx ? idx.count : g.attributes.position.count; }
    const bm = new T.BatchedMesh(N, maxV, maxI, mat);
    bm.frustumCulled = false;
    for (let i = 0; i < N; i++) { const gid = bm.addGeometry(geos[i]); const iid = bm.addInstance(gid); const mtx = new T.Matrix4().makeTranslation(gx(i), 5, gz(i)); bm.setMatrixAt(iid, mtx); }
    scene.add(bm); objs.push(bm);
  } else if (mode === 'D') {
    // per-instance OPACITY via a self-managed fade texture indexed by the batch's
    // indirectId (getIndirectIndex) + alphaHash. Half the instances opacity~0.02
    // (dithered ~away), half opacity 1 → if ~half render, per-instance fade works.
    const TT = window.__sf.TSL;
    let maxV = 0, maxI = 0; for (const g of geos) { maxV += g.attributes.position.count; const idx = g.index; maxI += idx ? idx.count : g.attributes.position.count; }
    const fadeMat = new T.MeshStandardNodeMaterial({ color: 0x9a9d9f, roughness: 0.7 });
    const bm = new T.BatchedMesh(N, maxV, maxI, fadeMat);
    bm.frustumCulled = false;
    const ids = [];
    for (let i = 0; i < N; i++) { const gid = bm.addGeometry(geos[i]); const iid = bm.addInstance(gid); bm.setMatrixAt(iid, new T.Matrix4().makeTranslation(gx(i), 5, gz(i))); ids.push(iid); }
    const cap = Math.max(...ids) + 1;
    const fadeData = new Float32Array(cap * 4);
    const diag = window.__spikeDiag || "getIndirect";
    for (let i = 0; i < N; i++) { const v = (i % 2 === 0) ? 1.0 : 0.02; fadeData[ids[i]*4] = (diag === "allone" ? 1.0 : v); }
    const fadeTex = new T.DataTexture(fadeData, cap, 1, T.RGBAFormat, T.FloatType);
    fadeTex.minFilter = T.NearestFilter; fadeTex.magFilter = T.NearestFilter; fadeTex.generateMipmaps = false;
    fadeTex.needsUpdate = true;
    const { textureLoad, textureSize, int, ivec2, drawIndex, instanceIndex, float, Fn } = TT;
    let opNode;
    if (diag === "const1") { opNode = float(1.0); }                     // baseline: alphaHash + const opacity
    else if (diag === "instidx") { opNode = textureLoad(fadeTex, ivec2(int(instanceIndex), int(0))).x; } // raw instanceIndex
    else { // getIndirect: replicate three's batch node using the BUILDER's draw index
      opNode = Fn((args, builder) => {
        const indirectTexture = bm._indirectTexture;
        const di = builder.getDrawIndex();               // gl_DrawID node, or null
        const id = int(di === null ? instanceIndex : di); // exactly three's batchingIdNode
        const isize = int(textureSize(textureLoad(indirectTexture), 0).x);
        const ix = id.mod(isize), iy = id.div(isize);
        const indirectId = int(textureLoad(indirectTexture, ivec2(ix, iy)).x);
        return textureLoad(fadeTex, ivec2(indirectId, int(0))).x;
      })();
    }
    fadeMat.opacityNode = opNode;
    fadeMat.alphaHash = true;
    scene.add(bm); objs.push(bm);
    window.__fadeCheck = true;
  } else if (mode === 'C') {
    // merge all into one geometry (1 draw ref)
    const parts = [];
    for (let i = 0; i < N; i++) { const g = geos[i].index ? geos[i].toNonIndexed() : geos[i].clone(); g.translate(gx(i), 5, gz(i)); parts.push(g); }
    const merged = T.BufferGeometryUtils ? T.BufferGeometryUtils.mergeGeometries(parts, false) : mergeManual(T, parts);
    const m = new T.Mesh(merged, mat); m.frustumCulled=false; scene.add(m); objs.push(m);
  }
  // warm
  for (let i = 0; i < 8; i++) { await renderer.renderAsync(scene, cam); }
  await dev.queue.onSubmittedWorkDone();
  // clean draw-count read: one render of ONLY this scene
  renderer.info.reset ? renderer.info.reset() : (renderer.info.render.drawCalls = 0);
  await renderer.renderAsync(scene, cam);
  const info = { calls: renderer.info.render.drawCalls, tris: renderer.info.render.triangles };
  const times = [];
  for (let f = 0; f < 80; f++) {
    const t0 = performance.now();
    await renderer.renderAsync(scene, cam);
    await dev.queue.onSubmittedWorkDone();
    times.push(performance.now() - t0);
  }
  times.sort((a,b)=>a-b);
  const p50 = times[Math.floor(times.length*0.5)];
  // cleanup (skipped in keep mode so a screenshot can be taken)
  if (!window.__spikeNoClean) { for (const o of objs) { scene.remove(o); if (o.dispose) o.dispose(); } for (const g of geos) g.dispose(); }
  else { window.__spikeScene = scene; window.__spikeCam = cam; }
  return { mode, N, p50: Math.round(p50*100)/100, info };
};
window.__spikeKeep = async function(mode, N) {
  window.__spikeNoClean = true;
  const r = await window.__spike(mode, N);
  // render the kept scene once more so it's on the framebuffer for the screenshot
  await window.__sf.renderer.renderAsync(window.__spikeScene, window.__spikeCam);
  window.__spikeNoClean = false;
  return r;
};
// Offscreen coverage: render the kept scene to our own RT and count lit pixels.
// mode D (half instances opacity 0.02) should show ~HALF the coverage of mode B.
window.__spikeCoverage = async function(mode, N) {
  const T = window.__sf.THREE; const r = window.__sf.renderer;
  window.__spikeNoClean = true;
  await window.__spike(mode, N);
  window.__spikeNoClean = false;
  const W = 400, H = 250;
  const rt = new T.RenderTarget(W, H);
  r.setRenderTarget(rt);
  r.setClearColor(0x000000, 1);
  await r.clearAsync();
  await r.renderAsync(window.__spikeScene, window.__spikeCam);
  const buf = await r.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
  r.setRenderTarget(null);
  let lit = 0; for (let i = 0; i < buf.length; i += 4) { if (buf[i] + buf[i+1] + buf[i+2] > 24) lit++; }
  // cleanup kept scene
  for (const o of window.__spikeScene.children.slice()) { window.__spikeScene.remove(o); if (o.dispose) o.dispose(); }
  rt.dispose();
  return { mode, lit, total: W*H, pct: Math.round(lit / (W*H) * 10000)/100 };
};
function mergeManual(T, parts){ // minimal position+normal concat
  let vc=0; for(const g of parts) vc += g.attributes.position.count;
  const pos=new Float32Array(vc*3), nrm=new Float32Array(vc*3); let o=0;
  for(const g of parts){ const p=g.attributes.position.array, n=g.attributes.normal.array; pos.set(p,o); nrm.set(n,o); o+=p.length; }
  const m=new T.BufferGeometry(); m.setAttribute('position', new T.BufferAttribute(pos,3)); m.setAttribute('normal', new T.BufferAttribute(nrm,3)); return m;
}
1;
`;

async function main(){
  const vp=await freePort(),rp=await freePort();
  const dev=spawn("npm",["run","dev","--","--host","127.0.0.1","--port",String(vp),"--strictPort"],{cwd:ROOT,env:{...process.env,SF_RELAY_PORT:String(rp)},stdio:["ignore","ignore","ignore"],detached:true});
  const cp=await findChrome();const dp=await freePort();let chrome;
  try{
    await waitHttp(`http://127.0.0.1:${vp}`,90000);
    chrome=spawn(cp,[`--remote-debugging-port=${dp}`,`--user-data-dir=/tmp/chrome-spike-${Date.now()}`,"--headless=new","--no-first-run","--mute-audio","--enable-features=SharedArrayBuffer","--use-angle=metal","--enable-unsafe-webgpu","--enable-gpu","--window-size=1600,1000","about:blank"],{stdio:"ignore"});
    let t=Date.now();while(Date.now()-t<15000){try{await (await fetch(`http://127.0.0.1:${dp}/json/version`)).json();break}catch{await sleep(200)}}
    const pg=await (await fetch(`http://127.0.0.1:${dp}/json/new?about:blank`,{method:"PUT"})).json();
    const c=new Cdp(pg.webSocketDebuggerUrl);await c.open();await c.send("Runtime.enable");
    await c.send("Page.navigate",{url:`http://127.0.0.1:${vp}/?autostart=1&fullfps=1`});
    await waitEv(c,"Boolean(window.__sf&&window.__sf.renderer&&window.__sf.THREE)",120000);
    await ev(c,"Boolean(window.__sf.THREE.BatchedMesh)").then(v=>console.log("[spike] BatchedMesh present:", v));
    await ev(c, SETUP);
    for (const N of [300]) {
      for (const mode of ['C','A','B','A','B','C']) { // interleave to control drift
        const r = await ev(c, `window.__spike(${JSON.stringify(mode)}, ${N})`);
        console.log(`[spike] mode ${r.mode} N=${r.N}: p50=${r.p50}ms  info.drawCalls=${r.info.calls} tris=${r.info.tris}`);
      }
    }
    // per-instance fade test (mode D): render, then read the canvas and count
    // roughly-rendered coverage vs an all-opaque batch (mode 'B').
    const covOf = async (mode) => {
      await ev(c, `window.__spike(${JSON.stringify(mode)}, 300)`);
      // draw a solid clear, render once, read pixel coverage (non-clear pixels)
      return await ev(c, `(async()=>{
        const r=window.__sf.renderer; const cv=r.domElement;
        // count via a readback: render the spike scene to the default framebuffer already done in __spike;
        // instead sample the batch by re-rendering into an offscreen? simplest: use gl readPixels on the canvas
        const gl = cv.getContext('webgpu') ? null : null;
        return 'n/a';
      })()`);
    };
    // per-instance fade verdict via offscreen coverage readback + diagnostics
    try {
      const cb = await ev(c, `window.__spikeCoverage("B", 300)`); // all opaque baseline
      console.log(`[spike] B (all opaque) coverage=${cb.pct}%`);
      for (const diag of ["const1","allone","instidx","getIndirect"]) {
        const cd = await ev(c, `(window.__spikeDiag=${JSON.stringify(diag)}, window.__spikeCoverage("D", 300))`);
        console.log(`[spike]   diag=${diag.padEnd(11)} coverage=${cd.pct}%  (const1/allone≈B → mechanism OK; getIndirect≈half → per-instance OK)`);
      }
    } catch (e) {
      console.log(`[spike] fade coverage test FAILED: ${e.message}`);
    }
    c.close();
  }catch(e){console.error("SPIKE ERR", e.message)}finally{try{chrome?.kill()}catch{};try{process.kill(-dev.pid)}catch{}}
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
