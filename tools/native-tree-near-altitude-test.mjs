// node --experimental-strip-types tools/native-tree-near-altitude-test.mjs
import assert from "node:assert/strict";
import { nativeTreeNearDistanceSquared, nativeTreeNearFocusMovementSquared } from "../src/world/nativeTreeForest/nearDistance.ts";
import { copyTreeCullFocus, tetherTreeCullFocus } from "../src/world/vegetation/treeCullFocus.ts";

const tree = { x: 0, y: 40, z: 0, scale: 2 };
const bounds = { min: [-8, -2, -8], max: [8, 30, 8] };
// The tree spans world y=36..100. Preserve ground proximity, including trunks;
// a canopy-level camera also stays close even though the planted root is lower.
assert.equal(nativeTreeNearDistanceSquared({ x: 30, y: 42, z: 40 }, tree, bounds), 2500);
assert.equal(nativeTreeNearDistanceSquared({ x: 0, y: 100, z: 0 }, tree, bounds), 0);
assert.equal(nativeTreeNearDistanceSquared({ x: 0, y: 250, z: 0 }, tree, bounds), 150 ** 2);
assert.equal(nativeTreeNearDistanceSquared({ x: 0, y: 26, z: 0 }, tree, bounds), 10 ** 2);
assert.equal(nativeTreeNearDistanceSquared({ x: 30, z: 40 }, tree, bounds), 2500, "unknown height preserves XZ behavior");
assert.equal(nativeTreeNearDistanceSquared({ x: 30, y: NaN, z: 40 }, tree, bounds), 2500);
// Apply the runtime's existing 96/110m entry/exit radii to a vertical approach.
const admits = (height, active = false) => nativeTreeNearDistanceSquared({ x: 0, y: height, z: 0 }, tree, bounds) < (active ? 110 : 96) ** 2;
assert.equal(admits(250), false);
assert.equal(admits(250, true), false);
assert.equal(admits(195), true);
assert.equal(admits(200), false);
assert.equal(admits(200, true), true);
assert.equal(nativeTreeNearFocusMovementSquared({ x: 0, y: 100, z: 0 }, { x: 0, y: 250, z: 0 }), 150 ** 2);
assert.equal(nativeTreeNearFocusMovementSquared({ x: 0, z: 0 }, { x: 0, y: 250, z: 0 }), Infinity);
const player = { x: 0, y: 2, z: 0 };
assert.equal(tetherTreeCullFocus(player, { x: 12, y: 6, z: 0 }), player, "ordinary chase boom must not recenter tree detail");
const detached = tetherTreeCullFocus(player, { x: 0, y: 252, z: 0 });
assert.deepEqual(detached, { x: 0, y: 196, z: 0 }, "vertical flyover must carry camera height through the tether");
assert.deepEqual(copyTreeCullFocus(detached), detached, "async bootstrap snapshots must retain height");
assert.deepEqual(copyTreeCullFocus({ x: 0, z: 0 }), { x: 0, z: 0 });
console.log(JSON.stringify({ ok: true, contracts: ["ground/crown proximity", "high flight rejects near", "entry/exit hysteresis", "vertical-only rebin", "unknown-Y compatibility", "camera tether and async focus"] }));
