import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
const chunks=JSON.parse(await readFile('.data/world-upgrade/lazy-chunks.json','utf8'));
const runtimeFiles=new Set(chunks.filter(c=>c.source.startsWith('src/vehicles/')||c.source==='src/fx/fireworksRuntime.ts').map(c=>'/'+c.file));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--use-angle=metal','--mute-audio']});
const report={requests:[],errors:[],modes:[]}; let phase='boot';
try{
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 page.on('request',r=>report.requests.push({phase,url:r.url()}));page.on('pageerror',e=>report.errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text())});
 await page.goto((process.env.SF_PROBE_URL??'http://localhost:5270')+'/?autostart=1&profile&fullfps&spawn=goldenGate',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__sf?.player&&!window.__sf.worldArrival.active,null,{timeout:180000});
 report.boot=await page.evaluate(()=>({ready:Object.keys(window.__sf.player.meshes).filter(m=>window.__sf.player.isModeReady(m)),meshChildren:Object.fromEntries(Object.entries(window.__sf.player.meshes).map(([m,g])=>[m,g.children.length]))}));
 assert.deepEqual(report.boot.ready,['walk']);
 const optional=report.requests.filter(r=>/\/vehicles\/[^/]+\/(?:index|mesh|controller)\.ts/.test(r.url)||runtimeFiles.has(new URL(r.url).pathname));
 assert.equal(optional.length,0,'vehicle runtimes must not enter walking boot: '+optional.map(r=>r.url).join('\n'));
 assert.equal(report.requests.filter(r=>/fireworksRuntime/.test(r.url)).length,0);
 console.log('PASS walking boot: no optional vehicle meshes/controllers or fireworks pool');
 for(const mode of ['drive','scooter','board','skate','plane','drone','boat','speedboat','bird','surf']){
  phase=mode;
  await page.evaluate(async mode=>{await window.__sf.player.prepareMode(mode);await window.__sf.player.trySwitch(mode)},mode);
  await page.waitForFunction(mode=>window.__sf.player.mode===mode&&!window.__sf.pipeline.compileHeld,mode,{timeout:120000});
  await page.waitForTimeout(600);
  const state=await page.evaluate(mode=>({mode:window.__sf.player.mode,children:window.__sf.player.meshes[mode].children.length,body:window.__sf.player.body,finite:window.__sf.player.position.toArray().every(Number.isFinite)}),mode);
  assert.ok(state.children>0&&state.body&&state.finite,JSON.stringify(state));report.modes.push(state);
  await page.evaluate(()=>window.__sf.player.trySwitch('walk'));
  console.log('PASS lazy mode',mode);
 }
 assert.equal(report.errors.length,0,report.errors.join('\n'));report.ok=true;
}catch(e){report.ok=false;report.failure=e.stack;console.error(e);process.exitCode=1}
finally{await mkdir('.data/world-upgrade',{recursive:true});await writeFile('.data/world-upgrade/lazy-vehicles.json',JSON.stringify(report,null,2));await browser.close()}
