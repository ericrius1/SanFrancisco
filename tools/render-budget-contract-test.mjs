import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

await mkdir(".data/world-upgrade", { recursive: true });
const bundlePath = ".data/world-upgrade/render-budget-contract.mjs";
await build({
  stdin: {
    contents: `
      export { warmScenePaced, warmRootPaced } from "./src/render/warmStaticRegion.ts";
      export { createAdaptiveResolution } from "./src/render/adaptiveResolution.ts";
      export { setTemporalResolveReporter } from "./src/render/pocketQuality.ts";
      export { RENDER_TUNING } from "./src/config.ts";
      export { TEMPORAL_TUNING } from "./src/render/post/temporal/tuning.ts";
    `,
    resolveDir: process.cwd()
  },
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external"
});

const {
  warmScenePaced,
  warmRootPaced,
  createAdaptiveResolution,
  setTemporalResolveReporter,
  RENDER_TUNING,
  TEMPORAL_TUNING
} = await import(pathToFileURL(`${process.cwd()}/${bundlePath}`));
const THREE = await import("three/webgpu");

function trafficLikeMaterial() {
  const material = new THREE.MeshBasicNodeMaterial();
  material.userData.requiredAttributes = ["position", "aCenter", "aId", "color", "aLit"];
  return material;
}

function warmFixture() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.name = "root";
  const hiddenAncestor = new THREE.Group();
  hiddenAncestor.name = "hiddenAncestor";
  hiddenAncestor.visible = false;
  const placeholder = new THREE.Mesh(new THREE.BufferGeometry(), trafficLikeMaterial());
  placeholder.name = "emptyTrafficPoolSlot";
  placeholder.visible = false;
  placeholder.frustumCulled = true;
  const valid = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  valid.name = "validDescendant";
  valid.visible = false;
  valid.frustumCulled = true;
  hiddenAncestor.add(placeholder, valid);
  root.add(hiddenAncestor);
  scene.add(root);
  return { scene, root, hiddenAncestor, placeholder, valid };
}

function visibleMeshNames(owner) {
  const names = [];
  owner.traverseVisible((object) => {
    if (object.isMesh) names.push(object.name);
  });
  return names;
}

for (const mode of ["scene", "root"]) {
  const fixture = warmFixture();
  const before = {
    root: fixture.root.visible,
    ancestor: fixture.hiddenAncestor.visible,
    placeholder: fixture.placeholder.visible,
    placeholderCull: fixture.placeholder.frustumCulled,
    valid: fixture.valid.visible,
    validCull: fixture.valid.frustumCulled
  };
  const compiles = [];
  const renderer = {
    compileAsync: async (owner) => compiles.push(visibleMeshNames(owner))
  };
  const camera = new THREE.PerspectiveCamera();
  const result = mode === "scene"
    ? await warmScenePaced(renderer, camera, fixture.scene, async () => {}, Infinity)
    : await warmRootPaced(renderer, camera, fixture.scene, fixture.root, async () => {}, Infinity);

  assert.equal(result.meshes, 2, `${mode}: census includes the pooled placeholder`);
  assert.equal(result.representatives, 1, `${mode}: empty geometry is not a representative`);
  assert.ok(compiles.length > 0, `${mode}: valid descendant is warmed`);
  assert.ok(compiles.flat().includes("validDescendant"), `${mode}: valid descendant enters compile`);
  assert.ok(!compiles.flat().includes("emptyTrafficPoolSlot"), `${mode}: empty pool slot never enters compile`);
  assert.deepEqual({
    root: fixture.root.visible,
    ancestor: fixture.hiddenAncestor.visible,
    placeholder: fixture.placeholder.visible,
    placeholderCull: fixture.placeholder.frustumCulled,
    valid: fixture.valid.visible,
    validCull: fixture.valid.frustumCulled
  }, before, `${mode}: mesh and ancestor visibility/culling are restored`);

  fixture.valid.geometry.dispose();
  fixture.valid.material.dispose();
  fixture.placeholder.material.dispose();
}

{
  const scene = new THREE.Scene();
  const selected = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  selected.name = "selectedThenEmptied";
  scene.add(selected);
  const originalGeometry = selected.geometry;
  const emptyGeometry = new THREE.BufferGeometry();
  const compiles = [];
  let mutated = false;
  const renderer = {
    compileAsync: async (owner) => compiles.push(visibleMeshNames(owner))
  };
  const pace = async () => {
    if (mutated) return;
    mutated = true;
    selected.geometry = emptyGeometry;
  };
  const result = await warmScenePaced(
    renderer,
    new THREE.PerspectiveCamera(),
    scene,
    pace,
    -1
  );
  assert.equal(result.representatives, 1, "pre-pace census selected the originally drawable mesh");
  assert.equal(mutated, true, "pace boundary mutates the selected representative before compile");
  assert.equal(compiles.length, 0, "representative that becomes empty is not compiled");
  originalGeometry.dispose();
  emptyGeometry.dispose();
  selected.material.dispose();
}

let pixelRatio = 1;
const pixelRatioWrites = [];
const fakeRenderer = {
  getPixelRatio: () => pixelRatio,
  setPixelRatio: (value) => { pixelRatio = value; pixelRatioWrites.push(value); }
};
RENDER_TUNING.values.pixelRatio = 1;
RENDER_TUNING.values.profile = "quiet";
setTemporalResolveReporter(() => false);
const governor = createAdaptiveResolution(fakeRenderer);
governor.update(16, 4);
assert.equal(governor.scale, 0.9, "Quiet profile owns the non-temporal scale while enabled");
assert.equal(pixelRatio, 0.9);

governor.setEnabled(false);
assert.equal(governor.scale, 1, "disable neutralizes Quiet at L0");
assert.equal(pixelRatio, 1);
RENDER_TUNING.values.pixelRatio = 1.2;
governor.update(16, 4);
assert.equal(pixelRatio, 1.2, "disabled governor follows the one tuned pixel-ratio owner");

governor.setEnabled(true);
governor.update(16, 4);
assert.equal(pixelRatio, 1.08, "re-enable reapplies Quiet to the live tuned ceiling");
RENDER_TUNING.values.profile = "balanced";
governor.update(16, 4);
assert.equal(pixelRatio, 1.2, "live profile switch reapplies through the same owner");

RENDER_TUNING.values.profile = "quiet";
TEMPORAL_TUNING.values.mode = "taau";
setTemporalResolveReporter(() => true);
governor.update(16, 4);
assert.equal(governor.scale, 1, "temporal path keeps the drawing buffer at its ceiling");
assert.ok(governor.governorEffects().temporalScale < 1, "Quiet moves to the temporal scale axis");
assert.equal(pixelRatio, 1.2);
governor.setEnabled(false);
assert.equal(governor.governorEffects().temporalScale, 1, "disable neutralizes the temporal axis too");
assert.equal(pixelRatio, 1.2);
assert.ok(pixelRatioWrites.every(Number.isFinite), "all drawing-buffer writes are finite");
setTemporalResolveReporter(null);

console.log("PASS: warmScenePaced/warmRootPaced skip empty traffic-like pool geometry and restore visibility");
console.log("PASS: warmScenePaced revalidates representatives mutated to empty across a pace boundary");
console.log("PASS: Quiet scale is neutral while disabled and reapplies through one drawing-buffer owner");
