import assert from 'node:assert/strict';
import { sampleCloudClimate } from '../src/world/cloudEvolution.ts';
const settings={evolving:true,cycleMinutes:12,variation:1,coverage:.56,density:1,scale:1,billow:.65,wisps:.35,thickness:420};
const frames=Array.from({length:721},(_,second)=>sampleCloudClimate(second,settings));
assert(Math.min(...frames.map(f=>f.coverage))<.1,'weather must include mostly clear sky');
assert(Math.max(...frames.map(f=>f.coverage))>.8,'weather must include substantial cloud cover');
assert(Math.max(...frames.map(f=>f.billow))-Math.min(...frames.map(f=>f.billow))>.6,'cloud shapes must evolve');
assert.deepEqual(frames[0],frames[720],'cycle must wrap seamlessly');
for(let i=1;i<frames.length;i++) {
  for(const n of Object.values(frames[i]))assert(Number.isFinite(n)&&n>=0);
  assert(Math.abs(frames[i].coverage-frames[i-1].coverage)<.008,'weather must shift gradually');
}
for(const override of [{evolving:false},{variation:0}]) {
  const manual={...settings,...override,coverage:.31,density:1.7};
  for(const time of [0,275,590,720]) {
    const f=sampleCloudClimate(time,manual);
    assert.equal(f.coverage,manual.coverage);assert.equal(f.density,manual.density);
  }
}
console.log('Cloud evolution: clear spells, variety, continuity, bounds and manual controls passed.');
