import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { acquirePerformanceProbe } from './performance-probe-lock.mjs';
const base=process.env.SF_PROBE_URL??'http://localhost:5280';
const out=process.env.SF_PROBE_OUT??'.data/streaming-upgrade/trees';
await mkdir(out,{recursive:true});
const release=await acquirePerformanceProbe();
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--enable-features=WebGPUDeveloperFeatures','--enable-dawn-features=allow_unsafe_apis','--enable-gpu','--use-angle=metal','--mute-audio']});
const report={samples:[],errors:[],requests:[]};
try {
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
 page.on('request',r=>report.requests.push(r.url()));
 await page.goto(base+'/tools/native-tree-distance-probe.html');
 await page.waitForFunction(()=>window.__treeProbe,null,{timeout:180000});
 const initial=await page.evaluate(()=>({ready:window.__treeProbe.ready,error:window.__treeProbe.error,prototypeMs:window.__treeProbe.prototypeMs,authored:window.__treeProbe.authored}));
 assert.ok(initial.ready,initial.error);Object.assign(report,initial);
 for(const view of ['flight','street','overhead']){
  for(let trial=0;trial<4;trial++)for(const name of (trial%2?['new1050','old1050','old520']:['old520','old1050','new1050'])){
   const sample=await page.evaluate(([n,v])=>window.__treeProbe.sample(n,v),[name,view]);report.samples.push(sample);
   if(trial===0){await page.screenshot({path:`${out}/${view}-${name}.png`});console.log(JSON.stringify(sample));}
  }
 }
 assert.equal(report.requests.filter(u=>u.includes('/native-foliage/')).length,0,'far tiers request no near texture assets');
 assert.equal(report.errors.length,0,report.errors.join('\n'));
 if(!process.env.SF_PROBE_BASELINE){
  for(const view of ['flight','street','overhead']){
   const old=report.samples.find(s=>s.name==='old1050'&&s.view===view),next=report.samples.find(s=>s.name==='new1050'&&s.view===view);
   assert.ok(next.triangles<old.triangles*0.4,view+': wider forest must substantially reduce geometry at equal range');
  }
 }
 await page.evaluate(()=>window.__treeProbe.dispose());
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await release();}
