import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
await mkdir('.data/world-upgrade',{recursive:true});
const path='.data/world-upgrade/wave2-contract.mjs';
await build({stdin:{contents:`export { warmRootPaced } from './src/render/warmStaticRegion.ts'; export { RoadGraph } from './src/world/traffic/roadGraph.ts'; export { laptopFrameIntervalMs, laptopProfile } from './src/render/laptopProfiles.ts'; export { RENDER_TUNING } from './src/config.ts';`,resolveDir:process.cwd()},outfile:path,bundle:true,platform:'node',format:'esm',packages:'external'});
const {warmRootPaced,RoadGraph,laptopFrameIntervalMs,laptopProfile,RENDER_TUNING}=await import(pathToFileURL(process.cwd()+'/'+path));
const THREE=await import('three/webgpu');
const root=new THREE.Group(),geometry=new THREE.BoxGeometry(),material=new THREE.MeshStandardMaterial();
for(let i=0;i<200;i++)root.add(new THREE.Mesh(geometry,material));
root.children[50].visible=false;const before=root.children.map(o=>o.visible),counts=[];
const fake={compileAsync:async owner=>{let count=0;owner.traverseVisible(o=>{if(o.isMesh)count++});counts.push(count)}};
const result=await warmRootPaced(fake,new THREE.PerspectiveCamera(),new THREE.Scene(),root,async()=>{});
assert.equal(result.representatives,1);assert.deepEqual(counts,[1],'duplicates must not enter representative compile');assert.deepEqual(root.children.map(o=>o.visible),before);
const roads=new RoadGraph({v:4,segs:[{p:[0,0,1000,0],w:10,d:1},{p:[1000,0,2000,0],w:10,d:-1},{p:[1000,0,1000,1000],w:10,d:1},{p:[1000,0,1000,-1000],w:10,d:1}]});
for(let i=0;i<100;i++){const e=roads.junctionExit(0,1,i);assert.ok(e);assert.ok(e.seg===2||e.seg===3,'never enter one-way against traffic');assert.equal(e.dir,1)}
assert.equal(roads.junctionExit(0,-1),null,'dead end returns no exit');
assert.deepEqual(roads.junctionExit(0,1,17),roads.junctionExit(0,1,17),'routing is deterministic');
const cityRoads=new RoadGraph(JSON.parse(await readFile('public/data/roads.json','utf8')));
let connectedExits=0;
for(let seg=0;seg<cityRoads.segCount;seg++)for(const dir of [-1,1]) {
 const exit=cityRoads.junctionExit(seg,dir,17);
 if(!exit)continue;
 connectedExits++;
 const allowed=cityRoads.segmentMeta(exit.seg).oneWayDir;
 assert.ok(!allowed||allowed===exit.dir,'authored road exit respects one-way direction');
}
assert.ok(connectedExits>1000,'endpoint matching must connect the real authored city');
for(const [profile,hz] of [['quiet',30],['balanced',60],['high',0]]){RENDER_TUNING.values.profile=profile;RENDER_TUNING.values.quietMode=false;assert.equal(laptopProfile().hz,hz);assert.equal(laptopFrameIntervalMs(),hz?1000/hz-1:0)}
RENDER_TUNING.values.quietMode=true;assert.equal(laptopFrameIntervalMs(),1000/30-1,'battery cap also works in High');
console.log('PASS: representative compile excludes 199 duplicates; legal/deterministic junctions; refresh-independent profile caps');
console.log(`PASS: ${connectedExits} connected exits across ${cityRoads.segCount} authored road segments`);
