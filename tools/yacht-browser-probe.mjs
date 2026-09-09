import {chromium} from 'playwright-core';
import {writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const out='.data/yacht';await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--use-angle=metal','--mute-audio']});
const report={requests:[],errors:[]};let phase='boot',page;
try{
 page=await browser.newPage({viewport:{width:1500,height:960}});
 page.on('request',r=>report.requests.push({phase,url:r.url()}));
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error'&&/WebGPU|GPUValidation|shader|yacht/i.test(m.text()))report.errors.push(m.text());});
 await page.goto((process.env.SF_PROBE_URL??'http://localhost:5280')+'/?autostart=1&profile&fullfps&zone=wave-organ',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__sf?.player&&!window.__sf.worldArrival.active,null,{timeout:180000});
 assert.equal(report.requests.filter(r=>/\/yacht\//.test(r.url)&&!r.url.includes('dimensions.ts')).length,0,'yacht code/model at boot');
 assert.equal(await page.evaluate(()=>window.__sf.renderer.backend.isWebGPUBackend),true);
 console.log('PASS WebGPU renderer, no yacht runtime/model at boot');
 phase='activate';
 await page.keyboard.press('0');
 await page.waitForFunction(()=>window.__sf.player.mode==='yacht'&&!window.__sf.pipeline.compileHeld&&!window.__sf.worldArrival.active&&!window.__sf.player.worldArrivalHeld,null,{timeout:120000});
 await page.evaluate(()=>{window.__sf.sky.setTimeOfDay(14);window.__sf.sky.cycleEnabled=false;window.__sf.chase.yaw=.8;window.__sf.chase.pitch=.15;});
 await page.waitForTimeout(2000);
 report.yacht=await page.evaluate(()=>{const s=window.__sf,p=s.player,m=p.meshes.yacht;return {position:p.position.toArray(),keys:Object.keys(s),camera:s.camera?.position?.toArray(),model:m.children.map(c=>({name:c.name,position:c.position.toArray(),rotation:c.rotation.toArray()}))}});
 await page.screenshot({path:out+'/yacht-exterior.png'});
 assert.equal(report.requests.filter(r=>r.phase==='activate'&&r.url.includes('/models/yacht/')).length,1);
 phase='explore';
 await page.locator('[data-yacht] button').first().click();
 await page.waitForTimeout(1500);
 assert.ok(await page.evaluate(()=>window.__sf.player.yachtExploring));
 await page.screenshot({path:out+'/yacht-deck.png'});
 const status=()=>page.evaluate(()=>window.__sf.player.yachtStatus);
 const act=async()=>{await page.waitForFunction(()=>!window.__sf.worldArrival.active&&!window.__sf.input.suspended);await page.keyboard.press('e');await page.waitForTimeout(650);};
 const go=async(x,z)=>{
   await page.evaluate(([x,z])=>{
     const s=window.__sf;
     s.input.setDriver({update(dt,c){
       const p=s.player.yachtStatus.foot,dx=x-p[0],dz=z-p[2],d=Math.hypot(dx,dz);
       c.clear();if(d<.18)return;
       const v=new s.THREE.Vector3(dx/d,0,dz/d).applyQuaternion(s.player.quaternion),yaw=s.chase.yaw;
       c.axis('KeyA|KeyD',v.x*Math.cos(yaw)-v.z*Math.sin(yaw));
       c.axis('KeyS|KeyW',-v.x*Math.sin(yaw)-v.z*Math.cos(yaw));c.hold('ShiftLeft');
     }});
   },[x,z]);
   try{await page.waitForFunction(([x,z])=>{const p=window.__sf.player.yachtStatus.foot;return Math.hypot(x-p[0],z-p[2])<.22},[x,z],{timeout:18000});}
   catch(e){console.log('MOVE STUCK',x,z,await status());throw e;}
   await page.evaluate(()=>window.__sf.input.setDriver(null));
 };
 await act();assert.match(await page.locator('[data-yacht] p').innerText(),/Reykjavík/);
 await go(0,-11.4);await act();assert.equal((await status()).secret,true);
 await go(0,-14.4);await page.evaluate(()=>{window.__sf.chase.yaw=window.__sf.player.heading-Math.PI;window.__sf.chase.pitch=0;});await page.waitForTimeout(800);
 await page.evaluate(()=>{
   const s=window.__sf,eye=s.player.firstPersonViewPosition(new s.THREE.Vector3()),target=s.player.meshes.yacht.localToWorld(new s.THREE.Vector3(0,5,-20)),dir=target.sub(eye).normalize();
   s.chase.yaw=Math.atan2(-dir.x,-dir.z);s.chase.pitch=Math.asin(dir.y);
 });
 await page.waitForTimeout(2000);
 report.secretView=await page.evaluate(()=>{const s=window.__sf;return {state:s.player.yachtStatus,cameraLocal:s.player.meshes.yacht.worldToLocal(s.camera.position.clone()).toArray(),eye:s.player.firstPersonViewPosition(new s.THREE.Vector3()).toArray(),camera:s.camera.position.toArray(),blend:s.chase.firstPersonBlend}});
 assert.ok(Math.hypot(...report.secretView.camera.map((v,i)=>v-report.secretView.eye[i]))<.6,'exploration camera follows deck-local eyes');
 await page.screenshot({path:out+'/secret-chamber.png'});
 console.log('PASS passenger story and physically discovered secret chamber');
 await page.locator('[data-yacht] button').nth(1).click();await page.locator('[data-yacht] button').first().click();
 await go(8.5,12);await go(8.5,6.5);await act();assert.equal((await status()).deck,1);
 await go(6.8,1);await go(-6,1);await act();assert.equal((await status()).deck,2);
 await go(-2.6,-5);await act();assert.match(await page.locator('[data-yacht] p').innerText(),/Sky Spa/);
 await go(-5.5,-5);await go(-5.5,12.5);await go(3.3,12.5);await act();assert.match(await page.locator('[data-yacht] p').innerText(),/Hokkaido/);
 await go(3.5,18);await page.screenshot({path:out+'/helicopter-pad.png'});await act();assert.equal((await status()).flying,true);
 const before=(await status()).helicopter;
 await page.keyboard.down('Space');await page.waitForTimeout(900);await page.keyboard.up('Space');
 assert.ok((await status()).helicopter[1]>before[1]+3,'helicopter climbs');
 await page.keyboard.down('w');await page.waitForTimeout(700);await page.keyboard.up('w');
 const flown=(await status()).helicopter;assert.ok(Math.hypot(flown[0]-before[0],flown[2]-before[2])>4,'helicopter translates');
 await page.screenshot({path:out+'/helicopter-flight.png'});
 console.log('PASS stairs, rooftop spa, pilot story and helicopter climb/flight');
 const flyTo=async(x,y,z)=>{
   await page.evaluate(([x,y,z])=>{
     const s=window.__sf;
     s.input.setDriver({update(dt,c){c.clear();const p=s.player.yachtStatus.helicopter,dx=x-p[0],dz=z-p[2],d=Math.hypot(dx,dz);
       if(d>.6){const v=new s.THREE.Vector3(dx/d,0,dz/d).applyQuaternion(s.player.quaternion),yaw=s.chase.yaw;
       c.axis('KeyA|KeyD',(v.x*Math.cos(yaw)-v.z*Math.sin(yaw))*Math.min(1,d/4));c.axis('KeyS|KeyW',(-v.x*Math.sin(yaw)-v.z*Math.cos(yaw))*Math.min(1,d/4));}
       if(p[1]<y-.5)c.hold('Space');else if(p[1]>y+.5)c.hold('KeyQ');
     }});
   },[x,y,z]);
   await page.waitForFunction(([x,y,z])=>{const p=window.__sf.player.yachtStatus.helicopter;return Math.hypot(x-p[0],z-p[2])<.8&&Math.abs(y-p[1])<.7},[x,y,z],{timeout:20000});
   await page.evaluate(()=>window.__sf.input.setDriver(null));
 };
 await flyTo(0,13.5,18);await act();assert.equal((await status()).flying,false);assert.equal((await status()).deck,2);
 await act();assert.equal((await status()).flying,true);
 await flyTo(0,22,-29);await flyTo(0,5.6,-29);await act();assert.equal((await status()).flying,false);assert.equal((await status()).deck,0);
 console.log('PASS helicopter landing on both helipads');
 await page.locator('[data-yacht] button').nth(1).click();
 await page.waitForTimeout(400);
 assert.equal(await page.evaluate(()=>window.__sf.player.yachtExploring),false);
 await page.evaluate(()=>{window.__sf.chase.yaw=.8;window.__sf.chase.pitch=.08;window.__sf.chase.zoom=.82;});await page.waitForTimeout(1800);
 await page.screenshot({path:out+'/yacht-exterior-day.png'});
 assert.equal(report.requests.filter(r=>r.phase==='explore'&&r.url.includes('/models/yacht/')).length,0);
 phase='reselect';
 await page.evaluate(()=>{window.__sf.player.trySwitch('walk');});
 assert.equal(await page.locator('[data-yacht]').isVisible(),false);
 await page.evaluate(()=>window.__sf.player.trySwitch('yacht'));
 await page.waitForTimeout(200);
 assert.equal(report.requests.filter(r=>r.phase==='reselect'&&r.url.includes('/models/yacht/')).length,0);
 assert.equal(report.errors.length,0,report.errors.join('\n'));report.ok=true;console.log('PASS selection, exploration, helm return, exit UI cleanup, cached reselection');
}catch(e){try{report.failureState=await page.evaluate(()=>{const s=window.__sf;return {mode:s.player.mode,position:s.player.position.toArray(),arrival:s.worldArrival.snapshot,held:s.player.worldArrivalHeld,suspended:s.input.suspended,yacht:s.player.yachtStatus}});console.error(report.failureState);await page.screenshot({path:out+'/failure.png'});}catch{}report.failure=e.stack;console.error(e);process.exitCode=1;}
finally{await writeFile(out+'/browser-report.json',JSON.stringify(report,null,2));await browser.close();}
