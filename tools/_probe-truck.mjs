// Quick placement probe for the new truck.glb on the bridge cinematic.
// Boots the bridge demo (manual clock), then screenshots a few virtual times so
// we can eyeball wheels-on-deck, rockets in the bed, guitarist on the cab roof,
// eagle at the back — before committing to the full 14s render.
//   SF_CAPTURE_URL=http://127.0.0.1:5210 node tools/_probe-truck.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1600, H = 900;
const SERVER_URL = process.env.SF_CAPTURE_URL ?? "http://127.0.0.1:5210";
const OUT = path.join(ROOT, ".data", "truck-probe");
const TIMES = (process.env.PROBE_TIMES ?? "0.6,3.2,6.5,9.9,10.6,13.2").split(",").map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isFile(p){try{await access(p);return true}catch{return false}}
async function findChrome(){for(const c of[process.env.CHROME_BIN,"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)){if(c.includes("/")&&!(await isFile(c)))continue;return c}throw new Error("no chrome")}
function freePort(){return new Promise((res,rej)=>{const s=createServer();s.once("error",rej);s.listen(0,"127.0.0.1",()=>{const{port}=s.address();s.close(()=>res(port))})})}
async function waitHttp(url,ms){const t=Date.now();while(Date.now()-t<ms){try{if((await fetch(url,{cache:"no-store"})).ok)return true}catch{}await sleep(300)}throw new Error("http timeout "+url)}

class Cdp{#ws;#id=1;#p=new Map();constructor(u){this.#ws=new WebSocket(u)}
  async open(){await new Promise((res,rej)=>{this.#ws.addEventListener("open",res,{once:true});this.#ws.addEventListener("error",rej,{once:true})});this.#ws.addEventListener("message",(e)=>{const m=JSON.parse(e.data.toString());if(!m.id)return;const p=this.#p.get(m.id);if(!p)return;this.#p.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result??{})})}
  send(method,params={}){const id=this.#id++;this.#ws.send(JSON.stringify({id,method,params}));return new Promise((res,rej)=>this.#p.set(id,{res,rej}))}
  close(){this.#ws.close()}}
async function ev(c,expr){const r=await c.send("Runtime.evaluate",{expression:expr,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails).slice(0,400));return r.result?.value}
async function waitEv(c,expr,ms){const t=Date.now();while(Date.now()-t<ms){try{if(await ev(c,expr))return}catch{}await sleep(250)}throw new Error("eval timeout "+expr)}
const frameExpr=(dt)=>`(async()=>{window.__sf.tick(${dt});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()`;

async function main(){
  await rm(OUT,{recursive:true,force:true});await mkdir(OUT,{recursive:true});
  let dev=null;
  try{await waitHttp(SERVER_URL,2000)}catch{
    const relay=await freePort();const vitePort=Number(new URL(SERVER_URL).port||5210);
    console.log("[probe] starting vite",SERVER_URL);
    dev=spawn("npm",["run","dev","--","--host","127.0.0.1","--port",String(vitePort),"--strictPort"],{cwd:ROOT,env:{...process.env,SF_RELAY_PORT:String(relay)},stdio:["ignore","ignore","ignore"]});
    await waitHttp(SERVER_URL,45000);
  }
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
    // settle at t=0 so truck.glb + tiles stream in
    await ev(c,"window.__sfReelStep(0); true");
    for(let i=0;i<70;i++){await ev(c,frameExpr(0));await sleep(60)}
    for(const t of TIMES){
      await ev(c,`window.__sfReelStep(${t}); true`);
      for(let i=0;i<8;i++){await ev(c,frameExpr(1/60));await sleep(20)}
      for(let i=0;i<20;i++){await ev(c,frameExpr(0));await sleep(40)} // stream + settle
      const shot=await c.send("Page.captureScreenshot",{format:"jpeg",quality:90});
      const f=path.join(OUT,`t_${String(t).replace(".","_")}.jpg`);
      writeFileSync(f,Buffer.from(shot.data,"base64"));
      console.log("[probe] t=",t,"->",path.relative(ROOT,f));
    }
    c.close();
  }finally{chrome.kill("SIGTERM");dev?.kill("SIGTERM")}
}
main().catch((e)=>{console.error(e);process.exitCode=1});
