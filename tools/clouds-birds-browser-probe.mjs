/** Default sky, real Tweakpane bindings, evolving uniforms, and outlying birds. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
const out=process.env.SF_SKY_OUT??'.data/birds-clouds/acceptance';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-webgpu','--use-angle=metal','--mute-audio']});
const page=await browser.newPage({viewport:{width:1500,height:950}});const errors=[],requests=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error'||m.text().includes('preparation failed'))errors.push(m.text())});
page.on('request',r=>{if(/volumetricClouds|cloudFrame|models\/aviary/.test(r.url()))requests.push(r.url())});
try {
 await page.goto((process.env.SF_PROBE_URL??'http://localhost:5255')+'/?autostart=1&profile=1&zone=tidal-choir');
 await page.waitForFunction(()=>window.__sf&&!window.__sf.worldArrival.active,{},{timeout:180000});
 assert.equal(await page.evaluate(()=>window.__sf.CLOUD_TUNING.values.enabled),true,'clouds must be enabled without a query opt-in');
 await page.waitForFunction(()=>window.__sf.sky.cloudDebug?.frames>10&&window.__sf.aviary.stats.resident.some(id=>id.startsWith('nearby-')),{},{timeout:120000});
 const initial=await page.evaluate(()=>({clouds:window.__sf.sky.cloudDebug,birds:window.__sf.aviary.stats,player:window.__sf.player.position.toArray()}));
 assert(initial.player[0]<-6600 || initial.player[2]<-3200,'probe must exercise the coast outside the old bird grid');
 assert(initial.birds.birds>=12&&initial.birds.birds<=96&&initial.birds.draws<=4&&initial.birds.species.length<=2);
 await page.waitForTimeout(3000);
 const evolved=await page.evaluate(()=>window.__sf.sky.cloudDebug);
 assert(evolved.climateTime>initial.clouds.climateTime);assert(evolved.morph>initial.clouds.morph);assert.notDeepEqual(evolved.drift,initial.clouds.drift);
 await page.screenshot({path:out+'/normal-play.png'});
 await page.evaluate(()=>window.__sf.debugPanel.toggle());
 await page.getByText('weather cycle (min)',{exact:true}).waitFor({state:'attached',timeout:60000});
 const labels=['evolving weather','weather cycle (min)','weather variety','average coverage','optical density','cloud size','billowy shapes','wispy edges','layer depth (m)','wind speed (m/s)','wind direction','shape evolution'];
 for(const label of labels)assert(await page.getByText(label,{exact:true}).count()>0,`missing Tweakpane control: ${label}`);
 await page.evaluate(()=>window.__sf.debugPanel.toggle());
 await page.waitForFunction(()=>!window.__sf.pipeline.compileHeld,{},{timeout:60000});
 await page.evaluate(()=>{const s=window.__sf;s.sky.setTimeOfDay(13);s.sky.cycleEnabled=false;s.hud.setHidden(true);window.__sfFreeCam([-9300,130,-1500],[-8500,600,-2400])});
 await page.waitForTimeout(2500);await page.screenshot({path:out+'/default.png'});
 const poses=[['wisps',{coverage:.42,billow:.05,wisps:1,density:.6,thickness:190}],['billows',{coverage:.57,billow:1,wisps:.05,density:1.6,thickness:650}],['clear',{coverage:.04,billow:.2,wisps:.8,density:.45}]];
 for(const [name,values] of poses){
  await page.evaluate(v=>Object.assign(window.__sf.CLOUD_TUNING.values,{evolving:false,...v}),values);
  await page.waitForTimeout(1800);await page.screenshot({path:out+'/'+name+'.png'});
  const state=await page.evaluate(()=>window.__sf.sky.cloudDebug);assert.equal(state.coverage,values.coverage);
 }
 assert.deepEqual(errors,[]);
 const report={passed:true,initial,evolved,labels,requests,errors};await fs.writeFile(out+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close()}
