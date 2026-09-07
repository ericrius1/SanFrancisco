import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const temporary=await mkdtemp(tmpdir()+'/tree-impostor-test-');
const result = await build({stdin:{contents:`
 export { compileTree } from './src/world/treeCompiler/index.ts';
 export { createNativeTreeArchetype } from './src/world/vegetation/nativeTreeRecipes.ts';
 export { bakeTreeImpostor, TREE_IMPOSTOR_YAWS, TREE_IMPOSTOR_ELEVATIONS, TREE_IMPOSTOR_TILE, TREE_IMPOSTOR_HULL_PLANES } from './src/world/nativeTreeForest/impostorBake.ts';
`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
await writeFile(temporary+'/probe.mjs',result.outputFiles[0].contents);
const {compileTree,createNativeTreeArchetype,bakeTreeImpostor,TREE_IMPOSTOR_YAWS:Y,TREE_IMPOSTOR_ELEVATIONS:E,TREE_IMPOSTOR_TILE:T,TREE_IMPOSTOR_HULL_PLANES:H}=await import(pathToFileURL(temporary+'/probe.mjs').href);
await rm(temporary,{recursive:true});
const output=[];
for(const [species,seed] of [['coast-redwood',911],['monterey-cypress',922],['coast-live-oak',933],['eucalyptus',944],['windswept-monterey-cypress',955],['monterey-pine',966]]){
 const heights=[18,11,9.5,15,14,17],density=[0.8,0.82,0.78,0.8,0.86,0.76],widths=[0.9,0.9,0.9,0.88,1.04,0.94];
 const n=output.length;
 const recipe=createNativeTreeArchetype(species,{height:heights[n],crownDensity:density[n],crownWidth:widths[n]}).recipe;
 const compiled=compileTree(recipe,seed);
 const start=performance.now();const atlas=bakeTreeImpostor(compiled.lods[3]);const ms=performance.now()-start;
 assert.equal(atlas.width,Y*T);assert.equal(atlas.height,E*T);
 assert.equal(atlas.color.byteLength,Y*E*T*T*4);
 assert.ok(atlas.color.byteLength<1.1e6,"atlas remains bounded at about 1MiB per prototype");
 assert.ok(atlas.size.every(v=>Number.isFinite(v)&&v>0));
 const coverage=[];
 for(let row=0;row<E;row++)for(let col=0;col<Y;col++){
  let pixels=0,soft=0;
  for(let y=0;y<T;y++)for(let x=0;x<T;x++){
   const i=((row*T+y)*atlas.width+col*T+x)*4;
   const alpha=atlas.color[i+3];
   if(alpha){
    pixels++;if(alpha<255)soft++;
    assert.ok(x>0&&y>0&&x<T-1&&y<T-1,'each capture fits inside a transparent border');
    const nx=atlas.color[i]/255*2-1,ny=atlas.color[i+1]/255*2-1,nz=1-Math.abs(nx)-Math.abs(ny),fold=Math.max(0,-nz);
    const n=[nx+(nx>=0?-fold:fold),ny+(ny>=0?-fold:fold),nz];
    assert.ok(Math.hypot(...n)>0.55&&Math.hypot(...n)<1.01,'octahedral normal decodes without degeneracy');
    for(let p=0;p<H;p++){
     const angle=p/H*Math.PI*2;
     const support=((x+0.5)/T-0.5)*Math.cos(angle)+((y+0.5)/T-0.5)*Math.sin(angle);
     assert.ok(support<atlas.hulls[row*H+p],'capture-derived hull contains every covered pixel');
    }
   }
  }
  assert.ok(pixels>30,'every yaw and overhead view has a silhouette');
  assert.ok(soft>0,'supersampled silhouettes preserve partial coverage');
  coverage.push(pixels);
 }
 assert.ok(new Set(coverage).size>8,'capture follows real asymmetric shape across viewpoints');
 output.push({species,horizonTriangles:compiled.lods[3].stats.triangles,impostorTriangles:H-2,bakeMs:Number(ms.toFixed(1)),coverageRange:[Math.min(...coverage),Math.max(...coverage)],bytes:atlas.color.byteLength+atlas.hulls.byteLength});
 if(species==='coast-redwood'){
  const again=bakeTreeImpostor(compiled.lods[3]);assert.deepEqual(atlas.color,again.color);assert.deepEqual(atlas.hulls,again.hulls);
 }
}
console.log(JSON.stringify(output,null,2));
console.log('PASS: deterministic actual-mesh capture; all yaw/elevation views covered, nondegenerate, padded, supersampled and bounded.');
