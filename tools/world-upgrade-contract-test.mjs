import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

await mkdir('.data/world-upgrade', {recursive:true});
const file=path.resolve('.data/world-upgrade/contracts.mjs');
await build({stdin:{contents:`
export {RingCoordinator} from './src/app/ringCoordinator';
export {createFrameScheduler} from './src/core/frameBudget';
export {createQualityDwell} from './src/render/qualityDwell';
export {createCullCamera} from './src/render/gpuIndirect';
export {FoliageField} from './src/world/groundcover/foliageField';
export {createNativeTreeGpuFarTiers} from './src/world/nativeTreeForest/gpuFarTiers';
export {choirPad,choirPadAt} from './src/gameplay/tidalChoir/meta';
`,resolveDir:process.cwd()},outfile:file,bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{
 name:'cull-lifecycle-material-stub',setup(build){
  // Exercise real arena/residency/dispatch ownership without compiling the
  // unrelated tree material shader in a CPU test. GPU culling has its own probe.
  build.onResolve({filter:/vegetation\/nativeTreeMaterials$/},()=>({path:'tree-materials',namespace:'test'}));
  build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`import {MeshBasicNodeMaterial} from 'three/webgpu';export function createNativeTreeIndirectFarMaterials(){const m=new MeshBasicNodeMaterial();return {branch:{landscape:m,horizon:m},foliage:{landscape:m,horizon:m},dispose(){m.dispose()}};}`,resolveDir:process.cwd()}));
 }
}]} );
const {RingCoordinator,createFrameScheduler,createQualityDwell,createCullCamera,FoliageField,createNativeTreeGpuFarTiers,choirPad,choirPadAt}=await import(pathToFileURL(file));
const THREE=await import('three/webgpu');

const scheduler=createFrameScheduler(), order=[];
for(const lane of ['background','upload','build','physics']) scheduler.schedule(lane,()=>{order.push(lane);});
scheduler.run(0); assert.equal(scheduler.pending,4);
scheduler.run(100); assert.deepEqual(order,['physics','build','upload','background']);
let slices=0;
scheduler.schedule('build',()=>++slices<3?'again':undefined);
for(let i=1;i<=3;i++) {scheduler.run(100);assert.equal(slices,i);assert.equal(scheduler.pending,i<3?1:0);}
const actual=[];
for(let i=0;i<12000;i++)scheduler.schedule('physics',()=>{actual.push(i);});
scheduler.run(10000);assert.deepEqual(actual,Array.from({length:12000},(_,i)=>i));
assert.equal(scheduler.pending,0);assert.equal(scheduler.waiting,0);

const dwell=createQualityDwell();
assert.equal(dwell.ready(1,100000,1000),false,'old idle time is not pressure');
assert.equal(dwell.ready(1,100999,1000),false);
assert.equal(dwell.ready(1,101000,1000),true);
dwell.ready(0,101001,1000);
assert.equal(dwell.ready(1,105000,1000),false,'neutral breaks continuity');
assert.equal(dwell.ready(-1,106000,1000),false,'opposite pressure starts a new dwell');
assert.equal(dwell.ready(-1,107000,1000),true);
dwell.reset();assert.equal(dwell.ready(-1,200000,1000),false,'pause/re-enable reset');

const cull=createCullCamera(), camera=new THREE.PerspectiveCamera(60,1,0.1,1000);
assert.equal(cull.update(camera),true);assert.equal(cull.update(camera),false);
camera.position.x=10;assert.equal(cull.update(camera),true);assert.equal(cull.update(camera),false);
camera.lookAt(0,0,-10);assert.equal(cull.update(camera),true);
camera.fov=45;camera.updateProjectionMatrix();assert.equal(cull.update(camera),true);
for(let i=0;i<6;i++){const p=choirPad(i);assert.equal(choirPadAt(p.x,p.z),i);}
assert.equal(choirPadAt(0,0),-1);assert.equal(choirPadAt(NaN,9),-1);

