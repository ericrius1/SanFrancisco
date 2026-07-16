// Isolate the "grey strip through the wave" artifact: enter surf, freeze on a
// deterministic frame, then screenshot with individual water/wave layers
// toggled to see which mesh paints the band.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, ".data/surf-strip-debug");
const SERVER_URL = process.env.SF_PROBE_URL ?? "http://localhost:5243";
const PROFILE = path.join(process.env.TMPDIR ?? "/tmp", `sf-strip-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(){return new Promise((res,rej)=>{const s=createServer();s.once("error",rej);s.listen(0,"127.0.0.1",()=>{const{port}=s.address();s.close(()=>res(port));});});}
class Cdp{#s;#id=1;#p=new Map();constructor(u){this.#s=new WebSocket(u);}async open(){await new Promise((res,rej)=>{this.#s.addEventListener("open",res,{once:true});this.#s.addEventListener("error",rej,{once:true});});this.#s.addEventListener("message",(e)=>{const m=JSON.parse(e.data.toString());if(!m.id)return;const p=this.#p.get(m.id);if(!p)return;this.#p.delete(m.id);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result??{});});}send(method,params={}){const id=this.#id++;this.#s.send(JSON.stringify({id,method,params}));return new Promise((res,rej)=>this.#p.set(id,{resolve:res,reject:rej}));}close(){this.#s.close();}}
async function ev(cdp,expression){const r=await cdp.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails).slice(0,700));return r.result?.value;}
async function we(cdp,expr,ms,label){const t0=Date.now();while(Date.now()-t0<ms){try{if(await ev(cdp,expr))return;}catch{}await sleep(200);}throw new Error(`timeout ${label}`);}
async function shot(cdp,name){
  await ev(cdp,`(async()=>{const s=window.__sf;
    s.chase.update(0,s.player,s.input);
    s.pipeline.render();
    await s.renderer.backend.device.queue.onSubmittedWorkDone();
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return true;})()`);
  const r=await cdp.send("Page.captureScreenshot",{format:"png"});
  writeFileSync(path.join(OUT,name),Buffer.from(r.data,"base64"));
  console.log("shot",name);
}

mkdirSync(OUT,{recursive:true});
const chromePort=await freePort();
rmSync(PROFILE,{recursive:true,force:true});mkdirSync(PROFILE,{recursive:true});
const chrome=spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",[`--remote-debugging-port=${chromePort}`,`--user-data-dir=${PROFILE}`,"--headless=new","--no-first-run","--mute-audio","--enable-unsafe-webgpu","--enable-gpu","--use-angle=metal","--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer","--window-size=1280,800","--force-device-scale-factor=1","about:blank"],{stdio:"ignore"});
try{
  const t0=Date.now();while(Date.now()-t0<20000){try{await(await fetch(`http://127.0.0.1:${chromePort}/json/version`)).json();break;}catch{}await sleep(200);}
  const page=await(await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`,{method:"PUT"})).json();
  const cdp=new Cdp(page.webSocketDebuggerUrl);await cdp.open();
  await cdp.send("Page.enable");await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await cdp.send("Page.navigate",{url:`${SERVER_URL}/?autostart=1&fullfps=1&spawn=oceanBeach`});
  await we(cdp,"Boolean(document.body.classList.contains('started')&&window.__sf?.player)",180000,"started");
  await ev(cdp,`(()=>{const s=window.__sf;if(!s.renderIdle?.())s.pipeline.warmup=async()=>{};return true;})()`);
  await we(cdp,"window.__sf.renderIdle?.()===true",30000,"idle");
  await sleep(800);
  await cdp.send("Input.dispatchKeyEvent",{type:"keyDown",code:"KeyE",key:"e",windowsVirtualKeyCode:69});
  await cdp.send("Input.dispatchKeyEvent",{type:"keyUp",code:"KeyE",key:"e",windowsVirtualKeyCode:69});
  await we(cdp,"window.__sf.player.mode==='surf'",15000,"surf");
  // ride a bit so the camera settles like live play, then freeze
  await sleep(2500);
  await ev(cdp,"window.__sfManual(true)");
  await ev(cdp,`(()=>{const s=window.__sf;for(let i=0;i<30;i++)s.tick(1/60);return true})()`);

  // inventory of candidate meshes
  const names=await ev(cdp,`(()=>{const s=window.__sf;const out=[];
    s.scene.traverse(o=>{const n=o.name||'';
      if(/water|ocean|wave|barrel|swell|foam|spray|shore/i.test(n))out.push({name:n,type:o.type,visible:o.visible,renderOrder:o.renderOrder});});
    return out;})()`);
  console.log(JSON.stringify(names,null,1));

  await shot(cdp,"0-baseline.png");
  const toggles=[
    ["ocean_beach_surf_face","face-off"],
    ["ocean_beach_barrel_roof","barrel-off"],
  ];
  for(const [name,label] of toggles){
    await ev(cdp,`(()=>{let f=null;window.__sf.scene.traverse(o=>{if(o.name==='${name}')f=o;});if(f)f.visible=false;return Boolean(f);})()`);
    await shot(cdp,`1-${label}.png`);
    await ev(cdp,`(()=>{let f=null;window.__sf.scene.traverse(o=>{if(o.name==='${name}')f=o;});if(f)f.visible=true;return Boolean(f);})()`);
  }
  // toggle the unnamed base sheets directly
  for(const key of ["far","near"]){
    await ev(cdp,`(()=>{window.__sf.water.${key}.visible=false;return true;})()`);
    await shot(cdp,`2-water-${key}-off.png`);
    await ev(cdp,`(()=>{window.__sf.water.${key}.visible=true;return true;})()`);
  }
  // open face: carve away from the tube (A drops shoreward for north travel,
  // then neutral re-trims), advance, re-shoot
  await ev(cdp,`(()=>{const s=window.__sf;
    s.input.keys.add(s.player.surfTelemetry.lineDirection>0?'KeyA':'KeyD');
    for(let i=0;i<50;i++)s.tick(1/60);
    s.input.keys.clear();
    for(let i=0;i<160;i++)s.tick(1/60);
    return s.player.surfTelemetry.tubeState;})()`).then(st=>console.log("tubeState:",st));
  await shot(cdp,"3-openface.png");
  for(const key of ["far","near"]){
    await ev(cdp,`(()=>{window.__sf.water.${key}.visible=false;return true;})()`);
    await shot(cdp,`3-openface-water-${key}-off.png`);
    await ev(cdp,`(()=>{window.__sf.water.${key}.visible=true;return true;})()`);
  }
  await ev(cdp,`(()=>{let f=null;window.__sf.scene.traverse(o=>{if(o.name==='ocean_beach_surf_face')f=o;});if(f)f.visible=false;return Boolean(f);})()`);
  await shot(cdp,"3-openface-face-off.png");
  cdp.close();
}finally{
  chrome.kill("SIGTERM");
  await sleep(300);
  rmSync(PROFILE,{recursive:true,force:true});
}
