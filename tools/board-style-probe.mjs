// Headless hoverboard-customizer probe. Boots the real app (own vite, WebGPU/
// metal), rides the board on a known Castro street anchor, then:
//   1. swaps through all v4 procedural configs via player.setBoardConfig,
//      verifies one fully-wrapped shell, and captures every side of the artwork,
//   2. spawns a fake remote rider with a custom board and re-customizes it
//      (exercises remotes.updateBoard's dispose/rebuild path),
//   3. proves flow/air/landing animation changes texture uniforms without uploads,
//   4. opens the simplified two-visual/two-audio garage, drives all four named
//      XY pads through Chrome input, and checks desktop/mobile reachability,
//   5. compares quiet/gliding and punchy/airy synth macros through the real
//      vehicleAudio graph, proving the second audio instrument is material.
//   node tools/board-style-probe.mjs
// Env: SF_PROBE_URL (own vite; NOT 5179), SF_PROBE_OUT (default .data/board-style)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FINAL_OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/board-style");
// live writes go OUTSIDE the project tree — vite watches it and a write there
// triggers a full reload that kills the WebGPU renderer mid-run
const TMP = path.join(process.env.TMPDIR ?? "/tmp", "sf-board-style-probe");
const OUT = path.join(TMP, "out");
const PROFILE_ROOT = path.join(TMP, "profile");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5236";
const W = 1280, H = 800;
const FLAT = { x: 206, z: 3194, facing: 1.58 }; // Castro St core (verified street anchor)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertProbe(ok, message) {
  if (!ok) throw new Error(`[board-style-probe] ${message}`);
}

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
  writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64"));
  return name;
}

async function dragPad(c, rect, from, to) {
  const point = ([x, y]) => ({ x: rect.left + rect.width * x, y: rect.top + rect.height * y });
  const start = point(from);
  const end = point(to);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start, button: "none", buttons: 0, pointerType: "mouse" });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  for (let i = 1; i <= 3; i++) {
    const u = i / 3;
    await c.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + (end.x - start.x) * u,
      y: start.y + (end.y - start.y) * u,
      button: "left",
      buttons: 1,
      pointerType: "mouse"
    });
  }
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...end, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
}

async function revealPad(c, kind) {
  return ev(c, `(async()=>{
    const pad=document.querySelector('.board-lab-${kind} .board-xy-pad');
    if(!pad) return null;
    pad.scrollIntoView({block:'center',inline:'nearest'});
    await new Promise(r=>requestAnimationFrame(r));
    const b=pad.getBoundingClientRect();
    return {left:b.left,top:b.top,width:b.width,height:b.height};
  })()`);
}

async function measurePanel(c) {
  return ev(c, `(async()=>{
    const panel=document.querySelector('.board-panel');
    if(!panel) return {exists:false};
    const kinds=['surface','motion','sound','thrust'];
    panel.scrollTop=0;
    await new Promise(r=>requestAnimationFrame(r));
    const pr=panel.getBoundingClientRect();
    const fitsViewport=pr.left>=-1&&pr.top>=-1&&pr.right<=innerWidth+1&&pr.bottom<=innerHeight+1;
    const reachable={};
    for(const kind of kinds){
      const pad=panel.querySelector('.board-lab-'+kind+' .board-xy-pad');
      if(!pad){ reachable[kind]=false; continue; }
      pad.scrollIntoView({block:'center',inline:'nearest'});
      await new Promise(r=>requestAnimationFrame(r));
      const b=pad.getBoundingClientRect(),p=panel.getBoundingClientRect();
      reachable[kind]=b.left>=Math.max(0,p.left)-1&&b.right<=Math.min(innerWidth,p.right)+1&&
        b.top>=Math.max(0,p.top)-1&&b.bottom<=Math.min(innerHeight,p.bottom)+1;
    }
    const last=panel.querySelector('.avatar-random');
    last?.scrollIntoView({block:'end',inline:'nearest'});
    await new Promise(r=>requestAnimationFrame(r));
    const lr=last?.getBoundingClientRect(),p2=panel.getBoundingClientRect();
    const lastReachable=!!lr&&lr.left>=Math.max(0,p2.left)-1&&lr.right<=Math.min(innerWidth,p2.right)+1&&
      lr.top>=Math.max(0,p2.top)-1&&lr.bottom<=Math.min(innerHeight,p2.bottom)+1;
    const overflowY=getComputedStyle(panel).overflowY;
    const scrollable=panel.scrollHeight>panel.clientHeight+1;
    return {
      exists:true,viewport:[innerWidth,innerHeight],
      rect:{left:pr.left,top:pr.top,right:pr.right,bottom:pr.bottom,width:pr.width,height:pr.height},
      clientHeight:panel.clientHeight,scrollHeight:panel.scrollHeight,scrollTop:panel.scrollTop,
      overflowY,scrollable,scrollReady:!scrollable||/auto|scroll/.test(overflowY),
      fitsViewport,reachable,lastReachable,allPadsReachable:Object.values(reachable).every(Boolean)
    };
  })()`);
}

