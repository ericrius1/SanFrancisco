/** Exercise the real world's proximity gate and disposal, with a fresh profile. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
const base=process.env.SF_PROBE_URL??'http://localhost:5255';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-webgpu','--use-angle=metal','--enable-features=WebGPU']});
const page=await browser.newPage({viewport:{width:1280,height:800}});
const assets=[],chunks=[],errors=[];
page.on('request',r=>{const u=r.url();if(u.includes('/models/aviary/'))assets.push(u.split('/').pop().split('?')[0]);if(/(?:\/world\/aviary\/(?:runtime|flock|asset)\.|\/assets\/(?:runtime|flock|asset)-)/.test(u))chunks.push(u);});
page.on('pageerror',e=>errors.push(String(e)));
page.on('console',m=>{if(m.type()==='error'&&(m.text().includes('[aviary]')||/validation|GPU/i.test(m.text())))errors.push(m.text());});
const stats=()=>page.evaluate(()=>window.__sf.aviary.stats);
try{
 await page.goto(base+'/?autostart=1&spawn=transamerica&profile=1');
 await page.waitForFunction(()=>window.__sf?.aviary&&window.__sf.worldArrival.active===false,{},{timeout:180000});
 await page.waitForTimeout(1500);
 assert.deepEqual(assets,[],'downtown boot must fetch zero bird models');assert.deepEqual(chunks,[],'downtown boot must fetch zero optional bird code');
 console.log('Clean boot: no bird code or models.');
 await page.waitForFunction(()=>window.__sf.aviary.stats.draws>0&&window.__sf.aviary.stats.pending.length===0,{},{timeout:90000});
 const downtown=await stats();assert(downtown.habitats>100);assert(downtown.birds<=320);assert(downtown.draws<=12);assert(downtown.species.length<=3);
 assert.deepEqual([...new Set(assets)].sort(),downtown.species.map(s=>s+'.glb').sort());
 console.log('Downtown encounter:',downtown);
 const first=assets.length;
 await page.evaluate(()=>window.__sf.teleportToTarget(-5920,660,'Bird habitat'));
 await page.waitForFunction(()=>window.__sf.aviary.stats.resident.includes('lands-end-pearl')&&window.__sf.aviary.stats.pending.length===0,{},{timeout:120000});
 const pearl=await stats();
 assert(assets.slice(first).every(a=>pearl.species.some(s=>a===s+'.glb')),'travel loads only local species');
 assert(pearl.birds<=320&&pearl.draws<=12&&pearl.species.length<=3);
 console.log('Lands End:',pearl);
 await page.waitForTimeout(1600);
 const poses=await page.evaluate(async()=>Array.from(await window.__sf.aviary.debugRead('lands-end-pearl')));
 assert(poses.every(Number.isFinite));assert.equal(poses.length,36*4);
 await page.waitForTimeout(600);
 const moved=await page.evaluate(async()=>Array.from(await window.__sf.aviary.debugRead('lands-end-pearl')));
 assert(moved.some((v,i)=>i%4!==3&&Math.abs(v-poses[i])>.1),'birds must move inside the actual SF simulation');
 await page.waitForFunction(()=>window.__sf.renderIdle(),{},{timeout:120000});
 await page.evaluate(()=>{
   window.__sf.sky.setTimeOfDay(13);window.__sf.materialize.reveal();
   const s=window.__sf,g=s.aviary.stats.groups.find(g=>g.id==='lands-end-pearl'),c=g.center;
   window.__birdDraws=0;s.scene.getObjectByName('aviary:lands-end-pearl').onBeforeRender=()=>window.__birdDraws++;
   window.__sfFreeCam([c[0]+45,c[1]+12,c[2]+50],c);s.hud.setHidden(true);
 });
 await page.waitForTimeout(3500);assert(await page.evaluate(()=>window.__birdDraws>0),'flock must be submitted by the real world renderer');await page.screenshot({path:'.data/aviary/revision/sf-flock.png'});
 await page.evaluate(()=>{window.__sfFreeCam(null);window.__sf.teleportToTarget(408,2760,'Bird habitat');});
 await page.waitForFunction(()=>window.__sf.aviary.stats.resident.includes('corona-ember')&&window.__sf.aviary.stats.pending.length===0,{},{timeout:120000});
 const ember=await stats();assert(!ember.resident.includes('lands-end-pearl'));assert(ember.birds<=320&&ember.draws<=12&&ember.species.length<=3);
 console.log('Corona:',ember);
 // Leave the city's authored airspace; no distant wildlife stays resident.
 await page.waitForFunction(()=>!window.__sf.worldArrival.active,{},{timeout:120000});
 await page.evaluate(()=>{const s=window.__sf;s.frameDriver.setManual(true);s.player.position.set(7000,700,-7500);s.player.renderPosition.copy(s.player.position);s.aviary.update(1/30);});
 await page.waitForFunction(()=>window.__sf.aviary.stats.draws===0,{},{timeout:90000});
 const departed=await stats();assert.equal(departed.textureBytes,0);assert.deepEqual(errors,[]);
 const report={passed:true,assets,optionalChunks:chunks.length,downtown,pearl,ember,departed,errors};
 await fs.writeFile('.data/aviary/game-probe.json',JSON.stringify(report,null,2));console.log(report);
}finally{await browser.close();}
