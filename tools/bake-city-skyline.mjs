// Far-city silhouettes from the SAME baked buildings. No fabricated boxes,
// foliage, roads, collision or textures. Run after any source tile rebake.
import fs from 'node:fs/promises';
import { Document, NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compactPrimitive, dequantize, mergeDocuments, meshopt, prune, unpartition, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { recordBake } from './asset-ledger.mjs';
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder,'meshopt.encoder':MeshoptEncoder});
const output = new Document().setLogger(new Logger(Logger.Verbosity.WARN));
const scene = output.createScene('city-skyline');
output.getRoot().setDefaultScene(scene);
const files = (await fs.readdir('public/tiles')).filter(n=>/^tile_.*\.glb$/.test(n)).sort();
let before=0,after=0,tiles=0;
for (const name of files) {
  const doc=await io.read('public/tiles/'+name);
  doc.setLogger(new Logger(Logger.Verbosity.SILENT));
  for(const node of doc.getRoot().listNodes()) if(!node.getName().startsWith('bld_')) node.dispose();
  await doc.transform(prune(),dequantize());
  if(!doc.getRoot().listMeshes().length)continue;
  for(const mesh of doc.getRoot().listMeshes())for(const p of mesh.listPrimitives()) {
    before+=(p.getIndices()?.getCount()??0)/3;
    for(const sem of p.listSemantics()) if(sem!=='POSITION'&&sem!=='COLOR_0')p.setAttribute(sem,null);
    p.setMaterial(null);
  }
  // <= 0.4% relative geometric error; retain real roof outlines and colours.
  await doc.transform(weld());
  for(const mesh of doc.getRoot().listMeshes())for(const p of mesh.listPrimitives()) {
    const pos=p.getAttribute('POSITION'), color=p.getAttribute('COLOR_0');
    const weights=Array(color?.getElementSize()??3).fill(0.02);
    const colors=new Float32Array(pos.getCount()*weights.length), sample=[];
    if(color)for(let i=0;i<color.getCount();i++){color.getElement(i,sample);colors.set(sample,i*weights.length);}
    const [indices]=MeshoptSimplifier.simplifyWithAttributes(
      Uint32Array.from(p.getIndices().getArray()),Float32Array.from(pos.getArray()),3,
      colors,weights.length,weights,null,Math.floor(p.getIndices().getCount()*0.22/3)*3,0.004,['Permissive']);
    p.getIndices().setArray(indices);
    compactPrimitive(p);
  }
  await doc.transform(prune());
  for(const mesh of doc.getRoot().listMeshes())for(const p of mesh.listPrimitives())after+=(p.getIndices()?.getCount()??0)/3;
  const map=mergeDocuments(output,doc);
  for(const src of doc.getRoot().listScenes()) {
    const copied=map.get(src);
    for(const child of copied.listChildren())scene.addChild(child);
    copied.dispose();
  }
  tiles++;
}
await output.transform(unpartition(),prune(),meshopt({encoder:MeshoptEncoder,level:'medium',quantizePosition:16}));
await fs.mkdir('public/skyline',{recursive:true});
await io.write('public/skyline/city.glb',output);
const bytes=(await fs.stat('public/skyline/city.glb')).size;
await fs.writeFile('public/skyline/stats.json',JSON.stringify({tiles,before,after,bytes,error:0.004,ratio:0.22},null,2)+'\n');
recordBake({id:'city-skyline',label:'Far city silhouettes',bake:'node tools/bake-city-skyline.mjs',tracked:true,inputs:['tools/bake-city-skyline.mjs',...files.map(n=>'public/tiles/'+n)],outputs:['public/skyline/city.glb','public/skyline/stats.json']});
console.log(JSON.stringify({tiles,before,after,bytes}));
