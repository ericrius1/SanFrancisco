// Behavior checks for continuous-motion admission and the actual worker graph.
// node --experimental-strip-types tools/citygen-streaming-test.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createBackgroundAdmission } from '../src/app/compose/backgroundAdmission.ts';

const worker = await build({
  entryPoints: ['src/world/citygen/stream/buildWorker.ts'], bundle: true,
  platform: 'browser', format: 'iife', minify: true, write: false, metafile: true,
  define: { 'import.meta.env.DEV': 'false' },
});
const forbidden = Object.keys(worker.metafile.inputs).filter(path =>
  path.includes('node_modules/three/') || /citygen\/(render|stream\/ring)/.test(path));
assert.deepEqual(forbidden, [], 'building worker must contain only pure generation dependencies');

const originalFrame = globalThis.requestAnimationFrame;
const frames = [];
globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
let arrival = false, settled = true, current = true;
const admission = createBackgroundAdmission({
  input: { holding: () => true, mapPadAxes: () => ({lx:0,ly:0,lt:0,rt:0}) },
  player: { position: {x:0,z:0} },
  isArrivalActive: () => arrival,
});
admission.setRevealLifecycle({fabricHeld:()=>!settled,settled:()=>settled});
const frame = async () => { const callbacks=frames.splice(0); for(const f of callbacks)f(performance.now());await Promise.resolve(); };
try {
  let done=false;
  const moving = admission.waitForCityGenRenderWindow().then(result=>{done=result;});
  assert.equal(done,false,'even moving scenery work must yield a presentation frame');
  admission.noteMotion();
  await frame();
  assert.equal(done,true,'continuous movement cannot starve CityGen ahead of its bounded renderer gate');
  await moving;

  arrival=true;settled=false;done=false;
  const blocked=admission.waitForCityGenRenderWindow(()=>current).then(result=>{done=result;});
  await frame();await frame();
  assert.equal(done,false,'arrival/reveal remains a hard blocker');
  current=false;
  await frame();await blocked;
  assert.equal(done,false,'obsolete ownership must cancel while the arrival is active');

  arrival=false;settled=true;current=true;
  const cancelled=admission.waitForCityGenRenderWindow(()=>current);
  current=false;await frame();
  assert.equal(await cancelled,false,'recheck cancellation after yielding');
} finally { globalThis.requestAnimationFrame=originalFrame; }
console.log(JSON.stringify({ok:true,workerBytes:worker.outputFiles[0].contents.length,threeInputs:forbidden.length,continuousMotion:true,arrivalAndCancellation:true}));
