import assert from 'node:assert/strict';
import { NativeTreeResidencyIndex } from '../src/world/nativeTreeForest/residencyIndex.ts';

const chunkSize = 100;
const descriptors = [
  { key: '-2,-1', cx: -151, cz: -65, horizontalRadius: 12 },
  { key: '-1,0', cx: -2, cz: 45, horizontalRadius: 4 },
  { key: '0,0', cx: 50, cz: 50, horizontalRadius: 0 },
  { key: '1,0', cx: 150, cz: 50, horizontalRadius: 20 },
  { key: '2,0', cx: 420, cz: 50, horizontalRadius: 260 }, // center well beyond its source cell
  { key: '0,2', cx: 50, cz: 250, horizontalRadius: 25 },
];
const index = new NativeTreeResidencyIndex(chunkSize);
for (const descriptor of descriptors) index.add(descriptor);

function reference(x, z, distance) {
  return descriptors.map((descriptor, order) => ({
    descriptor,
    order,
    distance: Math.max(0, Math.hypot(descriptor.cx - x, descriptor.cz - z) - descriptor.horizontalRadius),
  })).filter((entry) => entry.distance < distance)
    .sort((a, b) => a.distance - b.distance || a.order - b.order)
    .map(({ descriptor, distance: edgeDistance }) => ({ descriptor, distance: edgeDistance }));
}

for (const [x, z, distance] of [[0, 0, 100], [-125, -40, 90], [200, 50, 30], [100, 50, 100]]) {
  const actual = index.collect(x, z, distance);
  assert.deepEqual(actual.candidates, reference(x, z, distance), `reference equivalence at ${x},${z}`);
}
assert.ok(index.collect(200, 50, 30).candidates.some(({ descriptor }) => descriptor.key === '2,0'), 'huge crown offset remains discoverable');

const sparse = new NativeTreeResidencyIndex(chunkSize);
for (let z = 0; z < 100; z++) for (let x = 1000; x < 1200; x++) {
  sparse.add({ key: `${x},${z}`, cx: x * chunkSize + 50, cz: z * chunkSize + 50, horizontalRadius: 2 });
}
const result = sparse.collect(0, 0, 120);
assert.equal(result.candidates.length, 0);
assert.ok(result.examined === 0 && result.lookups < 100, `local query probed ${result.lookups} cells, not 20k descriptors`);
sparse.clear();
sparse.add({ key: '-1,-1', cx: -50, cz: -50, horizontalRadius: 0 });
const reused = sparse.collect(-50, -50, 1);
assert.deepEqual(reused.candidates.map(({ descriptor }) => descriptor.key), ['-1,-1']);
assert.ok(reused.lookups < 100, 'clear resets far-descriptor bounds before reuse');
console.log('PASS native tree residency sparse index: reference equivalence, negative keys, offset crowns, bounded lookups');
