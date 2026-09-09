/** Population/LOD and real streamed branch landing acceptance in the SF world. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
const out=process.env.SF_LIFE_OUT??'.data/aviary/life';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-webgpu','--use-angle=metal']});
const page=await browser.newPage({viewport:{width:1500,height:950}});const errors=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error'&&/aviary|validation|GPU/i.test(m.text()))errors.push(m.text());});
try {
 await page.goto((process.env.SF_PROBE_URL??'http://localhost:5255')+'/?autostart=1&spawn=transamerica&profile=1');
 await page.waitForFunction(()=>window.__sf?.aviary?.stats.draws>=10&&!window.__sf.aviary.stats.pending.length,{},{timeout:180000});
 await page.waitForTimeout(3000);
 const downtown=await page.evaluate(()=>window.__sf.aviary.stats);
 assert(downtown.birds>=180&&downtown.birds<=320);assert(downtown.draws<=12);
 assert(downtown.groups.some(g=>g.triangles<500&&g.drawn===g.count));
 assert(downtown.triangles<1800000,'LOD bounds geometry cost despite denser populations');
 await page.evaluate(()=>window.__sf.sky.setTimeOfDay(13));
 await page.screenshot({path:out+'/downtown-gameplay.png'});
 await page.keyboard.down('Space');await page.waitForTimeout(4500);await page.keyboard.up('Space');await page.evaluate(()=>{window.__sf.chase.yaw=Math.PI;window.__sf.chase.pitch=.08;});await page.waitForTimeout(1000);await page.screenshot({path:out+'/downtown-flight.png'});
 console.log('Downtown',JSON.stringify(downtown));
 await page.evaluate(()=>window.__sf.teleportToTarget(-2250,2150,'Tree landing inspection'));
 await page.waitForFunction(()=>!window.__sf.worldArrival.active,{},{timeout:180000});
 await page.waitForFunction(()=>window.__sf.aviary.stats.groups.some(g=>g.id.startsWith('tree-')),{},{timeout:180000});
 const tree=await page.evaluate(()=>window.__sf.aviary.stats.groups.find(g=>g.id.startsWith('tree-')));
 console.log('Tree group',tree);
 // Keep the player outside the alarm radius and observe without changing the flock.
 await page.evaluate(c=>{const s=window.__sf;void s.player.teleportTo({x:c[0]+65,y:c[1],z:c[2]+65,facing:0,mode:'walk'});window.__sfFreeCam([c[0]+25,c[1]+6,c[2]+28],[c[0],c[1]-8,c[2]]);s.hud.setHidden(true);},tree.center);
 let rests=[],positions=[];
 for(let i=0;i<90;i++) {
   await page.waitForTimeout(1000);
   rests=await page.evaluate(async id=>Array.from(await window.__sf.aviary.debugRest(id)??[]),tree.id);

   if(rests.some(v=>v>.95)) { positions=await page.evaluate(async id=>Array.from(await window.__sf.aviary.debugRead(id)),tree.id);break; }
 }
 assert(rests.some(v=>v>.95),'at least one bird must actually land on a streamed tree');
 await page.screenshot({path:out+'/tree-landing.png'});
 const landed=rests.map((r,i)=>r>.95?i:-1).filter(i=>i>=0);
 const targets=await page.evaluate(id=>window.__sf.aviary.debugPerches(id).targets,tree.id);
 for(const index of landed)assert(Math.hypot(...positions.slice(index*4,index*4+3).map((v,k)=>v-targets[index*4+k]))<.01,'resting birds must hold their actual branch targets');
 const bird=landed[0],p=positions.slice(bird*4,bird*4+3).map((v,i)=>v+tree.center[i]);
 await page.evaluate(p=>{const s=window.__sf;void s.player.teleportTo({x:p[0],y:p[1],z:p[2],facing:0,mode:'walk'});},p);
 await page.waitForTimeout(2500);
 const startled=await page.evaluate(async id=>Array.from(await window.__sf.aviary.debugRest(id)??[]),tree.id);
 assert(startled[bird]<.1,'approaching a resting bird must make it take off');
 await page.evaluate(()=>window.__sf.setFoliageVisible(false));
 const hidden=await page.evaluate(id=>window.__sf.aviary.debugPerches(id)?.active??[],tree.id);
 assert(hidden.every(v=>!v),'hidden trees cannot remain valid perches');
 assert.deepEqual(errors,[]);
 const report={passed:true,downtown,tree,landed,startled,errors};await fs.writeFile(out+'/report.json',JSON.stringify(report,null,2));console.log(report);
} catch(error) {
 console.log('Failure state',await page.evaluate(()=>({stats:window.__sf?.aviary.stats,position:window.__sf?.player.position.toArray(),arrival:window.__sf?.worldArrival.active})).catch(()=>null));
 await page.screenshot({path:out+'/failure.png'}).catch(()=>{});throw error;
} finally {await browser.close();}
