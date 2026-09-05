import { chromium } from 'playwright-core';
import { mkdir,writeFile } from 'node:fs/promises';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--use-angle=metal']});
try {
 const page=await browser.newPage();
 page.on('pageerror',e=>console.error(e));
 await page.goto(`${process.env.SF_PROBE_URL??'http://localhost:5270'}/tools/world-upgrade-gpu-probe.html`);
 await page.waitForFunction(()=>window.__gpuResult,null,{timeout:120000});
 const result=await page.evaluate(()=>window.__gpuResult);
 await mkdir('.data/world-upgrade',{recursive:true});
 await writeFile('.data/world-upgrade/gpu.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
 if(!result.ok)process.exitCode=1;
}finally{await browser.close();}
