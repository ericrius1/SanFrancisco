import fs from 'node:fs';
import assert from 'node:assert/strict';
const manifest=JSON.parse(fs.readFileSync('dist/.vite/manifest.json','utf8'));
const eager=new Set();
function visit(key){if(eager.has(key))return;eager.add(key);for(const next of manifest[key]?.imports??[])visit(next)}
for(const [key,value] of Object.entries(manifest))if(value.isEntry || (value.name === "main" && value.file.endsWith(".js")))visit(key);
const optional=[...['car','scooter','board','skate','plane','boat','drone','bird','surf'].map(mode=>`src/vehicles/${mode}/index.ts`),'src/fx/fireworksRuntime.ts','src/world/citySkyline.ts','src/world/volumetricClouds.ts','src/gameplay/tidalChoir/index.ts','src/gameplay/tidalChoir/vegetation.ts'];
const resolved=optional.map(source=>{
 // Rollup coalesces the bird barrel with its named exports and omits src on
 // that one manifest entry. Locate it by executable model identity.
 const key=manifest[source]?source:source==='src/vehicles/bird/index.ts'?Object.keys(manifest).find(k=>manifest[k].isDynamicEntry&&fs.readFileSync('dist/'+manifest[k].file,'utf8').includes('"phoenix_mount"')):null;
 assert.ok(key,`${source} must emit a chunk`);
 assert.ok(!eager.has(key),`${source} must not be in the entry's static import graph`);
 return {source,key,file:manifest[key].file};
});
fs.mkdirSync('.data/world-upgrade',{recursive:true});
fs.writeFileSync('.data/world-upgrade/lazy-chunks.json',JSON.stringify(resolved,null,2));
console.log('PASS production chunks outside walking boot:',resolved.map(r=>r.file).join(', '));
