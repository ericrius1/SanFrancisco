// CityGen batched-shell visibility contract.
//
// Whole-building interior cutaway and the open-door leaf handoff are orthogonal:
// restoring a facade on exit must not put the baked closed leaf/back over a
// still-open dynamic door. This executes the real ShellBatchLayer against
// Three's BatchedMesh bookkeeping without starting a renderer.
//
// Run: node tools/citygen-door-visibility-contract-test.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three/webgpu";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".data", "contract-test-bundles");
const OUT = path.join(OUT_DIR, `citygen-door-visibility-${process.pid}.mjs`);
await mkdir(OUT_DIR, { recursive: true });

await build({
  entryPoints: [path.join(ROOT, "src/world/citygen/render/shellBatch.ts")],
  outfile: OUT,
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["three", "three/*"],
});

try {
  const { createShellBatchLayer } = await import(pathToFileURL(OUT).href);
  const scene = new THREE.Group();
  const layer = createShellBatchLayer(scene, { capacity: 8, vertsPerBuilding: 16 });
  const triangle = (materialId, x) => ({
    materialId,
    positions: new Float32Array([x, 0, 0, x + 0.2, 0, 0, x, 0.2, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  });
  const materials = {
    "citygen.doorleaf": new THREE.MeshStandardMaterial({ color: 0x553322 }),
    "citygen.doorback": new THREE.MeshStandardMaterial({ color: 0x111111 }),
  };
  const handle = layer.addBuilding([
    triangle("wall.victorian", 0),
    triangle("citygen.doorleaf", 1),
    triangle("citygen.doorback", 2),
  ], {
    matrix: new THREE.Matrix4(),
    wallKind: "clapboard",
    tint: new THREE.Color(0x886644),
    mats: materials,
  });
  assert.ok(handle, "synthetic building should fit the shell batch");

  const visible = (name) => {
    const mesh = scene.getObjectByName(`cityGenShellBatch.${name}`);
    assert.ok(mesh?.isBatchedMesh, `${name} batch should be attached`);
    return mesh.getVisibleAt(0);
  };
  const snapshot = () => ({
    wall: visible("wall:clapboard"),
    leaf: visible("citygen.doorleaf"),
    back: visible("citygen.doorback"),
  });
  let visibilityWrites = 0;
  scene.traverse((object) => {
    if (!object.isBatchedMesh) return;
    const setVisibleAt = object.setVisibleAt.bind(object);
    object.setVisibleAt = (...args) => {
      visibilityWrites++;
      return setVisibleAt(...args);
    };
  });

  assert.deepEqual(snapshot(), { wall: true, leaf: true, back: true }, "closed exterior starts intact");
  handle.setDoorLeavesVisible(false);
  assert.equal(visibilityWrites, 2, "outside opening should touch only the leaf and backing instances");
  assert.deepEqual(snapshot(), { wall: true, leaf: false, back: false }, "opening hides only the baked door pair");
  visibilityWrites = 0;
  handle.setDoorLeavesVisible(false);
  assert.equal(visibilityWrites, 0, "repeated door state should not dirty shared batches");
  handle.setShellHidden(true);
  assert.deepEqual(snapshot(), { wall: false, leaf: false, back: false }, "interior cutaway hides the facade");
  visibilityWrites = 0;
  handle.setShellHidden(true);
  assert.equal(visibilityWrites, 0, "repeated cutaway state should not dirty shared batches");
  handle.setShellHidden(false);
  assert.deepEqual(
    snapshot(),
    { wall: true, leaf: false, back: false },
    "exiting restores the facade without closing the open door",
  );
  handle.setDoorLeavesVisible(true);
  assert.deepEqual(snapshot(), { wall: true, leaf: true, back: true }, "closing restores the baked door pair");

  layer.dispose();
  for (const material of Object.values(materials)) material.dispose();
  console.log("citygen door visibility contract: ok");
} finally {
  await rm(OUT, { force: true });
}
