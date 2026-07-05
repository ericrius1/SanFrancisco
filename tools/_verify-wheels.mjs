// Verify the truck wheels roll (rotation.z advances with forward travel) and
// stay seated on their axles (world offset from the truck stays constant).
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 900;
const SERVER_URL = process.env.SF_CAPTURE_URL ?? "http://127.0.0.1:5210";
const OUT = path.join(ROOT, ".data", "wheel-verify");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isFile(p){try{await access(p);return true}catch{return false}}
async function findChrome(){for(const c of[process.env.CHROME_BIN,"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)){if(c.includes("/")&&!(await isFile(c)))continue;return c}throw new Error("no chrome")}
function freePort(){return new Promise((res,rej)=>{const s=createServer();s.once("error",rej);s.listen(0,"127.0.0.1",()=>{const{port}=s.address();s.close(()=>res(port))})})}
async function waitHttp(url,ms){const t=Date.now();while(Date.now()-t<ms){try{if((await fetch(url,{cache:"no-store"})).ok)return true}catch{}await sleep(300)}throw new Error("http timeout")}
class Cdp{#ws;#id=1;#p=new Map();constructor(u){this.#ws=new WebSocket(u)}
  async open(){await new Promise((res,rej)=>{this.#ws.addEventListener("open",res,{once:true});this.#ws.addEventListener("error",rej,{once:true})});this.#ws.addEventListener("message",(e)=>{const m=JSON.parse(e.data.toString());if(!m.id)return;const p=this.#p.get(m.id);if(!p)return;this.#p.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result??{})})}
  send(method,params={}){const id=this.#id++;this.#ws.send(JSON.stringify({id,method,params}));return new Promise((res,rej)=>this.#p.set(id,{res,rej}))}
  close(){this.#ws.close()}}
async function ev(c,expr){const r=await c.send("Runtime.evaluate",{expression:expr,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails).slice(0,500));return r.result?.value}
async function waitEv(c,expr,ms){const t=Date.now();while(Date.now()-t<ms){try{if(await ev(c,expr))return}catch{}await sleep(250)}throw new Error("eval timeout "+expr)}
const frame=(dt)=>`(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()`;
async function main(){
  await rm(OUT,{recursive:true,force:true});await mkdir(OUT,{recursive:true});
  await waitHttp(SERVER_URL,4000);
  const chromePath=await findChrome();const dport=await freePort();
  const chrome=spawn(chromePath,[`--remote-debugging-port=${dport}`,`--user-data-dir=${path.join(OUT,"chrome")}`,"--headless=new","--no-first-run","--mute-audio","--enable-unsafe-webgpu","--enable-features=WebGPUDeveloperFeatures","--use-angle=metal",`--window-size=${W},${H}`,"--force-device-scale-factor=1","about:blank"],{stdio:"ignore"});
  try{
    let ver;const t=Date.now();while(Date.now()-t<15000){try{ver=await(await fetch(`http://127.0.0.1:${dport}/json/version`)).json();break}catch{await sleep(200)}}
    const pg=await(await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`,{method:"PUT"})).json();
    const c=new Cdp(pg.webSocketDebuggerUrl);await c.open();
    await c.send("Page.enable");await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride",{width:W,height:H,deviceScaleFactor:1,mobile:false});
    await c.send("Page.navigate",{url:`${SERVER_URL}/?demo=bridge&hold=1&manual=1&autostart=1&fullfps=1`});
    await waitEv(c,"Boolean(window.__sfReelArmed && window.__sf && window.__sfReelStep && window.__sfManual)",120000);
    await ev(c,"window.__sfManual(true); true");
    await ev(c,"window.__sfReelStep(0); true");
    for(let i=0;i<60;i++){await ev(c,frame(0));await sleep(50)} // stream truck.glb
    // read wheel state: rotation.z of each wheel + world offset from truck centre
    const probe=`(()=>{const t=window.__sf.player.meshes.truck;const ws=t.userData.wheels;if(!ws)return {err:'no wheels'};
      t.updateWorldMatrix(true,true);
      const THREE=window.__sf.THREE;const tp=new THREE.Vector3();t.getWorldPosition(tp);
      return ws.map(w=>{const wp=new THREE.Vector3();w.mesh.getWorldPosition(wp);return {rz:+w.mesh.rotation.z.toFixed(4),ox:+(wp.x-tp.x).toFixed(3),oy:+(wp.y-tp.y).toFixed(3),oz:+(wp.z-tp.z).toFixed(3)}});})()`;
    // advance from t=1 to t=3 in small dt steps so wheels roll continuously
    await ev(c,"window.__sfReelStep(1); true"); await ev(c,frame(1/60));
    const a=await ev(c,probe);
    for(let i=0;i<90;i++){const tt=1+ (i+1)*(2/90);await ev(c,`window.__sfReelStep(${tt}); true`);await ev(c,frame(2/90))}
    const b=await ev(c,probe);
    console.log("WHEELS @ t≈1:",JSON.stringify(a));
    console.log("WHEELS @ t≈3:",JSON.stringify(b));
    const dz=b.map((w,i)=>+(w.rz-a[i].rz).toFixed(3));
    const offMoved=b.map((w,i)=>+(Math.hypot(w.ox-a[i].ox,w.oy-a[i].oy,w.oz-a[i].oz)).toFixed(3));
    console.log("Δrotation.z (should be nonzero, negative=forward):",JSON.stringify(dz));
    console.log("offset drift from truck (should be ~0 = still seated):",JSON.stringify(offMoved));
    // side screenshot for eyeball
    await ev(c,"window.__sfReelStep(6.5); true");for(let i=0;i<8;i++)await ev(c,frame(1/60));for(let i=0;i<16;i++){await ev(c,frame(0));await sleep(30)}
    const shot=await c.send("Page.captureScreenshot",{format:"jpeg",quality:90});
    writeFileSync(path.join(OUT,"side.jpg"),Buffer.from(shot.data,"base64"));
    console.log("screenshot ->",path.relative(ROOT,path.join(OUT,"side.jpg")));
    c.close();
  }finally{chrome.kill("SIGTERM")}
}
main().catch(e=>{console.error(e);process.exitCode=1});
