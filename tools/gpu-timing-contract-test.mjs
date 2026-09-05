import assert from 'node:assert/strict';
import {createGpuFrameTiming} from '../src/render/gpuFrameTiming.ts';
const realPerformance=globalThis.performance;
let now=0,queries=[];
Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>now}});
try {
 const backend={trackTimestamp:false,initTimestampQuery(_type,_uid,descriptor){if(this.trackTimestamp)descriptor.timestampWrites={}}};
 const original=backend.initTimestampQuery;
 const renderer={backend,hasFeature:()=>true,resolveTimestampsAsync:async type=>{queries.push(type);return type==='render'?8:1}};
 const timing=createGpuFrameTiming(renderer);
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 // No render occurred: r185 would return a cached GPU cost if asked.
 now=6000;timing.begin();timing.end();await settle();
 assert.deepEqual(queries,[]);assert.equal(timing.totalMs,undefined);
 // A real beauty pass and compute dispatch supply fresh measurements.
 now=9000;timing.begin();const descriptor={};
 backend.initTimestampQuery('render',1,descriptor);backend.initTimestampQuery('compute',2,{});
 timing.end();await settle();assert.equal(timing.totalMs,9);assert.equal(timing.stats.sampledAt,9000);
 // Reused descriptors lose stale timestamp writes outside the sampled frame.
 backend.initTimestampQuery('render',3,descriptor);assert.equal(descriptor.timestampWrites,undefined);
 now=12000;timing.begin();backend.initTimestampQuery('compute',4,{});timing.end();await settle();
 assert.deepEqual(queries,['render','compute','compute']);assert.equal(timing.stats.sampledAt,0,'compute-only hold invalidates cached render timing');
 assert.equal(timing.totalMs,undefined);
 now=16001;assert.equal(timing.totalMs,undefined,'old measurement expires');
 timing.dispose();assert.equal(backend.initTimestampQuery,original);assert.equal(backend.trackTimestamp,false);
 const unsupported=createGpuFrameTiming({...renderer,hasFeature:()=>false});now=30000;unsupported.begin();unsupported.end();assert.equal(backend.trackTimestamp,false);unsupported.dispose();
 console.log('PASS GPU timing: real-pass admission, compile-hold staleness, descriptor reset, expiration, unsupported adapter, disposal');
} finally {Object.defineProperty(globalThis,'performance',{configurable:true,value:realPerformance})}
