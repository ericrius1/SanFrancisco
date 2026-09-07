import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, ".data", "native-tree-dense-slots-test.mjs");
await build({
  entryPoints: [path.join(root, "src/world/nativeTreeForest/denseSlots.ts")],
  outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent"
});
const { createDenseSlotAllocator } = await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`);

assert.throws(() => createDenseSlotAllocator(0), RangeError);
assert.throws(() => createDenseSlotAllocator(2.5), RangeError);
const allocator = createDenseSlotAllocator(24);
assert.throws(() => allocator.allocate(-1), RangeError);
assert.throws(() => allocator.allocate(1.5), RangeError);
assert.equal(allocator.allocate(25), null, "valid over-capacity requests decline admission");
const records = new Array(24).fill(null);
const allocations = [];
let serial = 0;

function check() {
  assert.equal(allocator.used, allocations.reduce((sum, allocation) => sum + allocation.token.indices.length, 0));
  assert.equal(allocator.remaining, 24 - allocator.used);
  const occupied = new Set();
  for (const allocation of allocations) {
    for (let local = 0; local < allocation.token.indices.length; local++) {
      const slot = allocation.token.indices[local];
      assert.equal(slot < allocator.used, true, "live slots stay in dense prefix");
      assert.equal(occupied.has(slot), false, "live allocations do not overlap");
      occupied.add(slot);
      assert.equal(records[slot], allocation.payload[local], "moved payload follows its token");
    }
  }
  assert.equal(occupied.size, allocator.used);
  for (let slot = 0; slot < allocator.used; slot++) assert.equal(occupied.has(slot), true, "dense prefix has no holes");
}

function allocate(count) {
  const token = allocator.allocate(count);
  const payload = Array.from({ length: count }, () => `payload-${serial++}`);
  for (let local = 0; local < count; local++) records[token.indices[local]] = payload[local];
  allocations.push({ token, payload });
}

// Specifically exercises an allocation whose later slot is moved while its earlier slot is freed.
allocate(1);
allocate(2);
allocate(2);
const ownMove = allocations[2];
const ownMoveBefore = [...ownMove.token.indices];
const first = allocations.shift();
assert.equal(allocator.release(first.token, (from, to) => { records[to] = records[from]; }), true);
assert.equal(allocator.release(ownMove.token, (from, to) => { records[to] = records[from]; }), true);
allocations.splice(1, 1);
assert.equal(ownMoveBefore[1] !== ownMove.token.indices[1], true, "released token's own move was handled before invalidation");
check();

let state = 0x5eed1234;
for (let step = 0; step < 1200; step++) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  const totalFree = allocator.remaining;
  if (allocations.length === 0 || (totalFree > 0 && (state & 1) === 0)) {
    const count = Math.min(totalFree, 1 + (state % 4));
    allocate(count);
  } else {
    const index = state % allocations.length;
    const [allocation] = allocations.splice(index, 1);
    assert.equal(allocator.release(allocation.token, (from, to) => { records[to] = records[from]; }), true);
    assert.equal(allocator.release(allocation.token), false, "release is idempotent");
  }
  check();
}

while (allocations.length) {
  const allocation = allocations.pop();
  assert.equal(allocator.release(allocation.token, (from, to) => { records[to] = records[from]; }), true);
}
assert.equal(allocator.used, 0);
allocate(24);
assert.equal(allocator.used, 24, "freed capacity is reusable");
console.log("PASS native tree dense slots: deterministic churn, compaction payload moves, stale releases, capacity reuse");
