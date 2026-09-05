// Exercise real service ownership with a manually completed decoder: replacement
// while two jobs run and two wait must drain safely without texture resurrection.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
await mkdir('.data/world-upgrade', {recursive:true});
const output='.data/world-upgrade/texture-decoder-contract.mjs';
await build({entryPoints:['src/render/textures.ts'],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{
 name:'controlled-decoder',setup(b){
  b.onResolve({filter:/KTX2Loader\.js$/},()=>({path:'decoder',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`
    export class KTX2Loader {
      constructor(){globalThis.fixture.loaders.push(this)}
      setTranscoderPath(){return this} detectSupport(){return this}
      setWorkerLimit(n){this.limit=n;return this}
      load(url,onLoad,_progress,onError){globalThis.fixture.started.push({url,onLoad,onError,loader:this})}
      loadAsync(url){return new Promise((resolve,reject)=>this.load(url,resolve,undefined,reject))}
      dispose(){this.disposed=(this.disposed||0)+1}
    }`,loader:'js'}));
 }
}]});
globalThis.fixture={loaders:[],started:[]};
const {initTextures,getKtx2Loader,loadKtx2Texture,textureDecoderStats,loadTexture}=await import(pathToFileURL(process.cwd()+'/'+output));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const texture=()=>({disposed:0,dispose(){this.disposed++}});
initTextures({});assert.equal(fixture.loaders.length,0,'registration must not load a decoder');
const loader=await getKtx2Loader();assert.equal(loader.limit,2);
const requests=['a','b','c','d'].map(url=>loadKtx2Texture(url).then(t=>({t}),error=>({error})));
await flush();assert.equal(fixture.started.length,2);assert.deepEqual(textureDecoderStats(),{active:2,queued:2,limit:2,services:1});
initTextures({});assert.equal(loader.disposed,undefined,'in-flight jobs retain old decoder');
const next=loadTexture('new').then(t=>({t}),error=>({error}));await flush();
assert.equal(fixture.loaders.length,2);assert.equal(textureDecoderStats().active,2,'replacement shares admission budget');
const stale=texture();fixture.started[0].onLoad(stale);await flush();
assert.equal(stale.disposed,1);assert.equal(fixture.started.filter(r=>r.url==='c'||r.url==='d').length,0,'retired queued jobs never start');
const stale2=texture();fixture.started[1].onLoad(stale2);await flush();
assert.equal(loader.disposed,1,'old worker is disposed exactly once after drain');
const current=fixture.started.find(r=>r.url==='new.ktx2');assert.ok(current);const value=texture();current.onLoad(value);
assert.ok((await Promise.all(requests)).every(r=>r.error));assert.equal((await next).t,value);assert.equal(value.disposed,0);
assert.deepEqual(textureDecoderStats(),{active:0,queued:0,limit:2,services:1});
// Multiple callers share the same renderer-scoped decoder and its failure path
// releases admission for queued loads.
const shared=await getKtx2Loader();const jobs=['e','f','g'].map(u=>shared.loadAsync(u).catch(e=>e));await flush();
fixture.started.find(r=>r.url==='e').onError(new Error('decode failed'));await flush();
assert.ok(fixture.started.find(r=>r.url==='g'),'failed decode hands its slot to a waiter');
for(const url of ['f','g'])fixture.started.find(r=>r.url===url).onLoad(texture());
await Promise.all(jobs);assert.equal(textureDecoderStats().active,0);
console.log('PASS shared decoder: first-use import, global two-slot budget, queued cancellation, retirement, texture disposal, error handoff');
