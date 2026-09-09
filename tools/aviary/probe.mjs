/** Real headless WebGPU acceptance: lazy requests, articulated animation,
 * bounded flocking, swept-plane response and recovery, switching/disposal. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
const base=process.env.SF_PROBE_URL??'http://localhost:5255';
const out='.data/aviary';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-webgpu','--use-angle=metal','--enable-features=WebGPU']});
const page=await browser.newPage({viewport:{width:1500,height:1000}});
const errors=[],requests=[],assetUrls=[];
page.on('pageerror',e=>errors.push(String(e)));
page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});
page.on('request',r=>{if(r.url().includes('/models/aviary/')){assetUrls.push(r.url());requests.push(r.url().split('/').pop().split('?')[0]);}});
const ready=()=>page.waitForFunction(()=>window.__aviary?.stats.draws>0&&!document.querySelector('#status').textContent.includes('Preparing'),{},{timeout:60000});
try{
 await page.goto(base+'/aviary.html?autostart=1');
 await page.waitForTimeout(1000);assert.deepEqual(requests,[],'boot must fetch zero bird assets');
 await page.locator('[data-species="pearl-gull"]').click();await ready();
 assert.deepEqual(requests,['pearl-gull.glb'],'activation loads only selected bird');
 await page.locator('#motion').selectOption('Glide');await page.waitForTimeout(400);
 const glide=await page.screenshot({path:out+'/web-pearl-glide.png'});
 await page.locator('#motion').selectOption('Fly');await page.waitForTimeout(350);
 const fly=await page.screenshot({path:out+'/web-pearl-fly.png'});
 assert.notDeepEqual(glide,fly,'Fly and Glide must render different poses');
 await page.locator('[data-species="lagoon-jay"]').click();await ready();
 assert.deepEqual(requests,['pearl-gull.glb','lagoon-jay.glb'],'choice loads exactly the new species');
 await page.screenshot({path:out+'/web-lagoon.png'});
 await page.locator('#flock').click();await ready();await page.waitForTimeout(1500);
 const initial=(await page.evaluate(()=>window.__aviary.read()))[0];assert.equal(initial.length,48*4);
 await page.waitForTimeout(600);const moved=(await page.evaluate(()=>window.__aviary.read()))[0];
 assert(moved.every(Number.isFinite),'GPU positions must stay finite');
 assert(Math.hypot(...moved.slice(0,3).map((v,i)=>v-initial[i]))>.1,'flock must actually move');
 for(const distance of [150,500,0]) {await page.evaluate(d=>window.__aviary.setLodDistance(d),distance);await page.waitForTimeout(350);await page.screenshot({path:out+'/web-lod-'+distance+'.png'});}
 await page.locator('#motion').selectOption('Auto');
 await page.locator('#scatter').click();await page.waitForTimeout(1700);
 const alarm=(await page.evaluate(()=>window.__aviary.motion()))[0];
 const maxFear=Math.max(...alarm.filter((_,i)=>i%4===3));assert(maxFear>.2,'plane must trigger Scatter response');
 await page.screenshot({path:out+'/web-scatter.png'});
 await page.waitForTimeout(14000);
 const recovered=(await page.evaluate(()=>window.__aviary.motion()))[0];
 const recoveredFear=Math.max(...recovered.filter((_,i)=>i%4===3));assert(recoveredFear<maxFear*.6,'birds must recover after the plane leaves');
 const positions=(await page.evaluate(()=>window.__aviary.read()))[0];
 for(let i=0;i<positions.length;i+=4){assert(positions.slice(i,i+4).every(Number.isFinite));assert(Math.hypot(...positions.slice(i,i+3))<130,'habitat steering must keep flock bounded');}
 await page.locator('#compare').click();await page.waitForFunction(()=>window.__aviary?.stats.draws===3,{},{timeout:60000});await page.waitForTimeout(750);
 await page.screenshot({path:out+'/web-lineup.png'});
 const stats=await page.evaluate(()=>window.__aviary.stats);
 assert.equal(stats.draws,3);
 for(const value of new Set(assetUrls)) {
   const url=new URL(value),name=url.pathname.split('/').pop();
   const digest=createHash('sha256').update(await fs.readFile('public/models/aviary/'+name)).digest('hex').slice(0,16);
   assert.equal(url.searchParams.get('v'),digest,'each model URL must invalidate caches when the exported bytes change');
 }
 assert(stats.geometryFormatsMatch,'LOD swaps must preserve quantized vertex formats');
 assert(stats.lods.every(l=>l.length===3&&l[1]<2300&&l[2]<500),'distant geometry must stay bounded');
 assert.equal(stats.allTexturesCompressed,true,'color and normal maps must remain GPU compressed');
 assert(stats.textureBytes>0&&stats.textureBytes<22*1024*1024,'three species texture residency must stay below 22 MiB');
 await page.setViewportSize({width:420,height:850});await page.waitForTimeout(300);await page.screenshot({path:out+'/web-mobile.png'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile should not overflow');
 await page.evaluate(()=>window.__aviary.dispose());
 assert.deepEqual(errors,[],'no WebGPU validation or JS errors');
 const report={passed:true,requests,maxFear,recoveredFear,positionsFinite:true,draws:3,textureBytes:stats.textureBytes,allTexturesCompressed:stats.allTexturesCompressed,errors};await fs.writeFile(out+'/probe.json',JSON.stringify(report,null,2));console.log(report);
}catch(error){console.error('Aviary acceptance failed:',error);throw error;}finally{await browser.close();}