const CONFIGS = [
  {
    name: "classic",
    cfg: {
      shape: "classic", fin: "none", deck: 0, trim: 5, glow: 0,
      surface: "aurora", surfaceScale: 24, surfaceWarp: 68, surfaceSeed: 101,
      surfaceFlow: 0, surfaceFx: 0, surfaceFxKind: "vortex",
      hum: "hum", pitch: 0, soundTone: 45, soundMotion: 35, soundThrust: 50, soundAir: 12
    }
  },
  {
    name: "dart",
    cfg: {
      shape: "dart", fin: "spoiler", deck: 1, trim: 3, glow: 4,
      surface: "topo", surfaceScale: 70, surfaceWarp: 18, surfaceSeed: 202,
      surfaceFlow: 35, surfaceFx: 48, surfaceFxKind: "glitch",
      hum: "retro", pitch: 3, soundTone: 80, soundMotion: 72, soundThrust: 82, soundAir: 46
    }
  },
  {
    name: "manta",
    cfg: {
      shape: "manta", fin: "halo", deck: 4, trim: 5, glow: 3,
      surface: "terrazzo", surfaceScale: 48, surfaceWarp: 88, surfaceSeed: 303,
      surfaceFlow: 58, surfaceFx: 82, surfaceFxKind: "ripple",
      hum: "choir", pitch: 1, soundTone: 32, soundMotion: 64, soundThrust: 32, soundAir: 66
    }
  },
  {
    name: "saucer",
    cfg: {
      shape: "saucer", fin: "twin", deck: 5, trim: 6, glow: 2,
      surface: "circuit", surfaceScale: 76, surfaceWarp: 42, surfaceSeed: 404,
      surfaceFlow: 42, surfaceFx: 64, surfaceFxKind: "glitch",
      hum: "crystal", pitch: 4, soundTone: 68, soundMotion: 82, soundThrust: 70, soundAir: 80
    }
  },
  {
    name: "plasma",
    cfg: {
      shape: "twintip", fin: "halo", deck: 6, trim: 1, glow: 7,
      surface: "plasma", surfaceScale: 56, surfaceWarp: 76, surfaceSeed: 505,
      surfaceFlow: 88, surfaceFx: 94, surfaceFxKind: "vortex",
      hum: "deep", pitch: 2, soundTone: 58, soundMotion: 90, soundThrust: 58, soundAir: 92
    }
  }
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDev();
  const chrome = await findChrome();
  const port = await freePort();
  const proc = spawn(chrome, [
    `--user-data-dir=${path.join(PROFILE_ROOT, "run-" + Date.now())}`, "--headless=new", `--remote-debugging-port=${port}`,
    "--enable-unsafe-webgpu", "--enable-features=WebGPUDeveloperFeatures", "--use-angle=metal",
    "--autoplay-policy=no-user-gesture-required", "--mute-audio",
    "--hide-scrollbars", `--window-size=${W},${H}`, `${SERVER_URL}/?autostart&fullfps`
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
  await c.send("Page.enable"); await c.send("Runtime.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 180000) {
    try { if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device)`)) { ready = true; break; } } catch {}
    await sleep(600);
  }
  if (!ready) throw new Error("app never ready");
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);

  const P = `const sf=window.__sf; const dev=sf.renderer.backend.device;
    const tick=async(n)=>{ for(let i=0;i<n;i++){ sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); } };`;

  // warm-up: physics/tiles settle
  for (let k = 0; k < 14; k++) {
    try { await ev(c, `(async()=>{ ${P} await tick(20); return true; })()`); } catch {}
    await sleep(250);
  }

  // A concurrently edited Vite workspace can reload between initial readiness
  // and the warm-up loop. Reacquire the live hooks instead of failing later on
  // a stale page generation.
  let liveAfterWarmup = false;
  for (let i = 0; i < 120; i++) {
    try {
      if (await ev(c, `!!(window.__sf?.renderer?.backend?.device&&window.__sf?.player&&window.__sf?.tick)`)) {
        await ev(c, `window.__sfManual&&window.__sfManual(true)`);
        liveAfterWarmup = true;
        break;
      }
    } catch {}
    await sleep(250);
  }
  assertProbe(liveAfterWarmup, "app hooks disappeared during Vite warm-up");

  // ride the board on a real street, then park a low three-quarter free camera
  // on it (recomputed per shot — the hover spring bobs)
  await ev(c, `(async()=>{ ${P}
    const gy=sf.map.groundHeight(${FLAT.x},${FLAT.z});
    sf.player.teleportTo({x:${FLAT.x},y:gy+1.6,z:${FLAT.z},facing:${FLAT.facing},mode:'board'});
    await tick(60);
    return true;
  })()`);
  const FRAME = `const frame=()=>{ const p=sf.player.renderPosition;
    window.__sfFreeCam([p.x+2.1,p.y+1.15,p.z-2.5],[p.x,p.y+0.3,p.z]); };`;

  const results = { shots: [], boards: [], texture: {}, animation: {}, remote: {}, audio: {}, ui: {}, errors: [] };

  // ---- 1. texture-uniform animation contract ----
  // Drive the real board animation function directly against the live mesh. The
  // controller path is covered by board-fix-probe; here direct ticks make upload
  // and one-shot envelope assertions deterministic and independent of terrain.
  results.animation = await ev(c, `(async()=>{ ${P}
    const {animateBoard}=await import('/src/vehicles/board/mesh.ts');
    const base=${JSON.stringify(CONFIGS[0].cfg)};
    sf.player.setBoardConfig(base);
    const g=sf.player.meshes.board;
    const surface=g.userData.boardSurface;
    surface.reducedMotion=false;
    const snap=()=>({
      matrix:[...surface.texture.matrix.elements],
      offset:[surface.texture.offset.x,surface.texture.offset.y],
      repeat:[surface.texture.repeat.x,surface.texture.repeat.y],
      rotation:surface.texture.rotation
    });
    const delta=(a,b)=>Math.max(...a.matrix.map((v,i)=>Math.abs(v-b.matrix[i])));

    animateBoard(g,1/60,0,12,true,0,0,false);
    const version0=surface.texture.version;
    const staticA=snap();
    for(let i=1;i<=60;i++) animateBoard(g,1/60,i/60,12,true,0,0,false);
    const staticB=snap();
    const staticDelta=delta(staticA,staticB);
    const versionAfterStatic=surface.texture.version;

    // Motion-only preview must update scalar state without repainting/uploading.
    sf.player.previewBoardSurface({...base,surfaceFlow:82,surfaceReaction:91});
    const versionAfterMotionEdit=surface.texture.version;
    const flowSet=surface.flow;
    const reactionSet=surface.reaction;
    const motionA=snap();
    for(let i=1;i<=45;i++) animateBoard(g,1/60,2+i/60,18,true,0,0,false);
    const motionB=snap();
    const motionDelta=delta(motionA,motionB);
    const versionAfterMotion=surface.texture.version;

    const airBefore=surface.air;
    for(let i=0;i<30;i++) animateBoard(g,1/60,3+i/60,18,false,5,0,false);
    const airAfter=surface.air;
    // Establish a real downward history, then send exactly one explicit local
    // landing impulse. The visual envelope may ease up before decaying, but it
    // must form one contiguous pulse and return to zero.
    for(let i=0;i<12;i++) animateBoard(g,1/60,3.5+i/60,18,false,-14,0,false);
    let episodes=0,active=false,peak=0;
    const pulse=[];
    for(let i=0;i<150;i++){
      animateBoard(g,1/60,3.7+i/60,18,true,0,i===0?0.8:0,false);
      const value=surface.visualImpact;
      pulse.push(value);
      peak=Math.max(peak,value);
      const next=value>0.001;
      if(next&&!active) episodes++;
      active=next;
    }
    const finalImpact=surface.visualImpact;
    const versionFinal=surface.texture.version;
    return {
      version0,versionAfterStatic,versionAfterMotionEdit,versionAfterMotion,versionFinal,
      versionStable:version0===versionAfterStatic&&version0===versionAfterMotionEdit&&version0===versionAfterMotion&&version0===versionFinal,
      staticDelta,motionDelta,flowSet,reactionSet,airBefore,airAfter,
      episodes,peak,firstImpact:pulse[0],finalImpact,
      flowZeroStatic:staticDelta<1e-9,
      motionMovedWithoutUpload:motionDelta>1e-6&&versionAfterMotionEdit===versionAfterMotion
    };
  })()`);
  assertProbe(results.animation.versionStable, "animation changed CanvasTexture.version (unexpected upload)");
  assertProbe(results.animation.flowZeroStatic, `flow=0 moved texture matrix (${results.animation.staticDelta})`);
  assertProbe(results.animation.motionMovedWithoutUpload, "flow/reaction did not move texture uniforms without upload");
  assertProbe(Math.abs(results.animation.flowSet - 0.82) < 1e-9, "flow preview did not reach 0.82");
  assertProbe(Math.abs(results.animation.reactionSet - 0.91) < 1e-9, "reaction preview did not reach 0.91");
  assertProbe(results.animation.airAfter > results.animation.airBefore + 0.5, "air response did not rise");
  assertProbe(results.animation.episodes === 1, `landing envelope fired ${results.animation.episodes} times`);
  assertProbe(results.animation.peak > 0.1 && results.animation.finalImpact < 0.001, "landing pulse did not peak and decay");

  // ---- 2. config swaps on the local player ----
  for (const { name, cfg } of CONFIGS) {
    const r = await ev(c, `(async()=>{ ${P} ${FRAME}
      sf.player.setBoardConfig(${JSON.stringify(cfg)});
      await tick(30);
      frame(); await tick(4);
      const g=sf.player.meshes.board;
      let meshes=0; g.traverse(o=>{ if(o.isMesh) meshes++; });
      const anim=g.userData.boardAnim;
      return { meshes, hasAnim: !!anim, spinners: anim?anim.spinners.length:0 };
    })()`);
    results.boards.push({ name, ...r });
    results.shots.push(await shot(c, `board-${name}.png`));
  }
  assertProbe(results.boards.length === 5 && results.boards.every((b) => b.hasAnim), "not all five v4 presets built");

  // Wrapped-shell proof: one named mesh, one mapped material, projected finite
  // UVs, and normals facing both directions on every axis. Hide the shared rider
  // while photographing the top, underside, nose, tail, port and starboard.
  results.texture = await ev(c, `(async()=>{ ${P}
    const g=sf.player.meshes.board;
    const rider=g.children.find(o=>o.isGroup&&o.children.length>0&&o.position.y>0.75&&o.position.y<1.1);
    if(rider){ window.__sfProbeRider=rider; window.__sfProbeRiderVisible=rider.visible; rider.visible=false; }
    const under=g.getObjectByName('board-underglow-ring');
    if(under){ window.__sfProbeUnder=under; window.__sfProbeUnderVisible=under.visible; }
    const shell=g.getObjectByName('board-surface-shell');
    const surface=g.userData.boardSurface;
    if(!shell||!surface) return {riderHidden:!!rider,hasSurface:!!surface,shell:false};
    const uv=shell.geometry.getAttribute('uv');
    const normal=shell.geometry.getAttribute('normal');
    let uvMin=Infinity,uvMax=-Infinity,finiteUV=true;
    for(let i=0;i<uv.count;i++){
      const u=uv.getX(i),v=uv.getY(i);
      finiteUV&&=Number.isFinite(u)&&Number.isFinite(v);
      uvMin=Math.min(uvMin,u,v); uvMax=Math.max(uvMax,u,v);
    }
    const faces={px:0,nx:0,py:0,ny:0,pz:0,nz:0};
    for(let i=0;i<normal.count;i++){
      const x=normal.getX(i),y=normal.getY(i),z=normal.getZ(i);
      if(x>.35)faces.px++; if(x<-.35)faces.nx++;
      if(y>.35)faces.py++; if(y<-.35)faces.ny++;
      if(z>.35)faces.pz++; if(z<-.35)faces.nz++;
    }
    const materials=Array.isArray(shell.material)?shell.material:[shell.material];
    const mapped=materials.filter(m=>!!m.map);
    return {
      riderHidden:!!rider,hasSurface:true,shell:true,shellName:shell.name,
      canvas:[surface.canvas.width,surface.canvas.height],vertices:uv.count,
      materialCount:materials.length,mappedMaterialCount:mapped.length,
      mapShared:mapped.length===1&&mapped[0].map===surface.texture,
      finiteUV,uvMin,uvMax,uvInRange:finiteUV&&uvMin>=-1e-6&&uvMax<=1+1e-6,
      normalFaces:faces,groups:shell.geometry.groups.length
    };
  })()`);
  const faces = results.texture.normalFaces ?? {};
  assertProbe(results.texture.shell && results.texture.shellName === "board-surface-shell", "named surface shell missing");
  assertProbe(results.texture.materialCount === 1 && results.texture.mappedMaterialCount === 1 && results.texture.mapShared, "shell is not using one shared mapped material");
  assertProbe(results.texture.uvInRange, `shell UVs invalid (${results.texture.uvMin}..${results.texture.uvMax})`);
  assertProbe([faces.px, faces.nx, faces.py, faces.ny, faces.pz, faces.nz].every((n) => n > 0), "shell normals do not cover both caps, nose/tail and sides");

  const wrapViews = [
    { name: "top", eye: [0, 2.45, 0.12], target: [0, 0, 0] },
    { name: "underside", eye: [0, -1.75, 0.05], target: [0, -0.02, 0], hideUnder: true },
    { name: "nose", eye: [0, 0.24, -2.45], target: [0, 0, -0.3] },
    { name: "tail", eye: [0, 0.24, 2.45], target: [0, 0, 0.3] },
    { name: "port", eye: [-2.2, 0.24, 0], target: [-0.08, 0, 0] },
    { name: "starboard", eye: [2.2, 0.24, 0], target: [0.08, 0, 0] }
  ];
  results.texture.views = [];
  for (const view of wrapViews) {
    const framed = await ev(c, `(async()=>{ ${P}
      const g=sf.player.meshes.board;
      const q=g.getWorldQuaternion(new sf.THREE.Quaternion());
      const wp=g.getWorldPosition(new sf.THREE.Vector3());
      const eye=new sf.THREE.Vector3(...${JSON.stringify(view.eye)}).applyQuaternion(q).add(wp);
      const target=new sf.THREE.Vector3(...${JSON.stringify(view.target)}).applyQuaternion(q).add(wp);
      const under=window.__sfProbeUnder;
      if(under) under.visible=${view.hideUnder ? "false" : "window.__sfProbeUnderVisible"};
      window.__sfFreeCam([eye.x,eye.y,eye.z],[target.x,target.y,target.z]);
      await tick(4);
      return {eye:[eye.x,eye.y,eye.z],target:[target.x,target.y,target.z],underHidden:!!under&&!under.visible};
    })()`);
    results.texture.views.push({ name: view.name, ...framed });
    results.shots.push(await shot(c, `board-wrap-${view.name}.png`));
  }
  await ev(c, `(async()=>{ ${P}
    const rider=window.__sfProbeRider;
    if(rider) rider.visible=window.__sfProbeRiderVisible;
    const under=window.__sfProbeUnder;
    if(under) under.visible=window.__sfProbeUnderVisible;
    delete window.__sfProbeRider; delete window.__sfProbeRiderVisible;
    delete window.__sfProbeUnder; delete window.__sfProbeUnderVisible;
    window.__sfFreeCam(null); await tick(4); return true;
  })()`);
  // night shot: glow check on the last config
  await ev(c, `(async()=>{ ${P} ${FRAME} sf.sky.setTimeOfDay(23.2); await tick(30); frame(); await tick(4); return true; })()`);
  results.shots.push(await shot(c, "board-night.png"));
  await ev(c, `(async()=>{ ${P} sf.sky.setTimeOfDay(14.0); await tick(10); return true; })()`);

  // ---- 3. remote rider with a custom board, then re-customized ----
  results.remote = await ev(c, `(async()=>{ ${P}
    const cfgA=${JSON.stringify(CONFIGS[1].cfg)}, cfgB=${JSON.stringify(CONFIGS[2].cfg)};
    sf.remotes.add({id:999,name:'Probe Pal',hue:120,board:cfgA});
    const p=sf.player.position;
    const t=performance.now();
    // two samples straddling the 150ms interp delay so #embody runs
    sf.remotes.sample(999,{t:t-400,mode:'board',x:p.x+4,y:p.y,z:p.z+2,qx:0,qy:0,qz:0,qw:1,speed:6});
    sf.remotes.sample(999,{t:t+400,mode:'board',x:p.x+5,y:p.y,z:p.z+2,qx:0,qy:0,qz:0,qw:1,speed:6});
    await tick(30);
    const a=sf.remotes.avatars.get(999);
    const before={
      embodied:a.mode==='board',keyA:a.boardKey,body:!!a.bodies.board,
      shell:a.bodies.board?.getObjectByName('board-surface-shell')?.name??null
    };
    const oldBody=a.bodies.board;
    sf.remotes.updateBoard({id:999,name:'Probe Pal',hue:120,board:cfgB});
    await tick(10);
    const after={
      keyB:a.boardKey,rebuilt:a.bodies.board!==oldBody&&!!a.bodies.board,embodied:a.mode==='board',
      shell:a.bodies.board?.getObjectByName('board-surface-shell')?.name??null
    };
    const p2=sf.player.renderPosition;
    window.__sfFreeCam([p2.x+3.4,p2.y+1.7,p2.z-4.2],[p2.x+2.2,p2.y+0.4,p2.z+1.0]);
    await tick(4);
    return { before, after };
  })()`);
  assertProbe(results.remote.before.embodied && results.remote.before.shell === "board-surface-shell", "remote v3 board did not embody wrapped shell");
  assertProbe(results.remote.after.rebuilt && results.remote.after.shell === "board-surface-shell", "remote v3 board did not rebuild wrapped shell");
  results.shots.push(await shot(c, "board-remote.png"));
  await ev(c, `(async()=>{ ${P} sf.remotes.remove(999); window.__sfFreeCam(null); await tick(5); return true; })()`);

  // ---- 4. garage panel UI ----
  // ?autostart skips the gate but never runs startGame, so the HUD (and the
  // garage button) stays hidden — submit the name form for real (the
  // remembered tutorial-screenshot gotcha), then click the toggle.
  results.ui = await ev(c, `(async()=>{ ${P}
    if(!document.body.classList.contains('started')){
      document.querySelector('[data-start-form]').requestSubmit();
      await tick(10);
    }
    const toggle=document.querySelector('.board-toggle');
    if(!toggle) return { toggle:false, started: document.body.classList.contains('started') };
    toggle.click();
    await tick(5);
    const panel=document.querySelector('.board-panel');
    const rows=panel?panel.querySelectorAll('.avatar-row').length:0;
    const swatches=panel?panel.querySelectorAll('.avatar-swatch').length:0;
    const kinds=['surface','motion','sound','thrust'];
    const labs=Object.fromEntries(kinds.map(kind=>{
      const lab=panel?.querySelector('.board-lab-'+kind);
      return [kind,{lab:!!lab,pad:!!lab?.querySelector('.board-xy-pad'),canvas:!!lab?.querySelector('.board-xy-canvas')}];
    }));
    const rowLabels=panel?[...panel.querySelectorAll('.avatar-row>.avatar-label')].map(x=>x.textContent?.trim().toLowerCase()):[];
    const finishAbsent=!panel?.querySelector('.board-lab-finish')&&!rowLabels.includes('finish');
    const pads=panel?.querySelectorAll('.board-xy-pad').length??0;
    const canvases=panel?.querySelectorAll('.board-xy-canvas').length??0;
    const rerolls=panel?panel.querySelectorAll('.board-lab-reroll').length:0;
    const open=document.querySelector('.board-ui').classList.contains('open');
    return {
      toggle:true, open, rows, swatches, mode:sf.player.mode,
      structure:{pads,canvases,rerolls,labs,rowLabels,finishAbsent,complete:pads===4&&canvases===4&&rerolls===1&&finishAbsent&&Object.values(labs).every(v=>v.lab&&v.pad&&v.canvas)},
      rects:{},
      before:{readouts:[...panel.querySelectorAll('.board-lab-readout')].map(x=>x.value)}
    };
  })()`);
  assertProbe(results.ui.toggle && results.ui.open && results.ui.structure.complete, "simplified four-lab board UI is incomplete or Finish still exists");

  // The prior UI showed the same frozen texture in every visual card. Prove
  // Motion and both audio instruments now have distinct live preview frames.
  results.ui.previewFrames = await ev(c, `(async()=>{
    const kinds=['motion','sound','thrust'];
    const checksum=canvas=>{
      const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let h=2166136261;
      for(let i=0;i<data.length;i+=97) h=Math.imul(h^data[i],16777619);
      return h>>>0;
    };
    const canvases=Object.fromEntries(kinds.map(k=>[k,document.querySelector('.board-lab-'+k+' .board-xy-canvas')]));
    const before=Object.fromEntries(kinds.map(k=>[k,canvases[k]?checksum(canvases[k]):null]));
    for(let i=0;i<8;i++) await new Promise(r=>requestAnimationFrame(r));
    const after=Object.fromEntries(kinds.map(k=>[k,canvases[k]?checksum(canvases[k]):null]));
    return {before,after,changed:Object.fromEntries(kinds.map(k=>[k,before[k]!==after[k]]))};
  })()`);
  assertProbe(Object.values(results.ui.previewFrames.changed).every(Boolean), `live pad previews did not animate: ${JSON.stringify(results.ui.previewFrames.changed)}`);

  // End coordinates intentionally land in distinct quadrants. Y is inverted by
  // the pad, so the expected committed values are noted beside each endpoint.
  const padDrags = [
    ["surface", [0.18, 0.76], [0.82, 0.18]], // scale 82, warp 82
    ["motion", [0.68, 0.68], [0.37, 0.14]],  // flow 37, reaction 86
    ["sound", [0.76, 0.2], [0.22, 0.72]],    // tone 22, motion 28
    ["thrust", [0.14, 0.82], [0.74, 0.31]]   // thrust 74, air 69
  ];
  for (const [kind, from, to] of padDrags) {
    const rect = await revealPad(c, kind);
    assertProbe(rect && rect.width > 20 && rect.height > 20, `${kind} pad is not reachable`);
    results.ui.rects[kind] = rect;
    await dragPad(c, rect, from, to);
  }
  await sleep(80);
  results.ui.afterDrag = await ev(c, `(()=>{
    const panel=document.querySelector('.board-panel');
    const saved=JSON.parse(localStorage.getItem('sf-board-v4')||'null');
    const picked=saved?{
      surfaceScale:saved.surfaceScale,surfaceWarp:saved.surfaceWarp,
      surfaceFlow:saved.surfaceFlow,surfaceReaction:saved.surfaceReaction,
      soundTone:saved.soundTone,soundMotion:saved.soundMotion,
      soundThrust:saved.soundThrust,soundAir:saved.soundAir
    }:null;
    return {
      readouts:[...panel.querySelectorAll('.board-lab-readout')].map(x=>x.value),
      saved:picked,
      committed:!!saved&&saved.surfaceScale===82&&saved.surfaceWarp===82&&
        saved.surfaceFlow===37&&saved.surfaceReaction===86&&
        saved.soundTone===22&&saved.soundMotion===28&&
        saved.soundThrust===74&&saved.soundAir===69,
      boardStyle:window.__sf.vehicleAudio.debugState.boardStyle
    };
  })()`);
  assertProbe(results.ui.afterDrag.committed, `v4 pad commit mismatch: ${JSON.stringify(results.ui.afterDrag.saved)}`);

  results.ui.reroll = await ev(c, `(()=>{
    const before=JSON.parse(localStorage.getItem('sf-board-v4')||'null')?.surfaceSeed??null;
    let button=document.querySelector('.board-lab-reroll');
    if(!button) return {clicked:false,before,after:before,changed:false};
    button.click();
    let after=JSON.parse(localStorage.getItem('sf-board-v4')||'null')?.surfaceSeed??null;
    let attempts=1;
    if(after===before){
      button=document.querySelector('.board-lab-reroll');
      button?.click(); attempts++;
      after=JSON.parse(localStorage.getItem('sf-board-v4')||'null')?.surfaceSeed??null;
    }
    return {clicked:true,before,after,attempts,changed:before!==after};
  })()`);
  assertProbe(results.ui.reroll.changed, "v4 reroll did not persist a new surface seed");

  results.ui.desktop = await measurePanel(c);
  assertProbe(results.ui.desktop.fitsViewport && results.ui.desktop.scrollReady && results.ui.desktop.allPadsReachable && results.ui.desktop.lastReachable, "desktop board panel is clipped or unreachable");
  await revealPad(c, "thrust");
  results.shots.push(await shot(c, "board-panel-audio.png"));
  await ev(c, `(()=>{ const p=document.querySelector('.board-panel'); if(p)p.scrollTop=0; return true; })()`);
  results.shots.push(await shot(c, "board-panel-desktop.png"));

  // Real short-phone viewport: panel must fit the viewport, become scrollable,
  // and expose every pad plus the final surprise-me control after scrolling.
  await c.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 667, deviceScaleFactor: 1, mobile: true });
  await sleep(80);
  await ev(c, `(()=>{ const p=document.querySelector('.board-panel'); if(p)p.scrollTop=0; return true; })()`);
  results.shots.push(await shot(c, "board-panel-mobile-top.png"));
  results.ui.mobile = await measurePanel(c);
  assertProbe(results.ui.mobile.viewport[0] === 390 && results.ui.mobile.viewport[1] === 667, "mobile viewport override did not apply");
  assertProbe(results.ui.mobile.fitsViewport && results.ui.mobile.scrollable && results.ui.mobile.scrollReady, "390x667 panel does not fit/scroll");
  assertProbe(results.ui.mobile.allPadsReachable && results.ui.mobile.lastReachable, "390x667 panel controls are not reachable");
  results.shots.push(await shot(c, "board-panel-mobile-bottom.png"));
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await sleep(50);
  await ev(c, `(async()=>{ document.querySelector('.board-toggle').click(); return true; })()`);

  // ---- 5. two audio instruments: voice + material thrust/air response ----
  results.audio = await ev(c, `(async()=>{ ${P}
    sf.player.trySwitch('walk'); await tick(10); // not riding: preview path, not live hum
    const base={hum:'crystal',pitch:2,soundTone:84,soundMotion:76};
    const sample=async(soundThrust,soundAir)=>{
      sf.vehicleAudio.setBoardStyle({...base,soundThrust,soundAir});
      sf.vehicleAudio.previewBoard();
      let peak=0;
      for(let i=0;i<58;i++){
        await tick(1);
        const v=sf.vehicleAudio.debugState.voices.find(x=>x.mode==='board');
        if(v&&v.level>peak) peak=v.level;
      }
      const state=sf.vehicleAudio.debugState;
      const runtime={...state.boardRuntime};
      for(let i=0;i<150;i++) await tick(1);
      return {runtime,peak:+peak.toFixed(3)};
    };
    const low=await sample(0,0);
    const high=await sample(100,100);
    const state=sf.vehicleAudio.debugState;
    const after=state.voices.find(x=>x.mode==='board').level;
    return {ctx:state.ctx,boardStyle:state.boardStyle,low,high,after:+after.toFixed(3)};
  })()`);
  assertProbe(results.audio.ctx === "running", `audio context is ${results.audio.ctx}`);
  assertProbe(results.audio.boardStyle.soundThrust === 100 && results.audio.boardStyle.soundAir === 100, "second audio macros did not stick");
  assertProbe(results.audio.high.runtime.response >= results.audio.low.runtime.response + 0.2, "thrust response delta is too subtle");
  assertProbe(results.audio.high.runtime.detuneCents >= results.audio.low.runtime.detuneCents + 180, "thrust pitch delta is too subtle");
  assertProbe(results.audio.high.runtime.cutoffHz >= results.audio.low.runtime.cutoffHz + 220, "thrust filter delta is too subtle");
  assertProbe(results.audio.high.runtime.airGain >= Math.max(0.02, results.audio.low.runtime.airGain * 5), "air macro did not add a material noise layer");
  assertProbe(results.audio.low.peak > 0.1 && results.audio.high.peak > 0.1 && results.audio.after < 0.02, "audio previews did not swell and decay cleanly");

  writeFileSync(path.join(OUT, "result.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  c.close(); proc.kill(); if (dev) dev.kill();
  mkdirSync(FINAL_OUT, { recursive: true });
  for (const f of [...results.shots, "result.json"]) {
    try { cpSync(path.join(OUT, f), path.join(FINAL_OUT, f)); } catch {}
  }
  console.log("[artifacts] copied to " + FINAL_OUT);
  process.exit(0);
}
main().catch((e) => { console.error("[board-style-probe] FAIL", e); process.exit(1); });
