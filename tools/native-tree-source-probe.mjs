import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {posix} from 'node:path';
import {acquirePerformanceProbe} from './performance-probe-lock.mjs';
const release=await acquirePerformanceProbe();
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--enable-features=WebGPUDeveloperFeatures','--enable-dawn-features=allow_unsafe_apis','--enable-gpu','--use-angle=metal','--mute-audio']});
try{const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});await page.goto((process.env.SF_PROBE_URL??'http://localhost:5280')+'/tools/native-tree-source-probe.html');await page.waitForFunction(()=>window.__sourceResult,null,{timeout:180000});const report=await page.evaluate(()=>window.__sourceResult);report.consoleErrors=errors;await mkdir('.data/forest-residency',{recursive:true});await writeFile('.data/forest-residency/source.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));assert.ok(report.ok,report.error);assert.equal(errors.length,0,errors.join('\n'));}finally{await browser.close();await release()}
