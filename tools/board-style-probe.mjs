// Headless hoverboard-customizer probe. Boots the real app (own vite, WebGPU/
// metal), rides the board on a known Castro street anchor, then:
//   1. swaps through customizer configs via player.setBoardConfig (screenshots
//      each procedural surface, a close overhead texture shot, and night glow),
//   2. spawns a fake remote rider with a custom board and re-customizes it
//      (exercises remotes.updateBoard's dispose/rebuild path),
//   3. opens the garage panel, verifies both XY canvases + reroll, and drives
//      each pad through Chrome input so pointer capture/commit paths execute,
//   4. re-voices the hum + macro controls and samples vehicleAudio.debugState
//      to prove the selected style sticks while the voice swells and decays.
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

const CONFIGS = [
  { name: "classic", cfg: { shape: "classic", fin: "none", deck: 0, trim: 5, glow: 0, surface: "aurora", surfaceScale: 24, surfaceWarp: 68, surfaceSeed: 101, hum: "hum", pitch: 0, soundTone: 45, soundMotion: 35 } },
  { name: "dart", cfg: { shape: "dart", fin: "spoiler", deck: 1, trim: 3, glow: 4, surface: "topo", surfaceScale: 70, surfaceWarp: 18, surfaceSeed: 202, hum: "retro", pitch: 3, soundTone: 80, soundMotion: 72 } },
  { name: "manta", cfg: { shape: "manta", fin: "halo", deck: 4, trim: 5, glow: 3, surface: "terrazzo", surfaceScale: 48, surfaceWarp: 88, surfaceSeed: 303, hum: "choir", pitch: 1, soundTone: 32, soundMotion: 64 } },
  { name: "saucer", cfg: { shape: "saucer", fin: "twin", deck: 5, trim: 6, glow: 2, surface: "circuit", surfaceScale: 76, surfaceWarp: 42, surfaceSeed: 404, hum: "crystal", pitch: 4, soundTone: 68, soundMotion: 82 } }
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

  const results = { shots: [], boards: [], texture: {}, remote: {}, audio: {}, ui: {}, errors: [] };

  // ---- 1. config swaps on the local player ----
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
  // Texture proof: hide only the rider rig, then move close and above the live
  // board. This keeps the real world lighting/material path while exposing the
  // whole top surface instead of photographing it through the rider's legs.
  results.texture = await ev(c, `(async()=>{ ${P}
    const g=sf.player.meshes.board;
    const rider=g.children.find(o=>o.isGroup&&o.children.length>0&&o.position.y>0.75&&o.position.y<1.1);
    if(rider){ window.__sfProbeRider=rider; window.__sfProbeRiderVisible=rider.visible; rider.visible=false; }
    const wp=g.getWorldPosition(new sf.THREE.Vector3());
    window.__sfFreeCam([wp.x+0.55,wp.y+2.2,wp.z-0.45],[wp.x,wp.y+0.02,wp.z]);
    await tick(4);
    const surface=g.userData.boardSurface;
    return { riderHidden:!!rider, hasSurface:!!surface, canvas:surface?.canvas?[surface.canvas.width,surface.canvas.height]:null };
  })()`);
  results.shots.push(await shot(c, "board-surface-close.png"));
  await ev(c, `(async()=>{ ${P}
    const rider=window.__sfProbeRider;
    if(rider) rider.visible=window.__sfProbeRiderVisible;
    delete window.__sfProbeRider; delete window.__sfProbeRiderVisible;
    window.__sfFreeCam(null); await tick(4); return true;
  })()`);
  // night shot: glow check on the last config
  await ev(c, `(async()=>{ ${P} ${FRAME} sf.sky.setTimeOfDay(23.2); await tick(30); frame(); await tick(4); return true; })()`);
  results.shots.push(await shot(c, "board-night.png"));
  await ev(c, `(async()=>{ ${P} sf.sky.setTimeOfDay(14.0); await tick(10); return true; })()`);

  // ---- 2. remote rider with a custom board, then re-customized ----
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
    const before={ embodied:a.mode==='board', keyA:a.boardKey, body:!!a.bodies.board };
    const oldBody=a.bodies.board;
    sf.remotes.updateBoard({id:999,name:'Probe Pal',hue:120,board:cfgB});
    await tick(10);
    const after={ keyB:a.boardKey, rebuilt: a.bodies.board!==oldBody && !!a.bodies.board, embodied:a.mode==='board' };
    const p2=sf.player.renderPosition;
    window.__sfFreeCam([p2.x+3.4,p2.y+1.7,p2.z-4.2],[p2.x+2.2,p2.y+0.4,p2.z+1.0]);
    await tick(4);
    return { before, after };
  })()`);
  results.shots.push(await shot(c, "board-remote.png"));
  await ev(c, `(async()=>{ ${P} sf.remotes.remove(999); window.__sfFreeCam(null); await tick(5); return true; })()`);

  // ---- 3. garage panel UI ----
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
    const pads=panel?[...panel.querySelectorAll('.board-xy-pad')]:[];
    const canvases=panel?panel.querySelectorAll('.board-xy-canvas').length:0;
    const rerolls=panel?panel.querySelectorAll('.board-lab-reroll').length:0;
    const rect=(el)=>{ const r=el?.getBoundingClientRect(); return r?{left:r.left,top:r.top,width:r.width,height:r.height}:null; };
    const open=document.querySelector('.board-ui').classList.contains('open');
    return {
      toggle:true, open, rows, swatches, mode:sf.player.mode,
      structure:{pads:pads.length,canvases,rerolls,complete:pads.length===2&&canvases===2&&rerolls===1},
      rects:{surface:rect(pads[0]),sound:rect(pads[1])},
      before:{readouts:[...panel.querySelectorAll('.board-lab-readout')].map(x=>x.value)}
    };
  })()`);
  if (results.ui.rects?.surface && results.ui.rects?.sound) {
    // End coordinates intentionally land in different quadrants, making it
    // obvious that both X and Y values changed and committed through pointerup.
    await dragPad(c, results.ui.rects.surface, [0.18, 0.76], [0.82, 0.18]);
    await dragPad(c, results.ui.rects.sound, [0.76, 0.2], [0.22, 0.72]);
    await sleep(80);
    results.ui.afterDrag = await ev(c, `(()=>{
      const panel=document.querySelector('.board-panel');
      const saved=JSON.parse(localStorage.getItem('sf-board-v2')||'null');
      return {
        readouts:[...panel.querySelectorAll('.board-lab-readout')].map(x=>x.value),
        saved:saved?{surfaceScale:saved.surfaceScale,surfaceWarp:saved.surfaceWarp,soundTone:saved.soundTone,soundMotion:saved.soundMotion}:null,
        committed:!!saved&&saved.surfaceScale===82&&saved.surfaceWarp===82&&saved.soundTone===22&&saved.soundMotion===28,
        boardStyle:window.__sf.vehicleAudio.debugState.boardStyle
      };
    })()`);
    results.ui.reroll = await ev(c, `(()=>{
      const before=JSON.parse(localStorage.getItem('sf-board-v2')||'null')?.surfaceSeed??null;
      let button=document.querySelector('.board-lab-reroll');
      if(!button) return {clicked:false,before,after:before,changed:false};
      button.click();
      let after=JSON.parse(localStorage.getItem('sf-board-v2')||'null')?.surfaceSeed??null;
      let attempts=1;
      if(after===before){
        button=document.querySelector('.board-lab-reroll');
        button?.click(); attempts++;
        after=JSON.parse(localStorage.getItem('sf-board-v2')||'null')?.surfaceSeed??null;
      }
      return {clicked:true,before,after,attempts,changed:before!==after};
    })()`);
  }
  results.shots.push(await shot(c, "board-panel.png"));
  await ev(c, `(async()=>{ document.querySelector('.board-toggle').click(); return true; })()`);

  // ---- 4. hum re-voice + preview swell ----
  results.audio = await ev(c, `(async()=>{ ${P}
    sf.player.trySwitch('walk'); await tick(10); // not riding: preview path, not live hum
    sf.vehicleAudio.setBoardStyle({hum:'crystal',pitch:2,soundTone:84,soundMotion:76});
    sf.vehicleAudio.previewBoard();
    let peak=0;
    for(let i=0;i<70;i++){ await tick(1); const v=sf.vehicleAudio.debugState.voices.find(x=>x.mode==='board'); if(v&&v.level>peak) peak=v.level; }
    for(let i=0;i<160;i++){ await tick(1); }
    const state=sf.vehicleAudio.debugState;
    const after=state.voices.find(x=>x.mode==='board').level;
    return { ctx:state.ctx, boardStyle:state.boardStyle, peak:+peak.toFixed(3), after:+after.toFixed(3) };
  })()`);

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
