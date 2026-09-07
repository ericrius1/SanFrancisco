// Exercise real module attributes, growth, relocation, fade slots and release
// without booting unrelated world features. Browser stays headless.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
const base=process.env.SF_PROBE_URL??'http://localhost:5280';
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();
 await page.route('**/__streaming_probe__',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Module residency test</title>'}));
 await page.goto(`${base}/__streaming_probe__`);
 const report=await page.evaluate(async()=>{
  const THREE=await import('/node_modules/three/build/three.webgpu.js');
  const {createModuleLayer}=await import('/src/world/citygen/render/moduleLayer.ts');
  const scene=new THREE.Group(),layer=createModuleLayer(scene),handles=[];
  const attrs=['aInstA','aInstB','aInstT','aInstG'];
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  const modules=Array.from({length:50},(_,i)=>({module:0,ox:i*3,oy:5,oz:0,ax:1,az:0,w:1.5,h:2,trim:0}));
  const add=seed=>layer.addBuilding(modules,['trim.victorian'],{matrix:new THREE.Matrix4().makeTranslation(seed*100,0,0),zone:'residential',seed});
  const records=()=>scene.children.flatMap(mesh=>{
   const g=mesh.geometry,result=[];
   for(let i=0;i<g.instanceCount;i++)result.push({mesh:mesh.name,slot:g.attributes.aInstB.array[i*4+3],data:attrs.map(k=>Array.from(g.attributes[k].array.slice(i*g.attributes[k].itemSize,(i+1)*g.attributes[k].itemSize)))});
   return result;
  });
  const submitted=()=>scene.children.reduce((s,m)=>s+m.geometry.instanceCount*m.geometry.index.count/3,0);
  for(let i=0;i<100;i++)handles.push(add(i));
  check(handles.every(Boolean),'all buildings admitted');
  const before={...layer.stats(),submittedTriangles:submitted()};
  check(before.capacity>8192,'exercise buffer growth');
  const keep=handles[97],expected=records().filter(r=>r.slot===keep.slot).map(JSON.stringify).sort();
  // Non-tail removal must relocate records belonging to still-live handles.
  for(let i=0;i<100;i++)if(i!==97){handles[i].free();handles[i].free();}
  const after={...layer.stats(),submittedTriangles:submitted()};
  check(JSON.stringify(records().map(JSON.stringify).sort())===JSON.stringify(expected),'swaps preserve every survivor attribute, lamp identity and fade slot');
  check(after.instances===100&&after.buildings===1,'one building remains');
  check(after.submittedTriangles===before.submittedTriangles/100,'submission must shrink with live population');
  keep.setFade(0.7);keep.setGlassHidden(true);
  for(let i=0;i<600;i++){const h=add(i+1000);check(h,'churn allocation');h.free();}
  check(submitted()===after.submittedTriangles,'travel history cannot grow submission');
  keep.free();check(submitted()===0,'empty city submits zero modules');
  layer.dispose();check(scene.children.length===0,'all layer roots disposed');
  return {ok:true,before,after,churnCycles:600,emptySubmittedTriangles:0};
 });
 assert.ok(report.ok);
 await mkdir('.data/streaming-audit',{recursive:true});
 await writeFile('.data/streaming-audit/module-residency.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}
