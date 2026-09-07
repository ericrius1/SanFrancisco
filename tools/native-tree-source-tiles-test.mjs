import assert from 'node:assert/strict';
import { collectNativeTreeSourceTiles, NativeTreeStreamMotion } from '../src/world/nativeTreeForest/sourceTiles.ts';

const keys = (tiles) => tiles.map((tile) => tile.key);
assert.ok(keys(collectNativeTreeSourceTiles(-0.1, -0.1, 10, 0)).includes('-1,-1'), 'negative coordinates use floor grid cells');
assert.ok(keys(collectNativeTreeSourceTiles(10, 5, 10, 0)).includes('0,0'), 'a point on a tile edge retains tangent tile');
assert.ok(keys(collectNativeTreeSourceTiles(0, 0, 10, 5)).includes('0,0'), 'circle intersection includes tangent geometry');
assert.ok(!keys(collectNativeTreeSourceTiles(0, 0, 10, 1)).includes('100000,0'), 'query remains local to the requested radius');
assert.throws(() => collectNativeTreeSourceTiles(0, 0, 0, 1), RangeError);
assert.throws(() => collectNativeTreeSourceTiles(0, 0, 10, -1), RangeError);

const motion = new NativeTreeStreamMotion();
assert.deepEqual(motion.update(0, 0, 1000), { x: 0, z: 0 }, 'initial focus is actual position');
assert.deepEqual(motion.update(10, 0, 1100), { x: 210, z: 0 }, 'projection is two seconds ahead');
assert.deepEqual(motion.update(10, 10, 1200), { x: 10, z: 210 }, 'abrupt turn follows latest movement');
assert.deepEqual(motion.update(1000, 10, 1300), { x: 1000, z: 10 }, 'teleport resets prediction');
assert.deepEqual(motion.update(1001, 10, 1400), { x: 1021, z: 10 }, 'motion resumes from reset baseline');
assert.deepEqual(motion.update(1001, 10, 1500), { x: 1001, z: 10 }, 'stationary motion has no forward offset');
assert.deepEqual(motion.update(1001, 10, 4000), { x: 1001, z: 10 }, 'long gaps do not project');
motion.reset();
assert.deepEqual(motion.update(-5, -5, 1), { x: -5, z: -5 }, 'reset returns to actual focus');
console.log('PASS native tree source tiles: grid bounds, tangent coverage, local queries, and bounded motion');
