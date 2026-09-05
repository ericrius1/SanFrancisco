import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('.data/world-upgrade',{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--use-angle=metal','--mute-audio']});
const report={requests:[],errors:[]};let phase='pocket-boot';
try{
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 page.on('request',r=>{if(/teaGarden|beachPianist|surfing\/shack\.ts/.test(r.url()))report.requests.push({phase,url:r.url()})});
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto((process.env.SF_PROBE_URL??'http://localhost:5270')+'/?autostart=1&profile&fullfps&zone=tidal-choir',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__sf?.minimap&&!window.__sf.worldArrival.active,null,{timeout:180000});
 report.pins=await page.evaluate(()=>Object.fromEntries(['Japanese Tea Garden','Beach Pianist','Botanical Garden','Presidio Golf','Tidal Choir · Marin'].map(name=>[name,window.__sf.minimap.focusLandmark(name)])));
 for(const [name,pose] of Object.entries(report.pins))assert.ok(pose,`${name} must appear immediately in pocket map`);
 assert.equal(report.requests.filter(r=>!/tuning|layout|metadata|meta\.ts|app\/compose\/teaGarden/.test(r.url)).length,0,'map metadata must not activate distant landmarks');
 await page.evaluate(()=>window.__sf.minimap.focusLandmark('Japanese Tea Garden'));
 await page.waitForTimeout(1000);
 await page.screenshot({path:'.data/world-upgrade/restored-garden-map.png',timeout:120000});
 phase='tea-garden';
 await page.evaluate(()=>{const sf=window.__sf,p=sf.minimap.focusLandmark('Japanese Tea Garden');sf.minimap.setExpanded(false);sf.minimap.onTeleport(p.x,p.z,'Japanese Tea Garden');});
 await page.waitForFunction(()=>window.__sf.japaneseTeaGarden&&!window.__sf.worldArrival.active,null,{timeout:240000});
 report.teaGarden=await page.evaluate(()=>({ready:!!window.__sf.japaneseTeaGarden,cap:window.__sf.tiles.backgroundStreamingDebug.limit}));
 assert.ok(report.teaGarden.cap>900,'map travel leaves pocket scope');
 await page.screenshot({path:'.data/world-upgrade/restored-garden-arrival.png',timeout:120000});
 await page.evaluate(()=>window.__sf.minimap.focusLandmark('Beach Pianist'));
 await page.waitForTimeout(1000);
 await page.screenshot({path:'.data/world-upgrade/restored-pianist-map.png',timeout:120000});
 phase='beach-pianist';
 await page.evaluate(()=>{const sf=window.__sf,p=sf.minimap.focusLandmark('Beach Pianist');sf.minimap.setExpanded(false);sf.minimap.onTeleport(p.x,p.z,'Beach Pianist');});
 await page.waitForFunction(()=>window.__sf.beachPianist&&!window.__sf.worldArrival.active,null,{timeout:240000});
 await page.screenshot({path:'.data/world-upgrade/restored-pianist-arrival.png',timeout:120000});
 report.beachPianist=true;assert.equal(report.errors.length,0,report.errors.join('\n'));report.ok=true;
 console.log(JSON.stringify({ok:true,pins:report.pins,teaGarden:report.teaGarden,beachPianist:true},null,2));
}catch(e){report.ok=false;report.failure=e.stack;console.error(e);process.exitCode=1}
finally{await mkdir('.data/world-upgrade',{recursive:true});await writeFile('.data/world-upgrade/landmarks.json',JSON.stringify(report,null,2));await browser.close()}
