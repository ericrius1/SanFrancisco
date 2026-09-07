// Real production materials in a controlled WebGPU scene; never opens a window.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { acquirePerformanceProbe } from './performance-probe-lock.mjs';
const out=process.env.SF_PROBE_OUT??'.data/streaming-upgrade/buildings';
await mkdir(out,{recursive:true});
const release=await acquirePerformanceProbe();
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--enable-features=WebGPUDeveloperFeatures','--enable-dawn-features=allow_unsafe_apis','--enable-gpu','--use-angle=metal']});
const report={errors:[],shots:[]};
try {
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text())});
 await page.goto((process.env.SF_PROBE_URL??'http://localhost:5280')+'/tools/citygen-landscape-fixture.html');
 await page.waitForFunction(()=>window.__landscapeFixture||window.__landscapeFixtureError,null,{timeout:60000});
 assert.equal(await page.evaluate(()=>window.__landscapeFixtureError),undefined);
 for(const view of ['elevated','street','roof-back'])for(const tier of ['landscape','detail']){
  const state=await page.evaluate(s=>window.__landscapeFixture.set(s),{tier,view,night:false});
  await page.screenshot({path:`${out}/${view}-${tier}.png`});report.shots.push(state);
 }
 for(const tier of ['landscape','detail']){
  const state=await page.evaluate(s=>window.__landscapeFixture.set(s),{tier,view:'elevated',night:true});
  await page.screenshot({path:`${out}/night-${tier}.png`});report.shots.push(state);
 }
 assert.ok(report.shots.every(s=>s.landscapeTriangles<s.detailTriangles*0.05),'same building silhouettes remain substantially cheaper than detailed geometry');
 assert.equal(report.errors.length,0,report.errors.join('\n'));
 console.log(JSON.stringify({ok:true,shots:report.shots.length,...report.shots[0]}));
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await release();}
