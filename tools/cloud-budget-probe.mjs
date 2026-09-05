// Serialized GPU timestamps, never a throughput/FPS benchmark.
import {chromium} from 'playwright-core';
import {mkdir,writeFile} from 'node:fs/promises';
import {acquirePerformanceProbe} from './performance-probe-lock.mjs';
const out=process.env.SF_CLOUD_OUT??'.data/world-upgrade/cloud-budget';await mkdir(out,{recursive:true});
const release=await acquirePerformanceProbe();
let browser;
const report={errors:[],rows:[]};
try {
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--use-angle=metal','--mute-audio']});
 const page=await browser.newPage({viewport:{width:1512,height:982},deviceScaleFactor:1});
 page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text())});
 await page.goto((process.env.SF_PROBE_URL??'http://localhost:5270')+'/?autostart=1&profile&fullfps&zone=tidal-choir');
 await page.waitForFunction(()=>window.__sf?.CLOUD_TUNING&&!window.__sf.worldArrival.active&&window.__sf.rings.state()==='settled',null,{timeout:240000});
 await page.evaluate(()=>{const sf=window.__sf;sf.dynRes.setEnabled(false);sf.sky.cycleEnabled=false;sf.CLOUD_TUNING.values.enabled=true});
 await page.waitForFunction(()=>window.__sf.sky.mesh.material.name==='sf-volumetric-clouds'&&!window.__sf.pipeline.compileHeld,null,{timeout:120000});
 await page.waitForFunction(()=>window.__sf.siteFoliage.isReady('tidal-choir-garden')&&!window.__sf.pipeline.compileHeld,null,{timeout:180000});
 await page.waitForTimeout(15000);
 await page.waitForFunction(()=>!window.__sf.frameDriver.gpuTiming.pending);
 await page.evaluate(()=>window.__sf.frameDriver.setManual(true));
 for(const [time,label] of [[15,'day'],[19.2,'dusk'],[0,'night']])for(const [height,view] of [[180,'below'],[820,'inside'],[1450,'above']]) {
  if(process.env.SF_CLOUD_CASES&&!process.env.SF_CLOUD_CASES.split(',').includes(label+'-'+view))continue;
  await page.evaluate(({time,height})=>{const sf=window.__sf;sf.sky.setTimeOfDay(time);window.__sfFreeCam([-9000,height,-1500],[-8000,height+(height<680?700:height>1100?-500:90),-500]);sf.tick(1/60)}, {time,height});
  await page.evaluate(()=>window.__sf.frameDriver.setManual(false));
  await page.waitForTimeout(7000);
  await page.waitForFunction(()=>!window.__sf.pipeline.compileHeld&&window.__sf.pipeline.compileQueueDepth===0&&!window.__sf.frameDriver.gpuTiming.pending,null,{timeout:60000});
  await page.evaluate(()=>window.__sf.frameDriver.setManual(true));
  const samples=await page.evaluate(async()=>{
   const sf=window.__sf,r=sf.renderer,values={clear:[],clouds:[]};
   if(!r.hasFeature('timestamp-query'))return {available:false};
   r.backend.trackTimestamp=true;
   try {
    // Alternate A/B order, keeping camera, time, scale and all other passes fixed.
    for(let pair=0;pair<4;pair++)for(const mode of pair%2?['clouds','clear']:['clear','clouds']) {
     sf.CLOUD_TUNING.values.enabled=mode==='clouds';
     for(let i=0;i<18;i++) {
      sf.tick(1/60);
      const [render]=await Promise.all([r.resolveTimestampsAsync('render'),r.resolveTimestampsAsync('compute')]);
      if(i>=6&&render>0&&!sf.pipeline.compileHeld)values[mode].push(render);
     }
    }
    const median=arr=>arr.sort((a,b)=>a-b)[Math.floor(arr.length/2)];
    return {available:true,clearMs:median(values.clear),cloudMs:median(values.clouds),samples:values,drawingBuffer:[r.domElement.width,r.domElement.height],scale:sf.dynRes.governorEffects()};
   }finally{r.backend.trackTimestamp=false;sf.CLOUD_TUNING.values.enabled=true;for(let i=0;i<40;i++){sf.tick(1/60);await r.backend.device.queue.onSubmittedWorkDone()}}
  });
  const isolatedCloud = await page.evaluate(async()=>{
    const sf=window.__sf,r=sf.renderer;if(!sf.sky.cloudDebug)return null;
    const values=[];r.backend.trackTimestamp=true;
    try {for(let i=0;i<40;i++){sf.sky.renderVolumetricClouds(r,sf.camera);const ms=await r.resolveTimestampsAsync('render');if(i>=10&&ms>0)values.push(ms)}}finally{r.backend.trackTimestamp=false}
    return {medianMs:values.sort((a,b)=>a-b)[Math.floor(values.length/2)],samples:values,targets:sf.sky.cloudDebug};
  });
  const row={time,label,height,view,...samples,isolatedCloud,overheadMs:samples.cloudMs-samples.clearMs};report.rows.push(row);
  await page.screenshot({path:`${out}/${label}-${view}.png`});
  console.log(JSON.stringify({label,view,clearMs:row.clearMs,cloudMs:row.cloudMs,overheadMs:row.overheadMs}));
 }
 report.ok=report.errors.length===0&&report.rows.every(r=>r.available&&r.samples.clear.length>=30&&r.samples.clouds.length>=30);
 if(!report.ok)process.exitCode=1;
} catch(e){report.ok=false;report.failure=e.stack;console.error(e);process.exitCode=1}
finally{await writeFile(`${out}/results.json`,JSON.stringify(report,null,2));await browser?.close();await release()}
