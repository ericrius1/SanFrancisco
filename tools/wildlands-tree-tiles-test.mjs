import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, ".data", "wildlands-tree-tiles-test.mjs");
await build({
  entryPoints: [path.join(root, "src/world/wildlands/layout.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent"
});
const { collectWildTrees } = await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`);

// Deliberately varied terrain exercises every map gate without making tile
// results depend on an unrealistically uniform mock surface.
const map = {
  groundHeight(x, z) {
    return 18 + Math.sin(x * 0.009) * 3 + Math.cos(z * 0.013) * 2 + (x < -2700 && z < -5000 ? 6 : 0);
  },
  surfaceType(x, z) {
    if (Math.abs(x + 3290) < 18 || Math.abs(z + 1130) < 12) return 4; // road ribbons
    if (x > -2600 && x < -2300 && z > 2210 && z < 2730) return 3; // garden-owned surface
    // Presidio and Marin accept class 0; the other regions reject these bands.
    if ((x < -1800 && z < 100) || (x < -3500 && z < -5000)) return 0;
    return 1;
  },
  isWater(x, z) {
    return (x + 5100) ** 2 + (z - 2050) ** 2 < 80 ** 2 || (x < -6100 && z < -6800);
  }
};
const excluded = (x, z) => (x + 4050) ** 2 + (z - 2400) ** 2 < 58 ** 2 || (x > -1350 && x < -1280 && z > 2150 && z < 2290);
const whole = collectWildTrees(map, excluded);
assert.ok(whole.length > 100, "mock terrain should retain a meaningful wildlands population");

const inBounds = (tree, bounds) =>
  tree.x >= bounds.minX && tree.x < bounds.maxX && tree.z >= bounds.minZ && tree.z < bounds.maxZ;
const signature = (tree) => JSON.stringify(tree);
const sortByPlacement = (trees) => trees.map(signature).sort();

// This partition covers every wildlands region. Its interior seams are negative
// coordinates and deliberately run through groves, matrix cells, and the
// Goldman ownership area.
const xs = [-7000, -3500, 0, 1000];
const zs = [-8500, -3000, 1000, 5000];
const tiled = [];
for (let xi = 0; xi + 1 < xs.length; xi++) {
  for (let zi = 0; zi + 1 < zs.length; zi++) {
    const bounds = { minX: xs[xi], maxX: xs[xi + 1], minZ: zs[zi], maxZ: zs[zi + 1] };
    const tile = collectWildTrees(map, excluded, undefined, bounds);
    // The tile's internal sequence remains the sequence it had in the original
    // whole collector, including generic-before-Goldman ordering.
    assert.deepEqual(tile, whole.filter((tree) => inBounds(tree, bounds)), `tile preserves whole order: ${JSON.stringify(bounds)}`);
    tiled.push(...tile);
  }
}
assert.deepEqual(sortByPlacement(tiled), sortByPlacement(whole), "half-open tiles reconstruct the whole collector without gaps or duplicates");

// Exact seams check half-open ownership on a negative coordinate and prove a
// small tile does not need to scan the full world to retain its dedup halo.
for (const bounds of [
  { minX: -3500, maxX: -3000, minZ: -3000, maxZ: -2000 },
  { minX: -1500, maxX: -1000, minZ: 2000, maxZ: 2500 },
  { minX: -5300, maxX: -4900, minZ: -6500, maxZ: -6000 }
]) {
  assert.deepEqual(
    collectWildTrees(map, excluded, undefined, bounds),
    whole.filter((tree) => inBounds(tree, bounds)),
    `bounded collector matches at seam ${JSON.stringify(bounds)}`
  );
}

console.log(JSON.stringify({ ok: true, whole: whole.length, tiles: tiled.length }));
