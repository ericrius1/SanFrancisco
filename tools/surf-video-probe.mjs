// Film a short live surf run (real rAF loop, scripted keys) and assemble an
// mp4 for feel review against the KSPS reference. Frames + mp4 land in
// .data/surf-video/. Env: SF_PROBE_URL (default http://localhost:5243).
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/surf-video");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://localhost:5243";
const PROFILE = path.join(process.env.TMPDIR ?? "/tmp", `sf-video-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(){return new Promise((res,rej)=>{const s=createServer();s.once("error",rej);s.listen(0,"127.0.0.1",()=>{const{port}=s.address();s.close(()=>res(port));});});}
class Cdp{#s;#id=1;#p=new Map();constructor(u){this.#s=new WebSocket(u);}async open(){await new Promise((res,rej)=>{this.#s.addEventListener("open",res,{once:true});this.#s.addEventListener("error",rej,{once:true});});this.#s.addEventListener("message",(e)=>{const m=JSON.parse(e.data.toString());if(!m.id)return;const p=this.#p.get(m.id);if(!p)return;this.#p.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result??{});});}send(method,params={}){const id=this.#id++;this.#s.send(JSON.stringify({id,method,params}));return new Promise((res,rej)=>this.#p.set(id,{resolve:res,reject:rej}));}close(){this.#s.close();}}
async function ev(cdp,expression){const r=await cdp.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails).slice(0,600));return r.result?.value;}
async function we(cdp,expr,ms,label){const t0=Date.now();while(Date.now()-t0<ms){try{if(await ev(cdp,expr))return;}catch{}await sleep(200);}throw new Error(`timeout ${label}`);}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const chromePort = await freePort();
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  `--remote-debugging-port=${chromePort}`, `--user-data-dir=${PROFILE}`,
  "--headless=new", "--no-first-run", "--mute-audio", "--enable-unsafe-webgpu",
  "--enable-gpu", "--use-angle=metal", "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
  "--window-size=1280,720", "--force-device-scale-factor=1", "about:blank"
], { stdio: "ignore" });
try {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { try { await (await fetch(`http://127.0.0.1:${chromePort}/json/version`)).json(); break; } catch {} await sleep(200); }
  const page = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: "PUT" })).json();
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${SERVER_URL}/?autostart=1&fullfps=1&spawn=oceanBeach` });
  await we(cdp, "Boolean(document.body.classList.contains('started')&&window.__sf?.player)", 180000, "started");
  await ev(cdp, `(()=>{const s=window.__sf;if(!s.renderIdle?.())s.pipeline.warmup=async()=>{};return true;})()`);
  await we(cdp, "window.__sf.renderIdle?.()===true", 30000, "idle");
  await sleep(800);
  await ev(cdp, "(()=>{document.body.classList.add('ui-hidden');const h=document.getElementById('hud');if(h)h.style.opacity='0.35';return true})()");
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyE", key: "e", windowsVirtualKeyCode: 69 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyE", key: "e", windowsVirtualKeyCode: 69 });
  await we(cdp, "window.__sf.player.mode==='surf'", 15000, "surf");
  await sleep(1200);

  // Scripted run driven in wall time against the LIVE loop:
  // neutral → drop carve → climb to launch → air spin → land → pocket.
  const script = await ev(cdp, `(()=>{
    const s=window.__sf;
    const dir=s.player.surfTelemetry.lineDirection;
    const climb=dir>0?'KeyD':'KeyA';
    const drop=dir>0?'KeyA':'KeyD';
    const steps=[
      {t:0.0, keys:[]},
      {t:1.2, keys:[drop]},
      {t:2.6, keys:[climb]},
      {t:5.2, keys:[climb]},        // hold through launch; spins in air
      {t:6.6, keys:[]},             // release for landing assist
      {t:8.4, keys:[]}
    ];
    window.__filmScript={steps,started:performance.now()/1000};
    const drive=()=>{
      const now=performance.now()/1000-window.__filmScript.started;
      let active=steps[0].keys;
      for(const st of steps){if(now>=st.t)active=st.keys;}
      s.input.keys.clear();
      for(const k of active)s.input.keys.add(k);
      if(now<9.0)requestAnimationFrame(drive);
      else s.input.keys.clear();
    };
    requestAnimationFrame(drive);
    return {climb,drop};
  })()`);
  console.log("script", JSON.stringify(script));

  const frames = 72; // ~9 s at ~8 fps capture
  for (let i = 0; i < frames; i++) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 82 });
    writeFileSync(path.join(OUT, `frame-${String(i).padStart(3, "0")}.jpg`), Buffer.from(shot.data, "base64"));
    await sleep(60);
  }
  const tail = await ev(cdp, `(()=>{const t=window.__sf.player.surfTelemetry;
    return {launch:t.launchSerial,landing:t.landingSerial,spin:t.landedSpin,phase:t.phase,cutbacks:t.cutbackSerial};})()`);
  console.log("run:", JSON.stringify(tail));
  cdp.close();
} finally {
  chrome.kill("SIGTERM");
  await sleep(300);
  rmSync(PROFILE, { recursive: true, force: true });
}
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "8", "-i", path.join(OUT, "frame-%03d.jpg"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "24", path.join(OUT, "review.mp4")]);
console.log("video:", path.join(OUT, "review.mp4"));
