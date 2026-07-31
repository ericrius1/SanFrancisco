// Headless skateboarding probe. Boots at the Golden Gate Park skate plaza and
// exercises the whole feature: the plaza's ground overlay, pushing on flat,
// bombing a real SF hill, the charged ollie, a flip trick, and locking a grind
// onto a registered rail. Prints one JSON blob and writes screenshots.
//
//   node tools/skate-probe.mjs [label]
// Env: SF_PROBE_URL (its own vite; NOT 5179), SF_PROBE_OUT (default .data/skate)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FINAL_OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/skate");
// Live writes go OUTSIDE the project: vite watches the tree and any write in it
// triggers a reload that destroys the WebGPU device mid-drive.
const TMP = path.join(process.env.TMPDIR ?? "/tmp", "sf-skate-probe");
const OUT = path.join(TMP, "out");
const PROFILE_ROOT = path.join(TMP, "profile");
let SERVER_URL = process.env.SF_PROBE_URL ?? "";
const W = 1280;
const H = 800;
const LABEL = process.argv[2] ?? "run";
// A properly steep Nob Hill block, same one the hoverboard probe uses.
const HILL = { x: Number(process.env.SF_HILL_X ?? 3376), z: Number(process.env.SF_HILL_Z ?? -976) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  for (const c of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean)) {
    if (c.includes("/") && !existsSync(c)) continue;
    return c;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}
