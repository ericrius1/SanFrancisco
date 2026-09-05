// One browser, fresh context per profile; live presentation counts + asynchronous
// GPU telemetry. SF_SOAK_MINUTES=20 runs the fanless-laptop endurance route.
import {chromium} from 'playwright-core';
import {mkdir,writeFile} from 'node:fs/promises';
import {acquirePerformanceProbe} from './performance-probe-lock.mjs';
const out=process.env.SF_PROBE_OUT??'.data/world-upgrade/routes';await mkdir(out,{recursive:true});
const release=await acquirePerformanceProbe();
let browser;const report={profiles:[],errors:[],warnings:[],soakMinutes:Number(process.env.SF_SOAK_MINUTES??0)};
const measure=async(page,seconds)=>page.evaluate(async(seconds)=>{
 const sf=window.__sf,tele=sf.pipeline.frameTelemetry,begin=performance.now(),start={...tele},intervals=[];let last=tele.submittedFrames;
 await new Promise(resolve=>{const poll=()=>{if(tele.submittedFrames!==last){last=tele.submittedFrames;intervals.push(tele.intervalMs)}if(performance.now()-begin>=seconds*1000)resolve();else requestAnimationFrame(poll)};requestAnimationFrame(poll)});
 const adapter=sf.renderer.backend.device.adapterInfo??sf.renderer.backend.adapter?.info;
 intervals.sort((a,b)=>a-b);const elapsed=performance.now()-begin,frames=tele.submittedFrames-start.submittedFrames;
 return {elapsedMs:elapsed,submittedFrames:frames,fps:frames/(elapsed/1000),p50:intervals[Math.floor(intervals.length*.5)],p95:intervals[Math.floor(intervals.length*.95)],p99:intervals[Math.floor(intervals.length*.99)],max:intervals.at(-1),compileSkipped:tele.compileSkippedFrames-start.compileSkippedFrames,compileQueue:sf.pipeline.compileQueueDepth,scheduler:sf.scheduler.depths(),memory:{...sf.renderer.info.memory},tiles:sf.tiles.loaded.size,stream:sf.tiles.backgroundStreamingDebug,skyline:sf.tiles.skylineDebug,gpu:sf.frameDriver.gpuTiming,governor:sf.dynRes.governorEffects(),pressure:sf.dynRes.pressure,drawingBuffer:[sf.renderer.domElement.width,sf.renderer.domElement.height],position:sf.player.position.toArray(),userAgent:navigator.userAgent,adapter:adapter?{vendor:adapter.vendor,architecture:adapter.architecture,device:adapter.device,description:adapter.description}:null};
},seconds);
try {
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--use-angle=metal','--mute-audio','--disable-background-timer-throttling']});
 for(const profile of (process.env.SF_PROFILES??'balanced,quiet').split(',')) {
  const context=await browser.newContext({viewport:{width:1512,height:982},deviceScaleFactor:1});const page=await context.newPage();
  page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());if(m.type()==='warning')report.warnings.push(m.text())});
  await context.addInitScript(profile=>localStorage.setItem('sf-tweaks',JSON.stringify({'render.profile':profile})),profile);
  const start=Date.now();
  await page.goto((process.env.SF_PROBE_URL??'http://localhost:5270')+'/?autostart=1&profile&fullfps&spawn=goldenGate');
  await page.waitForFunction(()=>window.__sf?.player&&!window.__sf.worldArrival.active&&window.__sf.rings.state()==='settled'&&window.__sf.tiles.skylineDebug,null,{timeout:240000});
  await page.evaluate(profile=>{const sf=window.__sf;sf.RENDER_TUNING.values.profile=profile;sf.sky.setTimeOfDay(15);sf.sky.cycleEnabled=false},profile);
  const run={profile,bootMs:Date.now()-start,windows:[],trips:[]};report.profiles.push(run);
  const poses=[['Japanese Tea Garden',-2248.8,2187.2],['Tidal Choir · Marin',-4245,-5385],['Beach Pianist',-3340,-870],['Japanese Tea Garden',-2248.8,2187.2],['Tidal Choir · Marin',-4245,-5385]];
  for(const [label,x,z] of poses) {
   const began=Date.now();await page.evaluate(({x,z,label})=>window.__sf.teleportToTarget(x,z,label),{x,z,label});
   await page.waitForFunction(({x,z})=>!window.__sf.worldArrival.active&&Math.hypot(window.__sf.player.position.x-x,window.__sf.player.position.z-z)<80,{x,z},{timeout:240000});
   await page.waitForTimeout(18000);await page.waitForFunction(()=>!window.__sf.pipeline.compileHeld,null,{timeout:120000});
   const metrics=await measure(page,12);run.trips.push({label,arrivalAndSettleMs:Date.now()-began,...metrics});
   console.log(JSON.stringify({profile,label,...metrics}));await writeFile(`${out}/results.json`,JSON.stringify(report,null,2));
   await page.screenshot({path:`${out}/${profile}-${run.trips.length}.png`});
  }
  // Repeat fixed landscape views to exercise wind, grass/flowers, water and
  // the skyline continuously; no second browser or build competes for the GPU.
  const soakStart=Date.now();let minute=0;
  while(Date.now()-soakStart<report.soakMinutes*60000) {
   const metrics=await measure(page,60);run.windows.push({minute:++minute,...metrics});
   console.log(JSON.stringify({profile,soakMinute:minute,...metrics}));await writeFile(`${out}/results.json`,JSON.stringify(report,null,2));
  }
  // A profile change must retain the scale owner through resize and pause.
  await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>window.__sf.frameDriver.setManual(true));await page.waitForTimeout(1200);await page.evaluate(()=>window.__sf.frameDriver.setManual(false));await page.waitForTimeout(3000);
  run.resumed=await measure(page,5);await context.close();
 }
 report.attributeWarnings=report.warnings.filter(w=>/Vertex attribute "(?:position|aCenter|aId|color|aLit)" not found on geometry/i.test(w));
 report.ok=report.errors.length===0&&report.attributeWarnings.length===0&&report.profiles.every(p=>p.trips.every(t=>t.submittedFrames>0&&t.pressure.cpuMs>0&&t.stream.limit===(p.profile==='quiet'?2400:p.profile==='high'?6000:3600)) && p.resumed.submittedFrames>0 && p.resumed.drawingBuffer.every(Number.isFinite) && p.resumed.drawingBuffer[0]>0 && p.resumed.drawingBuffer[1]>0 && p.windows.length>=report.soakMinutes);
 if(!report.ok)process.exitCode=1;
} catch(e){report.ok=false;report.failure=e.stack;console.error(e);process.exitCode=1}
finally{await writeFile(`${out}/results.json`,JSON.stringify(report,null,2));await browser?.close();await release()}