// Reverse direction after a partially sampled toroidal slab. Old in-flight
// writes must not survive in cells reused by the new destination.
const jobs=[];
const field=new FoliageField({size:16,spacing:1,groundHeight:(x,z)=>x+z*1000,plantable:()=>true,schedule:j=>jobs.push(j),now:()=>0,maxCellsPerSlice:16});
const drain=()=>{let guard=0;while(jobs.length){const j=jobs.shift();if(j()==='again')jobs.push(j);assert.ok(++guard<1000);}};
const initial=field.request({x:0,z:0});drain();await initial;
const cancelled=field.request({x:4,z:0});const partial=jobs.shift();assert.equal(partial(),'again');jobs.push(partial);
const replacement=field.request({x:-1,z:0});drain();await Promise.all([cancelled,replacement]);
const bounds=field.bounds;
for(let z=bounds.minZ;z<=bounds.maxZ;z++)for(let x=bounds.minX;x<=bounds.maxX;x++){
 const offset=(((z%16+16)%16)*16+(x%16+16)%16)*4;
 assert.equal(field.data[offset],x+z*1000,`stale toroidal sample at ${x},${z}`);
}
field.dispose();
const treeGeometry=new THREE.BoxGeometry(1,1,1);
const forest=createNativeTreeGpuFarTiers([0,1].map(design=>({design,landscapeBranch:treeGeometry,landscapeFoliage:treeGeometry,horizonBranch:treeGeometry,horizonFoliage:treeGeometry,style:{},assets:{},canopyCenter:[0,1,0],canopyRadii:[1,1,1],boundsCenterY:1,boundsRadius:2,total:4})),{name:'test-forest',horizonDistance:100,visibleDistance:200});
const dispatches=[],renderer={compute:passes=>dispatches.push(passes.length)};
forest.dispatch(renderer,camera,0,0);forest.dispatch(renderer,camera,0,0);assert.deepEqual(dispatches,[1]);
const slot={x:0,y:0,z:-20,yaw:0,scale:1,variation:0,dryness:0};
const a=forest.admitChunk(0,[slot]);assert.ok(a);
forest.dispatch(renderer,camera,0,0);assert.equal(dispatches.at(-1),2,'reset and one occupied design');
const before=dispatches.length;forest.dispatch(renderer,camera,0,0);assert.equal(dispatches.length,before,'stationary inputs reuse cull results');
forest.setInstanceHidden(a,0,1,true);forest.dispatch(renderer,camera,0,0);assert.equal(dispatches.length,before+1,'near takeover invalidates');
forest.setInstanceHidden(a,0,1,false);forest.dispatch(renderer,camera,0,0);assert.equal(dispatches.length,before+2,'near release invalidates');
forest.dispatch(renderer,camera,1,0);assert.equal(dispatches.length,before+3,'focus invalidates');
camera.position.z+=1;forest.dispatch(renderer,camera,1,0);assert.equal(dispatches.length,before+4,'camera invalidates');
const b=forest.admitChunk(1,[slot]);forest.dispatch(renderer,camera,1,0);assert.equal(dispatches.at(-1),3);
forest.releaseChunk(a);forest.dispatch(renderer,camera,1,0);assert.equal(dispatches.at(-1),2,'empty design leaves dispatch list');
forest.releaseChunk(b);forest.dispatch(renderer,camera,1,0);assert.equal(dispatches.at(-1),1,'last retirement clears every draw');
assert.equal(forest.group.visible,false);const parked=dispatches.length;forest.dispatch(renderer,camera,1,0);assert.equal(dispatches.length,parked);
forest.dispose();treeGeometry.dispose();
const ring=new RingCoordinator(0,0,{fullRadius:900,fillRadius:900,player:{position:{x:0,z:0}},tiles:{residentRadiusAround:()=>900,backgroundStreamingDebug:{radius:900}},terrainRadius:()=>1300,prime:()=>{},spreadGate:()=>true});
let ticks=0;
while(ring.state!=='settled'&&ticks<200){ring.update(0.1);ticks++;}
assert.equal(ring.state,'settled','900 m pocket must finish before the 45-second scan timeout');
assert.ok(ticks<180);
console.log('PASS: pocket scan terminates within its residency boundary');
console.log('PASS: scheduler ordering/backlog/retries, continuous quality dwell, cull invalidation, choir pads, cancelled foliage paging, forest residency/near handoff/parking');
