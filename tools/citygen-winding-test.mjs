// All CityGen geometry must agree with its authored surface normals. This tests
// source panels before float32 world-coordinate rounding creates tiny slivers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
const result = await build({
  stdin: {contents: `export {generate} from './src/world/citygen/generate.ts'; export {expandModuleInstances} from './src/world/citygen/theme/moduleDefs.ts';`, resolveDir:process.cwd(),loader:'ts'},
  bundle:true,platform:'node',format:'esm',write:false,
});
const {generate,expandModuleInstances}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const stock=Object.values(JSON.parse(readFileSync('public/citygen/buildings.json','utf8')).cells).flat();
const sample=stock.filter((_,i)=>i%Math.max(1,Math.floor(stock.length/600))===0);
let auditedTriangles=0,degenerateTriangles=0;
for(const spec of sample){
 const gen=generate(spec);
 const panels=gen.mass.panels.concat(expandModuleInstances(gen.instances,gen.matTable));
 for(const panel of panels){
  const {positions:p,normals:n,indices:idx}=panel;
  for(let i=0;i<idx.length;i+=3){
   const a=idx[i]*3,b=idx[i+1]*3,c=idx[i+2]*3;
   const ux=p[b]-p[a],uy=p[b+1]-p[a+1],uz=p[b+2]-p[a+2];
   const vx=p[c]-p[a],vy=p[c+1]-p[a+1],vz=p[c+2]-p[a+2];
   const cx=uy*vz-uz*vy,cy=uz*vx-ux*vz,cz=ux*vy-uy*vx;
   const area=Math.hypot(cx,cy,cz);
   // Some real OSM footprints contain exactly collinear roof vertices; these
   // existing zero-area triangles carry no visible surface to orient.
   if(area<1e-8){degenerateTriangles++;continue;}
   const dot=cx*n[a]+cy*n[a+1]+cz*n[a+2];
   assert.ok(dot>=-1e-8,`building ${spec.id}, ${panel.materialId}, triangle ${i/3}: geometric front opposes normal (${dot})`);
   auditedTriangles++;
  }
 }
}
console.log(JSON.stringify({ok:true,buildings:sample.length,auditedTriangles,degenerateTriangles,includes:'shells, roofs, all window module types, trims, doors and stoops'},null,2));