function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}
async function waitHttp(url, ms, label) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url, { cache: "no-store" })).ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`timeout ${label}: ${url}`);
}
/** Never trust a port another session may be squatting: prove it serves OUR tree. */
async function assertOurServer() {
  const res = await fetch(`${SERVER_URL}/src/vehicles/skate/controller.ts`, { cache: "no-store" });
  const body = await res.text();
  if (!body.includes("SkateController")) {
    throw new Error(`${SERVER_URL} is not serving this worktree (no SkateController)`);
  }
}
async function startDev() {
  if (SERVER_URL) {
    // A caller-supplied server still has to prove it is OUR tree — other
    // sessions squat these ports and a stale build silently invalidates a run.
    try {
      await waitHttp(SERVER_URL, 2000, "existing vite");
      await assertOurServer();
      return null;
    } catch (e) {
      if (String(e).includes("not serving this worktree")) throw e;
    }
  } else {
    SERVER_URL = `http://127.0.0.1:${await freePort()}`;
  }
  const relay = await freePort();
  const vitePort = Number(new URL(SERVER_URL).port);
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { cwd: ROOT, env: { ...process.env, SF_RELAY_PORT: String(relay) }, stdio: ["ignore", "ignore", "ignore"] }
  );
  await waitHttp(SERVER_URL, 120000, "vite");
  await assertOurServer();
  return child;
}
class Cdp {
  #ws;
  #id = 1;
  #p = new Map();
  constructor(u) {
    this.#ws = new WebSocket(u);
  }
  async open() {
    await new Promise((res, rej) => {
      this.#ws.addEventListener("open", res, { once: true });
      this.#ws.addEventListener("error", rej, { once: true });
    });
    this.#ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data.toString());
      if (!m.id) return;
      const p = this.#p.get(m.id);
      if (!p) return;
      this.#p.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result ?? {});
    });
  }
  send(method, params = {}) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.#p.set(id, { res, rej, method }));
  }
  close() {
    this.#ws.close();
  }
}
async function ev(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 900)}`);
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
  const proc = spawn(
    chrome,
    [
      `--user-data-dir=${path.join(PROFILE_ROOT, LABEL + "-" + Date.now())}`,
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures",
      "--use-angle=metal",
      "--hide-scrollbars",
      "--mute-audio",
      `--window-size=${W},${H}`,
      `${SERVER_URL}/?autostart&fullfps&spawn=skatePlaza`
    ],
    { cwd: ROOT, stdio: "ignore" }
  );
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
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  const dbg = new WebSocket(page.webSocketDebuggerUrl);
  dbg.addEventListener("message", (e) => {
    try {
      const m = JSON.parse(e.data.toString());
      if (m.method === "Runtime.exceptionThrown") {
        console.log("[page-exc]", (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || "").slice(0, 300));
      }
      if (m.method === "Inspector.targetCrashed") console.log("[CRASHED]");
    } catch {}
  });
  await new Promise((r) => dbg.addEventListener("open", r, { once: true }));
  dbg.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
  dbg.send(JSON.stringify({ id: 2, method: "Inspector.enable" }));
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 240000) {
    try {
      if (await ev(c, `!!(window.__sf&&window.__sf.player&&window.__sf.renderer&&window.__sf.renderer.backend&&window.__sf.renderer.backend.device)`)) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(600);
  }
  if (!ready) throw new Error("app never ready");
  await ev(c, `window.__sfManual&&window.__sfManual(true)`);

  const P = `const sf=window.__sf; const dev=sf.renderer.backend.device;
    const tick=async(n)=>{ for(let i=0;i<n;i++){ sf.tick(1/60); await dev.queue.onSubmittedWorkDone(); } };
    const key=(code,down)=> window.dispatchEvent(new KeyboardEvent(down?'keydown':'keyup',{code,bubbles:true}));
    const sp=()=>Math.hypot(sf.player.velocity.x, sf.player.velocity.z);`;

  // Let physics/tiles/site loading settle. The plaza is a proximity site, so
  // the spawn inside it must bring it in.
  for (let k = 0; k < 22; k++) {
    try {
      await ev(c, `(async()=>{ ${P} await tick(20); return true; })()`);
    } catch {}
    await sleep(250);
  }

  // ---- 1. the plaza itself ------------------------------------------------
  const plaza = await ev(c, `(async()=>{ ${P}
    const meta = await import('/src/world/skatePlaza/meta.ts');
    const railsMod = await import('/src/vehicles/skate/rails.ts');
    const {x:cx, z:cz} = meta.SKATE_PLAZA_CENTER;
    const rails = railsMod.allGrindRails().map(r=>({id:r.id, ax:+r.ax.toFixed(2), ay:+r.ay.toFixed(2), az:+r.az.toFixed(2), bx:+r.bx.toFixed(2), by:+r.by.toFixed(2), bz:+r.bz.toFixed(2), kind:r.kind, lift:r.lift}));
    const base = sf.map.baseGroundTop(cx, cz);
    const top = sf.map.groundTop(cx, cz);
    // A point well outside the taper must be untouched.
    const farBase = sf.map.baseGroundTop(cx+220, cz);
    const farTop = sf.map.groundTop(cx+220, cz);
    const c=Math.cos(meta.SKATE_PLAZA_YAW), s=Math.sin(meta.SKATE_PLAZA_YAW);
    const toWorld=(lx,lz)=>({x:cx+lx*c+lz*s,z:cz-lx*s+lz*c});
    const deck=toWorld(3,-18), launch=toWorld(27,-5), ledge=toWorld(21,-17.2);
    const authoredSurfaces={
      deck:+(sf.map.groundTop(deck.x,deck.z)-sf.skatePlaza.deckLevel).toFixed(2),
      launch:+(sf.map.groundTop(launch.x,launch.z)-sf.skatePlaza.deckLevel).toFixed(2),
      ledge:+(sf.map.groundTop(ledge.x,ledge.z)-sf.skatePlaza.deckLevel).toFixed(2)
    };
    return { loaded: !!sf.skatePlaza, railCount: rails.length, rails,
             center:{x:cx,z:cz}, base:+base.toFixed(2), top:+top.toFixed(2),
             lift:+(top-base).toFixed(2), farUntouched: Math.abs(farTop-farBase) < 1e-6,
             authoredSurfaces };
  })()`);

  // The skate lesson uses the same top-centre lane as the city tutorial. It
  // used to inherit the score stack's lower-left anchor, where chat and the
  // toolbar could cover it on wide screens.
  const coach = await ev(c, `(()=>{
    const el=document.querySelector('#hud .skate-ui .coach');
    const r=el?.getBoundingClientRect();
    return r ? { visible:getComputedStyle(el).display!=='none', top:+r.top.toFixed(1),
                 centerDelta:+(r.left+r.width/2-innerWidth/2).toFixed(1), width:+r.width.toFixed(1) }
             : { visible:false, missing:true };
  })()`);
  const coachShot = await shot(c, `coach-${LABEL}.png`);

  // ---- 2. pushing on the flat --------------------------------------------
  const push = await ev(c, `(async()=>{ ${P}
    const meta = await import('/src/world/skatePlaza/meta.ts');
    const X = meta.SKATE_PLAZA_CENTER.x, Z = meta.SKATE_PLAZA_CENTER.z;
    // Open flat line in local +Z: no stair set or ledge in the measurement.
    sf.player.teleportTo({x:X, y:sf.map.effectiveGround(X,Z)+0.5, z:Z,
                          facing:meta.SKATE_PLAZA_YAW+Math.PI, mode:'skate'});
    await tick(40);
    const sx=sf.player.position.x, sz=sf.player.position.z;
    key('KeyW',true);
    let peak=0;
    for(let i=0;i<300;i++){ await tick(1); peak=Math.max(peak, sp()); }
    key('KeyW',false);
    const dist=Math.hypot(sf.player.position.x-sx, sf.player.position.z-sz);
    const st=sf.player.skateState;
    await tick(120);
    return { dist5s:+dist.toFixed(2), peak:+peak.toFixed(2), coastAfter2s:+sp().toFixed(2),
             grounded: st.grounded, y:+sf.player.position.y.toFixed(2) };
  })()`);

  // ---- 3. ollie + flip trick ---------------------------------------------
  const air = await ev(c, `(async()=>{ ${P}
    const meta = await import('/src/world/skatePlaza/meta.ts');
    const X = meta.SKATE_PLAZA_CENTER.x, Z = meta.SKATE_PLAZA_CENTER.z;
    sf.player.teleportTo({x:X, y:sf.map.effectiveGround(X,Z)+0.5, z:Z,
                          facing:meta.SKATE_PLAZA_YAW+Math.PI, mode:'skate'});
    await tick(40);
    key('KeyW',true);
    for(let i=0;i<120;i++) await tick(1);
    const yBefore=sf.player.position.y;
    // charged ollie: hold ~0.35s then release
    key('Space',true);
    for(let i=0;i<21;i++) await tick(1);
    key('Space',false);
    let vyPeak=-99, yPeak=-9999, sawAir=false;
    for(let i=0;i<12;i++){ await tick(1); vyPeak=Math.max(vyPeak, sf.player.velocity.y); yPeak=Math.max(yPeak, sf.player.position.y); if(!sf.player.skateState.grounded) sawAir=true; }
    key('KeyW',false); await tick(1);                        // neutral modifier
    key('KeyQ',true); await tick(1); key('KeyQ',false);      // plain kickflip
    for(let i=0;i<80;i++){ await tick(1); vyPeak=Math.max(vyPeak, sf.player.velocity.y); yPeak=Math.max(yPeak, sf.player.position.y); if(!sf.player.skateState.grounded) sawAir=true; }
    await tick(40);
    const book=sf.player.skateTricks;
    return { vyPeak:+vyPeak.toFixed(2), airGain:+(yPeak-yBefore).toFixed(2), sawAir,
             score: book.score, banner: book.banner.text, bailed: book.banner.bailed };
  })()`);

  // ---- 4. solid obstacle faces + a calm missed landing -------------------
  // The park's collision authority is a height field. Drive a deliberately
  // low ollie into the 2.4 m half-pipe deck's vertical face: it must stop at the
  // face, never enter the footprint and get catapulted onto the top.
  const obstacle = await ev(c, `(async()=>{ ${P}
    const meta = await import('/src/world/skatePlaza/meta.ts');
    const c=Math.cos(meta.SKATE_PLAZA_YAW), s=Math.sin(meta.SKATE_PLAZA_YAW);
    const toWorld=(lx,lz)=>({x:meta.SKATE_PLAZA_CENTER.x+lx*c+lz*s,
                             z:meta.SKATE_PLAZA_CENTER.z-lx*s+lz*c});
    const toLocal=(x,z)=>({x:(x-meta.SKATE_PLAZA_CENTER.x)*c-(z-meta.SKATE_PLAZA_CENTER.z)*s,
                           z:(x-meta.SKATE_PLAZA_CENTER.x)*s+(z-meta.SKATE_PLAZA_CENTER.z)*c});
    const start=toWorld(-3,9);
    sf.player.teleportTo({x:start.x,y:sf.map.effectiveGround(start.x,start.z)+0.5,z:start.z,
                          facing:meta.SKATE_PLAZA_YAW+Math.PI/2,mode:'skate'});
    await tick(40);
    key('KeyW',true);
    let popped=false, maxVy=-99, maxVyAt=null, minX=99, crossed=false;
    for(let i=0;i<240;i++){
      const local=toLocal(sf.player.position.x,sf.player.position.z);
      const gap=local.x-(-8);
      if(!popped && gap<1.5 && gap>0.75){ key('Space',true); await tick(1); key('Space',false); popped=true; }
      await tick(1);
      const now=toLocal(sf.player.position.x,sf.player.position.z);
      minX=Math.min(minX,now.x); crossed ||= now.x < -8.02;
      if(sf.player.velocity.y>maxVy){ maxVy=sf.player.velocity.y; maxVyAt={x:+now.x.toFixed(2),y:+sf.player.position.y.toFixed(2)}; }
    }
    key('KeyW',false); key('Space',false); await tick(30);
    const end=toLocal(sf.player.position.x,sf.player.position.z);
    return {popped,crossed,minLocalX:+minX.toFixed(2),endLocalX:+end.x.toFixed(2),
            maxVy:+maxVy.toFixed(2),maxVyAt,endSpeed:+sp().toFixed(2)};
  })()`);

  // Start a frontflip too late to finish it. The miss may flail the rider, but
  // the dynamic collider must remain upright and must not be solver-launched.
  const bail = await ev(c, `(async()=>{ ${P}
    const meta = await import('/src/world/skatePlaza/meta.ts');
    const c=Math.cos(meta.SKATE_PLAZA_YAW), s=Math.sin(meta.SKATE_PLAZA_YAW);
    const p={x:meta.SKATE_PLAZA_CENTER.x,z:meta.SKATE_PLAZA_CENTER.z};
    sf.player.teleportTo({x:p.x,y:sf.map.effectiveGround(p.x,p.z)+0.5,z:p.z,
                          facing:meta.SKATE_PLAZA_YAW+Math.PI,mode:'skate'});
    await tick(40); key('KeyW',true); for(let i=0;i<100;i++) await tick(1);
    key('Space',true); for(let i=0;i<12;i++) await tick(1); key('Space',false); key('KeyW',false);
    let armed=false,sawBail=false,maxStep=0,maxTilt=0,maxSpeed=0,maxBailStep=0,maxBailTilt=0;
    let px=sf.player.position.x,pz=sf.player.position.z;
    for(let i=0;i<180;i++){
      if(!armed && sf.player.skateAirTime>0.54){ key('KeyW',true); armed=true; }
      await tick(1);
      const q=sf.player.quaternion;
      const upY=Math.max(-1,Math.min(1,1-2*(q.x*q.x+q.z*q.z)));
      const tilt=Math.acos(upY), step=Math.hypot(sf.player.position.x-px,sf.player.position.z-pz);
      maxTilt=Math.max(maxTilt,tilt); maxSpeed=Math.max(maxSpeed,sp()); maxStep=Math.max(maxStep,step);
      if(sf.player.skateState.bailing){ maxBailTilt=Math.max(maxBailTilt,tilt); maxBailStep=Math.max(maxBailStep,step); }
      px=sf.player.position.x; pz=sf.player.position.z;
      sawBail ||= sf.player.skateState.bailing;
      if(sawBail && !sf.player.skateState.bailing) break;
    }
    key('KeyW',false); key('KeyQ',false); key('Space',false); await tick(20);
    return {armed,sawBail,maxStep:+maxStep.toFixed(3),maxTilt:+maxTilt.toFixed(3),
            maxSpeed:+maxSpeed.toFixed(2),maxBailStep:+maxBailStep.toFixed(3),
            maxBailTilt:+maxBailTilt.toFixed(3)};
  })()`);

  // ---- 5. grind a rail ----------------------------------------------------
  const grind = await ev(c, `(async()=>{ ${P}
    const railsMod = await import('/src/vehicles/skate/rails.ts');
    const bar = railsMod.allGrindRails().find(r=>r.id.endsWith('flatbar-w'));
    if (!bar) return { error:'no flat bar registered' };
    const dx=bar.bx-bar.ax, dz=bar.bz-bar.az, L=Math.hypot(dx,dz);
    const ux=dx/L, uz=dz/L;
    // Start 16 m upstream of the bar's A end, lined up straight down it.
    const X=bar.ax-ux*16, Z=bar.az-uz*16;
    const facing=Math.atan2(-ux,-uz);
    sf.player.teleportTo({x:X, y:sf.map.effectiveGround(X,Z)+0.5, z:Z, facing, mode:'skate'});
    await tick(40);
    key('KeyW',true);
    let popped=false, locked=false, name='', maxSpeed=0, poppedAt=-1;
    for(let i=0;i<420;i++){
      await tick(1);
      const p=sf.player.position;
      // distance to the bar's A end, along the approach
      const d=(bar.ax-p.x)*ux + (bar.az-p.z)*uz;
      maxSpeed=Math.max(maxSpeed, sp());
      if(!popped && d<1.6 && d>0 && sf.player.skateState.grounded){
        key('Space',true); await tick(1); key('Space',false);
        popped=true; poppedAt=+d.toFixed(2);
      }
      const st=sf.player.skateState;
      if(st.grinding){ locked=true; name=st.grindName; }
      if(locked && !st.grinding) break;
    }
    key('KeyW',false);
    await tick(60);
    const book=sf.player.skateTricks;
    return { bar:bar.id, poppedAt, locked, name, maxSpeed:+maxSpeed.toFixed(2),
             score: book.score, banner: book.banner.text, bailed: book.banner.bailed };
  })()`);

  // ---- 6. a look at the RIDER --------------------------------------------
  // The stance is the thing that has to read, so frame the skater, not the map.
  await ev(c, `(async()=>{ ${P} sf.sky.setTimeOfDay(11.5); await tick(20); return true; })()`);
  const poses = [
    { name: "roll", setup: "key('KeyW',true); for(let i=0;i<150;i++) await tick(1); key('KeyW',false); for(let i=0;i<40;i++) await tick(1);" },
    { name: "push", setup: "key('KeyW',true); for(let i=0;i<150;i++) await tick(1); for(let i=0;i<7;i++) await tick(1);" },
    { name: "carve", setup: "key('KeyW',true); for(let i=0;i<150;i++) await tick(1); key('KeyW',false); key('KeyA',true); for(let i=0;i<40;i++) await tick(1);" },
    { name: "air", setup: "key('KeyW',true); for(let i=0;i<150;i++) await tick(1); key('Space',true); for(let i=0;i<20;i++) await tick(1); key('Space',false); key('KeyW',false); for(let i=0;i<16;i++) await tick(1);" },
    { name: "crouch", setup: "key('KeyW',true); for(let i=0;i<150;i++) await tick(1); key('KeyW',false); key('Space',true); for(let i=0;i<20;i++) await tick(1);" }
  ];
  const shots = [];
  for (const pose of poses) {
    await ev(c, `(async()=>{ ${P}
      for (const k of ['KeyW','KeyA','KeyD','KeyS','Space','ShiftLeft']) key(k,false);
      const meta = await import('/src/world/skatePlaza/meta.ts');
      const X = meta.SKATE_PLAZA_CENTER.x, Z = meta.SKATE_PLAZA_CENTER.z - 11;
      window.__sfFreeCam(null);
      sf.player.teleportTo({x:X, y:sf.map.effectiveGround(X,Z)+0.5, z:Z, facing:Math.PI/2, mode:'skate'});
      await tick(40);
      ${pose.setup}
      // Park a camera three metres off the board's left shoulder, at deck height.
      const p = sf.player.renderPosition;
      window.__sfFreeCam([p.x - 1.0, p.y + 0.55, p.z - 2.9],[p.x, p.y + 0.25, p.z]);
      await tick(4);
      for (const k of ['KeyW','KeyA','KeyD','KeyS','Space','ShiftLeft']) key(k,false);
      return true;
    })()`);
    shots.push(await shot(c, `rider-${pose.name}-${LABEL}.png`));
  }
  await ev(c, `window.__sfFreeCam(null)`);

  // ---- 7. bombing a hill (LAST: 3.9 km away unloads the plaza) --------------------------------------------------
  const hill = await ev(c, `(async()=>{ ${P}
    const X=${HILL.x}, Z=${HILL.z};
    const gy=sf.map.effectiveGround(X,Z);
    const e=3, rg=(x,z)=>sf.map.rideGround(x,z,gy);
    const gx=rg(X+e,Z)-rg(X-e,Z), gz=rg(X,Z+e)-rg(X,Z-e);
    const gl=Math.hypot(gx,gz)||1e-6;
    const grade=gl/(2*e);
    // deck fwd = (-sin,-cos): point it DOWN the gradient
    const facing=Math.atan2(gx/gl, gz/gl);
    sf.player.teleportTo({x:X, y:gy+0.5, z:Z, facing, mode:'skate'});
    await tick(40);
    const sx=sf.player.position.x, sz=sf.player.position.z, sy=sf.player.position.y;
    let peak=0;
    for(let i=0;i<420;i++){ await tick(1); peak=Math.max(peak, sp()); }   // 7s, no input
    return { gradePct:+(grade*100).toFixed(1), peak:+peak.toFixed(2),
             dropped:+(sy-sf.player.position.y).toFixed(2),
             dist:+Math.hypot(sf.player.position.x-sx, sf.player.position.z-sz).toFixed(2) };
  })()`);


  const result = { label: LABEL, plaza, coach, coachShot, push, hill, air, obstacle, bail, grind, shots };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync(path.join(OUT, `skate-${LABEL}.json`), JSON.stringify(result, null, 2));

  c.close();
  dbg.close();
  proc.kill();
  dev?.kill();
  await sleep(700);
  mkdirSync(FINAL_OUT, { recursive: true });
  cpSync(OUT, FINAL_OUT, { recursive: true });
  console.log("artifacts →", FINAL_OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
