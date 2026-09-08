/** Exercise the real world's proximity gate and disposal, with a fresh profile. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
const base=process.env.SF_PROBE_URL??'http://localhost:5255';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-webgpu','--use-angle=metal','--enable-features=WebGPU']});
const page=await browser.newPage({viewport:{width:1280,height:800}});
const assets=[],chunks=[],errors=[];
page.on('request',r=>{const u=r.url();if(u.includes('/models/aviary/'))assets.push(u.split('/').pop());if(/\/world\/aviary\/(runtime|flock|asset)\./.test(u))chunks.push(u);});
page.on('pageerror',e=>errors.push(String(e)));
page.on('console',m=>{if(m.type()==='error'&&m.text().includes('[aviary]'))errors.push(m.text());});
const stats=()=>page.evaluate(()=>window.__sf.aviary.stats);
try{
 await page.goto(base+'/?autostart=1&spawn=transamerica');
 await page.waitForFunction(()=>window.__sf?.aviary&&window.__sf.worldArrival.active===false,{},{timeout:180000});
 await page.waitForTimeout(1500);
 assert.deepEqual(assets,[],'downtown boot must fetch zero bird models');assert.deepEqual(chunks,[],'downtown boot must fetch zero optional bird code');
 console.log('Clean boot: no bird code or models.');
 await page.evaluate(()=>window.__sf.teleportToTarget(-5920,660,'Bird habitat'));
 await page.waitForFunction(()=>window.__sf.aviary.stats.resident.includes('lands-end-pearl'),{},{timeout:120000});
 assert.deepEqual(assets,['pearl-gull.glb']);const pearl=await stats();
 console.log('Lands End:',pearl);
 await page.evaluate(()=>window.__sf.teleportToTarget(408,2760,'Bird habitat'));
 await page.waitForFunction(()=>window.__sf.aviary.stats.resident.includes('corona-ember'),{},{timeout:120000});
 assert.deepEqual(assets,['pearl-gull.glb','ember-kestrel.glb']);const ember=await stats();
 assert.deepEqual(ember.resident,['corona-ember'],'leaving a habitat must release its flock');
 assert.deepEqual(ember.species,['ember-kestrel'],'leaving must dispose the unused species');
 console.log('Corona:',ember);
 await page.evaluate(()=>window.__sf.teleportToTarget(0,0,'Return downtown'));
 await page.waitForFunction(()=>window.__sf.aviary.stats.draws===0,{},{timeout:90000});
 const departed=await stats();assert.equal(departed.textureBytes,0);assert.deepEqual(errors,[]);
 const report={passed:true,assets,optionalChunks:chunks.length,pearl,ember,departed,errors};
 await fs.writeFile('.data/aviary/game-probe.json',JSON.stringify(report,null,2));console.log(report);
}finally{await browser.close();}
