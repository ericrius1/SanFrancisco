// Shared canopy ownership and its actual optional-module boundary. No GPU/browser.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const graph = await build({
  absWorkingDir: root, entryPoints: ["src/world/wildlands/canopy.ts"],
  bundle: true, write: false, format: "esm", platform: "browser",
  packages: "external", metafile: true, logLevel: "silent",
});
const forbidden = Object.keys(graph.metafile.inputs).filter((name) =>
  /wildlands\/(?:index|flowerRing|grassField)\.ts|gameplay\/golf\/(?:index|game|course)\.ts|gameplay\/afterlight\//.test(name)
);
assert.deepEqual(forbidden, [], "canopy imports must not reach groundcover or gameplay");

const bundled = await build({
  absWorkingDir: root,
  stdin: {
    contents: `export { createWildlands } from './src/world/wildlands/index.ts';
      export { createWildlandsCanopy } from './src/world/wildlands/canopy.ts';`,
    resolveDir: root, loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
  plugins: [{
    name: "foliage-owners",
    setup(builder) {
      builder.onResolve({ filter: /^(\.\/layout|\.\/flowerRing|\.\/grassField|\.\.\/nativeTreeForest)$/ }, (args) => {
        if (!args.importer.includes(`${path.sep}wildlands${path.sep}`)) return;
        return { path: args.path, namespace: "test-foliage" };
      });
      builder.onLoad({ filter: /.*/, namespace: "test-foliage" }, (args) => {
        if (args.path === "./layout") return { contents: `export const WILD_TREE_DESIGNS = []; export const collectWildTrees = () => [{x:1,z:1}]; export { WILD_REGIONS, wildRegionAt } from ${JSON.stringify(path.join(root, "src/world/wildlands/regions.ts"))};`, resolveDir: root };
        if (args.path === "../nativeTreeForest") return { contents: `export const createNativeTreeForest = (...args) => globalThis.__canopyTest.forest(...args);` };
        const name = args.path === "./flowerRing" ? "createFlowerRing" : "createWildGrass";
        return { contents: `export const ${name} = () => globalThis.__canopyTest.field();` };
      });
    },
  }],
});
const owners = { forests: 0, fields: 0, disposedForests: 0, disposedFields: 0 };
const group = () => ({ visible: true, parent: null, traverse() {}, removeFromParent() {} });
globalThis.__canopyTest = {
  forest(_designs, slots, options) {
    owners.forests++;
    assert.equal(options.visibleDistance, 1050);
    assert.equal(options.impostorDistance, 420);
    let resolve;
    return {
      group: group(), ready: new Promise((r) => { resolve = r; }),
      stats: { instances: slots.length, chunks: 1 },
      update(focus) { this.lastFocus = { ...focus }; resolve(); },
      prepareAt(focus) { this.update(focus); return Promise.resolve(); },
      dispose() { owners.disposedForests++; },
    };
  },
  field() {
    owners.fields++;
    return { group: group(), stats: { count: 0 }, update() {}, refresh() {}, cullFrame() {},
      whenCriticalReady: () => Promise.resolve(), dispose() { owners.disposedFields++; } };
  },
};
const { createWildlandsCanopy, createWildlands } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const canopy = createWildlandsCanopy({});
assert.equal(owners.fields, 0, "distant approach must not construct grass or flowers");
canopy.update({ x: 10, z: 20 });
canopy.update({ x: 30, z: 40 });
await canopy.trees.ready;
canopy.update(canopy.focus, true);
assert.deepEqual(canopy.trees.lastFocus, { x: 30, z: 40 }, "ready must retain latest arrival/movement focus");
canopy.update({ x: 30, y: 250, z: 40 });
assert.equal(canopy.trees.lastFocus.y, 250, "canopy update must retain flight altitude");
await canopy.prepareAt({ x: 30, y: 20, z: 40 });
assert.equal(canopy.focus.y, 20, "arrival preparation must retain selected altitude");
const close = createWildlands({}, {}, canopy);
assert.equal(close.trees, canopy.trees, "close fields must borrow the exact distant forest");
assert.equal(owners.forests, 1);
assert.equal(owners.fields, 2);
close.update({ x: 50, z: 60 });
assert.deepEqual(canopy.focus, { x: 50, z: 60 });
close.dispose();
close.dispose();
assert.equal(owners.disposedFields, 2, "fields dispose exactly once");
assert.equal(owners.disposedForests, 0, "borrower must not destroy its canopy");
canopy.dispose();
canopy.dispose();
assert.equal(owners.disposedForests, 1, "canopy owns forest disposal exactly once");
const standalone = createWildlands({});
standalone.dispose();
assert.equal(owners.disposedForests, 2, "standalone use still owns and releases its forest");
delete globalThis.__canopyTest;
console.log(JSON.stringify({ ok: true, graphInputs: Object.keys(graph.metafile.inputs).length, owners }));
