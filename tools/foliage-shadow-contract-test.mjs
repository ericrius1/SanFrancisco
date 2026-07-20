import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const source = (relativePath) => readFileSync(new URL(relativePath, root), "utf8");

assert.equal(
  existsSync(fileURLToPath(new URL("src/world/shadows/treeShadowProxy.ts", root))),
  false,
  "native-tree shadow proxy implementation returned"
);

const foliageRuntimeFiles = [
  "src/world/vegetation/nativeTreeMaterials.ts",
  "src/world/vegetation/authoredShrubs.ts",
  "src/world/wildlands/flowerRing.ts",
  "src/world/groundcover/bladeGrass.ts",
  "src/world/groundcover/gpuGrassPlacement.ts",
  "src/world/garden/gardenVegetation.ts"
];
const foliageRuntime = foliageRuntimeFiles.map(source).join("\n");

for (const seam of [
  ".castShadow",
  ".receiveShadow",
  ".shadowSide",
  "shadowProxyShape",
  "treeShadowProxy",
  "nativeTreeShadowMeshes",
  "disposeTreeShadowProxies"
]) {
  assert.equal(foliageRuntime.includes(seam), false, `foliage runtime reintroduced ${seam}`);
}

// nativeTreeForest carries one sanctioned exception: the opt-in
// `conventionalShadowCasting` path (beach-pianist grove god rays) forwards a
// `castShadow` flag that defaults to false. Everything beyond that flag
// assignment stays forbidden.
const nativeForest = source("src/world/nativeTreeForest/index.ts");
assert.equal(
  nativeForest.includes("castShadow = false"),
  true,
  "nativeTreeForest castShadow opt-in must default to false"
);
for (const seam of [
  ".receiveShadow",
  ".shadowSide",
  "shadowProxyShape",
  "treeShadowProxy",
  "nativeTreeShadowMeshes",
  "disposeTreeShadowProxies"
]) {
  assert.equal(nativeForest.includes(seam), false, `nativeTreeForest reintroduced ${seam}`);
}
const nativeForestOutsideOptIn = nativeForest.replaceAll(".castShadow = castShadow;", "");
assert.equal(
  nativeForestOutsideOptIn.includes(".castShadow"),
  false,
  "nativeTreeForest set .castShadow outside the opt-in flag assignment"
);

const compiler = [
  "src/world/treeCompiler/types.ts",
  "src/world/treeCompiler/compiler.ts",
  "src/world/treeCompiler/validate.ts",
  "src/world/nativeTreeForest/nativeGeometry.ts",
  "src/world/vegetation/nativeTreeRecipes.ts"
].map(source).join("\n");
for (const seam of ["TreeShadowRecipe", "CompiledTreeShadowProfile", "recipe.shadow", "compiled.shadow", "shadow:"]) {
  assert.equal(compiler.includes(seam), false, `tree compiler reintroduced ${seam}`);
}

const siteStreamer = source("src/world/vegetation/siteFoliage.ts");
assert.equal(
  siteStreamer.includes("onResidencyChanged"),
  false,
  "foliage residency reintroduced static-shadow invalidation"
);

const dryLandscape = source("src/world/japaneseTeaGarden/dryLandscape.ts");
const fallenLeaves = dryLandscape.slice(
  dryLandscape.indexOf("function createLeafScatter"),
  dryLandscape.indexOf("export function createDryLandscape")
);
assert.equal(/\.(?:castShadow|receiveShadow)\b/.test(fallenLeaves), false, "fallen leaves rejoined shadow rendering");

console.log("foliage-shadow contract: ok");
