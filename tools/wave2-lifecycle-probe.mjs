import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
await mkdir('.data/world-upgrade',{recursive:true});
const chunks=JSON.parse(await readFile('.data/world-upgrade/lazy-chunks.json','utf8'));
const runtimeFiles=new Set(chunks.filter(c=>c.source.startsWith('src/vehicles/')||c.source==='src/fx/fireworksRuntime.ts').map(c=>'/'+c.file));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--use-angle=metal','--mute-audio']});
const report={errors:[],warnings:[],requests:[],checks:[]};let phase='boot';
try {
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());if(m.type()==='warning')report.warnings.push(m.text())});
 page.on('request',r=>report.requests.push({phase,url:r.url()}));
 await page.goto((process.env.SF_PROBE_URL??'http://localhost:5270')+'/?autostart=1&profile&fullfps&spawn=goldenGate');
 await page.waitForFunction(()=>window.__sf?.player&&!window.__sf.worldArrival.active,null,{timeout:180000});
 await page.evaluate(()=>{
  const sf=window.__sf;
  sf.remotes.add({id:999101,name:'Distant car fixture',hue:0.3});
  window.__peerPose=(distance)=>{
   const p=sf.player.position,a=sf.remotes.avatars.get(999101);a.buffer.length=0;
   sf.remotes.sample(999101,{t:performance.now()-200,mode:'drive',x:p.x+distance,y:p.y,z:p.z,qx:0,qy:0,qz:0,qw:1,speed:0});
   sf.remotes.update(1/60);
   return !!a.bodies.drive?.userData.runtimeFallback;
  };
 });
 assert.equal(await page.evaluate(()=>window.__peerPose(1000)),true);
 await page.waitForTimeout(1000);
 assert.equal(report.requests.filter(r=>/\/vehicles\/[^/]+\/(?:index|mesh|controller)\.ts/.test(r.url)||runtimeFiles.has(new URL(r.url).pathname)).length,0,'distant peer must not load a runtime at boot');
 assert.equal(report.requests.filter(r=>/fireworksRuntime/.test(r.url)).length,0);
 phase='local-drive';
 await page.evaluate(()=>window.__sf.player.trySwitch('drive'));
 assert.equal(await page.evaluate(()=>window.__peerPose(1000)),true,'locally active but distant stays fallback');
 phase='near-peer';assert.equal(await page.evaluate(()=>window.__peerPose(3)),false,'nearby active mode hydrates');
 await page.waitForTimeout(1500);
 report.seat=await page.evaluate(()=>{const sf=window.__sf,p=new sf.THREE.Vector3(),q=new sf.THREE.Quaternion();return {available:sf.remotes.ridePose(999101,1,p,q),finite:p.toArray().every(Number.isFinite)}});
 assert.ok(report.seat.available&&report.seat.finite);
 assert.equal(await page.evaluate(()=>window.__peerPose(400)),true,'leaving retires vehicle shell');
 assert.equal(await page.evaluate(()=>window.__peerPose(3)),false,'return hydrates again');
 await page.evaluate(()=>window.__sf.remotes.remove(999101));
 phase='fireworks';
 await page.evaluate(async()=>{const sf=window.__sf;await sf.fireworks.prepare();const p=sf.player.position;sf.fireworks.launchRemote([[p.x,p.y+2,p.z,0,40,0,1,2,0.3]])});
 await page.waitForTimeout(4500);
 report.fireworks=await page.evaluate(()=>({ready:window.__sf.fireworks.ready,stats:{...window.__sf.fireworks.stats}}));assert.ok(report.fireworks.ready);
 await page.evaluate(()=>window.__sf.fireworks.dispose());
 assert.equal(await page.evaluate(()=>window.__sf.fireworks.ready),false);
 await page.evaluate(async()=>{await window.__sf.fireworks.prepare();window.__sf.fireworks.dispose()});
 // Skyline preparation is independent of active movement/vehicle choice.
 await page.waitForFunction(()=>window.__sf.tiles.skylineDebug,null,{timeout:180000});
 await page.waitForTimeout(10000);
 report.skyline=await page.evaluate(()=>({stats:window.__sf.tiles.skylineDebug,stream:window.__sf.tiles.backgroundStreamingDebug,loaded:window.__sf.tiles.loaded.size,arena:window.__sf.tiles.batchArenaDebug,gpu:window.__sf.frameDriver.gpuTiming}));
 assert.equal(report.skyline.stream.limit,3600);assert.ok(report.skyline.stats.visibleTiles>0);
 await page.screenshot({path:'.data/world-upgrade/skyline-golden-gate.png'});
 await page.evaluate(()=>{const sf=window.__sf;sf.sky.cycleEnabled=false;sf.sky.setTimeOfDay(15);window.__sfFreeCam([-1600,450,-4100],[3800,80,500])});
 await page.waitForTimeout(3000);
 await page.keyboard.press('Tab');
 await page.screenshot({path:'.data/world-upgrade/skyline-marin-to-city.png'});
 await page.evaluate(()=>window.__sfFreeCam([0,900,-800],[3500,80,500]));
 await page.waitForTimeout(2000);
 await page.screenshot({path:'.data/world-upgrade/skyline-flight.png'});
 assert.equal(report.errors.length,0,report.errors.join('\n'));report.ok=true;
 console.log(JSON.stringify({ok:true,seat:report.seat,skyline:report.skyline,fireworks:report.fireworks,warnings:report.warnings},null,2));
}catch(e){report.ok=false;report.failure=e.stack;console.error(e);process.exitCode=1}
finally{await mkdir('.data/world-upgrade',{recursive:true});await writeFile('.data/world-upgrade/lifecycle.json',JSON.stringify(report,null,2));await browser.close()}
