// Real-world, headless WebGPU waterfall, independent canopy, and boosted flight.
// Matched representation A/B lives in native-tree-distance-probe.mjs.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { acquirePerformanceProbe } from './performance-probe-lock.mjs';
const base=process.env.SF_PROBE_URL??'http://localhost:5280',out=process.env.SF_PROBE_OUT??'.data/streaming-audit/flight';
await mkdir(out,{recursive:true});
const release=await acquirePerformanceProbe();
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--enable-features=WebGPUDeveloperFeatures','--enable-dawn-features=allow_unsafe_apis','--enable-gpu','--use-angle=metal','--mute-audio']});
const report={cases:[]};
try {
 for(const radius of [1050]) {
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,serviceWorkers:'block'});
  const page=await context.newPage(),requests=[],errors=[],row={radius,requests,errors};report.cases.push(row);let phase='boot';
  page.on('request',r=>requests.push({phase,url:r.url()}));
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  // Ocean Beach is now inside the intentional 1.3 km canopy approach gate.
  // Downtown remains outside every landscape forest's activation radius.
  await page.goto(`${base}/?autostart=1&profile=1&fullfps=1&spawn=downtown`,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>window.__sf?.renderer?.backend?.device&&window.__sf.rings?.state()==='settled'&&!window.__sf.worldArrival.active,null,{timeout:180000});
  row.bootOptional=requests.filter(r=>/native-foliage|nativeTreeForest\/(?:index|templates|treeCompile)|wildlands\/(?:index|layout|canopy)/.test(r.url));
  assert.equal(row.bootOptional.length,0,'distant boot must not fetch vegetation assets or runtime');
  console.log(JSON.stringify({radius,phase,optionalRequests:row.bootOptional.length}));
  phase='canopy-approach';
  await page.evaluate(async()=>{const s=window.__sf;await s.player.teleportTo({x:-3500,y:250,z:3850,facing:0,mode:'drone'});});
  await page.waitForFunction(()=>window.__sf.wildlandsCanopy?.trees?.group.parent&&!window.__sf.worldArrival.active,null,{timeout:180000});
  row.canopyOnly=await page.evaluate(()=>({canopy:!!window.__sf.wildlandsCanopy,groundcover:!!window.__sf.wildlands,trees:window.__sf.wildlandsCanopy.trees.stats.instances}));
  const unrelated=requests.filter(r=>r.phase==='canopy-approach'&&/native-foliage|wildlands\/(?:index|grassField|flowerRing)|gameplay\/golf\/index|gameplay\/afterlight\/layout/.test(r.url));
  assert.equal(unrelated.length,0,'distant canopy must not wake grass, flowers, near leaf textures, or golf gameplay: '+JSON.stringify(unrelated));
  assert.equal(row.canopyOnly.groundcover,false,'distant canopy has independent lifetime');
  console.log(JSON.stringify({radius,phase,...row.canopyOnly}));
  phase='park-activation';
  await page.evaluate(async()=>{const s=window.__sf;s.sky.realTime=false;s.sky.cycleEnabled=false;s.sky.setTimeOfDay(14);s.dynRes?.setEnabled?.(false);s.renderer.setPixelRatio(1);await s.player.teleportTo({x:-3500,y:250,z:2300,facing:-Math.PI/2,mode:'drone'});});
  await page.waitForFunction(()=>window.__sf.wildlands?.trees?.group.parent&&!window.__sf.worldArrival.active&&window.__sf.rings?.state()==='settled',null,{timeout:180000});
  assert.ok(await page.evaluate(()=>window.__sf.wildlands.trees===window.__sf.wildlandsCanopy.trees),'groundcover reuses the already visible forest');
  await page.evaluate(async()=>{const s=window.__sf;await s.wildlands.prepareTrees(unit=>s.pipeline.prepareSceneOwner(unit));});
  await page.waitForFunction(()=>window.__sf.renderIdle(),null,{timeout:120000});
  assert.equal(await page.evaluate(()=>window.__sf.wildlands.trees.stats.nearActive()),0,'high-altitude flight cannot select close trees below the player');
  assert.equal(requests.filter(r=>/native-foliage/.test(r.url)).length,0,'flight over a park must not request near tree textures');
  await page.evaluate(()=>{const s=window.__sf;window.__sfManual(true);window.__flightChaseUpdate=s.chase.update;s.chase.update=()=>{};s.camera.position.set(-3500,250,2300);s.camera.lookAt(-2600,30,2300);s.camera.updateMatrixWorld(true);s.hud?.setHidden?.(true);s.renderer.backend.trackTimestamp=true;});
  for(let i=0;i<8;i++){await page.evaluate(()=>{for(let j=0;j<4;j++)window.__sf.tick(1/60)});await page.waitForTimeout(30);}
  const measure=()=>page.evaluate(async()=>{
   const s=window.__sf,r=s.renderer,cpu=[];
   if(s.pipeline.compileHeld)return null;
   const before=s.pipeline.frameTelemetry.submittedFrames;
   // Direct stationary renders bypass the app's presentation-rate governor.
   // Tick loops can otherwise benchmark skipped or compilation-held frames.
   for(let i=0;i<8;i++){const t=performance.now();s.pipeline.render();cpu.push(performance.now()-t);}
   const presented=s.pipeline.frameTelemetry.submittedFrames-before;
   if(presented!==8)return null;
   await r.resolveTimestampsAsync('render');await r.resolveTimestampsAsync('compute');
   const gpu={};for(const type of ['render','compute']){const pool=r.backend.timestampQueryPool[type];gpu[type]=pool?[...pool.timestamps.values()].reduce((a,b)=>a+b,0)/8:null;pool?.timestamps.clear();}
   return {cpuMean:cpu.reduce((a,b)=>a+b,0)/cpu.length,gpu};
  });
  for(let i=0;i<2;i++){await page.waitForFunction(()=>!window.__sf.pipeline.compileHeld);await measure();}
  row.timings=[];for(let i=0;i<40&&row.timings.length<8;i++){await page.waitForFunction(()=>!window.__sf.pipeline.compileHeld);const sample=await measure();if(sample&&sample.gpu.render>0)row.timings.push(sample);}
  assert.equal(row.timings.length,8,'only measure real submitted frames with timestamp data');
  row.trees=await page.evaluate(async()=>{
   const s=window.__sf,trees=s.wildlands.trees,buffers=new Set();
   trees.group.traverse(o=>{if(o.geometry?.indirect)buffers.add(o.geometry.indirect)});
   let triangles=0,nonemptyDraws=0,instanceDraws=0;
   for(const buffer of buffers){const a=new Uint32Array(await s.renderer.getArrayBufferAsync(buffer));for(let i=0;i<a.length;i+=5){triangles+=a[i]*a[i+1]/3;if(a[i+1])nonemptyDraws++;instanceDraws+=a[i+1];}}
   return {...trees.stats,farResidency:trees.stats.farResidency?.(),nearActive:trees.stats.nearActive(),farSubmittedTriangles:triangles,farNonemptyDraws:nonemptyDraws,farInstanceDraws:instanceDraws};
  });
  assert.ok(row.trees.farSubmittedTriangles>0,'park flight must submit visible far trees');
  row.resolution=await page.evaluate(()=>({width:window.__sf.renderer.domElement.width,height:window.__sf.renderer.domElement.height,gpu:window.__sf.renderer.backend.device.adapterInfo}));
  await page.screenshot({path:`${out}/trees-${radius}.png`});
  console.log(JSON.stringify({radius,phase:'trees-measured',trees:row.trees,timings:row.timings}));
  phase='park-descent';
  await page.evaluate(async()=>{const s=window.__sf;s.chase.update=window.__flightChaseUpdate;window.__sfManual(false);await s.player.teleportTo({x:-3500,y:s.map.groundHeight(-3500,2300)+2,z:2300,facing:0,mode:'drone'});});
  await page.waitForFunction(()=>!window.__sf.worldArrival.active&&window.__sf.wildlands.trees.stats.nearActive()>0,null,{timeout:180000});
  await page.evaluate(async()=>{const s=window.__sf;await s.wildlands.prepareTrees(unit=>s.pipeline.prepareSceneOwner(unit));});
  row.descent=await page.evaluate(()=>({nearActive:window.__sf.wildlands.trees.stats.nearActive()}));
  row.descent.textureRequests=requests.filter(r=>r.phase==='park-descent'&&/native-foliage/.test(r.url));
  assert.ok(row.descent.textureRequests.length>0,'descent must activate the nearby species textures');
  console.log(JSON.stringify({radius,phase,...row.descent}));
  if(radius===1050){
   phase='city-flight';
   await page.evaluate(async()=>{const s=window.__sf;s.chase.update=window.__flightChaseUpdate;window.__sfManual(false);await s.player.teleportTo({x:900,y:240,z:2400,facing:0,mode:'drone'});window.__sfManual(false);});
   await page.waitForFunction(()=>window.__sf.citygenRing?.current?.stats().cellsReady>0&&!window.__sf.worldArrival.active&&window.__sf.rings?.state()==='settled',null,{timeout:180000});
   await page.keyboard.down('w');await page.keyboard.down('Shift');row.flight=[];
   for(let i=0;i<14;i++){await page.waitForTimeout(1000);row.flight.push(await page.evaluate(()=>({position:window.__sf.player.position.toArray(),city:window.__sf.citygenRing.current.stats()})));}
   await page.keyboard.up('Shift');await page.keyboard.up('w');
   assert.ok(row.flight.every(s=>s.city.admissionRadius===700),'flying retains full detail eligibility');
   assert.ok(row.flight.some(s=>s.city.detail>0),'flight must draw real detailed buildings');
   await page.screenshot({path:`${out}/city-flight.png`});
   console.log(JSON.stringify({radius,phase,first:row.flight[0],last:row.flight.at(-1)}));
  }
  row.requests=requests;row.errors=errors;
  assert.equal(errors.length,0,errors.join('\n'));
  assert.equal(requests.filter(r=>r.phase==='city-flight'&&/native-foliage/.test(r.url)).length,0,'leaving the park does not hydrate unrelated tree textures');
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  await context.close();
 }
} finally {await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await release();}
