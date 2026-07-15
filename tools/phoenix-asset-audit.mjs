import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import {
  EXTMeshoptCompression,
  EXTTextureWebP,
  KHRMaterialsClearcoat,
  KHRMaterialsEmissiveStrength,
  KHRMaterialsSheen
} from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedBones = [
  "root", "spine01", "chest", "neck01", "neck02", "head",
  "wing_arm_L", "wing_forearm_L", "wing_hand_L",
  "wing_arm_R", "wing_forearm_R", "wing_hand_R",
  "tail01", "tail02", "tail03", "tail04", "tail05"
];
const specs = [
  ["phoenix-hero.glb", 58000],
  ["phoenix-hero-lod1.glb", 23000]
];
const io = new NodeIO()
  .registerExtensions([
    EXTMeshoptCompression,
    EXTTextureWebP,
    KHRMaterialsClearcoat,
    KHRMaterialsEmissiveStrength,
    KHRMaterialsSheen
  ])
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

for (const [name, expectedTriangles] of specs) {
  const file = path.join(root, "public/models", name);
  const document = await io.read(file);
  const model = document.getRoot();
  const meshes = model.listMeshes();
  const skins = model.listSkins();
  const animations = model.listAnimations();
  assert(meshes.length === 1, `${name}: expected one mesh, found ${meshes.length}`);
  assert(meshes[0].listPrimitives().length === 1, `${name}: expected one primitive`);
  const primitive = meshes[0].listPrimitives()[0];
  const triangles = (primitive.getIndices()?.getCount() ?? 0) / 3;
  const semantics = primitive.listSemantics().sort();
  const nodeNames = new Set(model.listNodes().map((node) => node.getName()));
  const rigNode = model.listNodes().find((node) => node.getName() === "PhoenixRig");
  assert(triangles === expectedTriangles, `${name}: ${triangles} triangles, expected ${expectedTriangles}`);
  assert(skins.length === 1, `${name}: expected one skin, found ${skins.length}`);
  assert(rigNode, `${name}: missing PhoenixRig root node`);
  assert(rigNode.getTranslation().every((value) => Math.abs(value) < 1e-6), `${name}: rig is not origin-normalized`);
  assert(rigNode.getRotation().slice(0, 3).every((value) => Math.abs(value) < 1e-6), `${name}: rig has baked scene rotation`);
  assert(Math.abs(rigNode.getRotation()[3] - 1) < 1e-6, `${name}: rig root quaternion is not identity`);
  assert(animations.length === 0, `${name}: baked clips are not allowed`);
  assert(model.listMaterials().length === 1, `${name}: expected one material`);
  assert(semantics.includes("_PHX_FLUTTER"), `${name}: missing _PHX_FLUTTER`);
  assert(semantics.includes("_PHX_HEAT"), `${name}: missing _PHX_HEAT`);
  assert(semantics.includes("JOINTS_0") && semantics.includes("WEIGHTS_0"), `${name}: missing skin attributes`);
  assert(!semantics.includes("JOINTS_1"), `${name}: more than four skin influences exported`);
  for (const bone of expectedBones) assert(nodeNames.has(bone), `${name}: missing bone ${bone}`);
  const bytes = fs.statSync(file).size;
  console.log(JSON.stringify({
    file: name,
    bytes,
    vertices: primitive.getAttribute("POSITION").getCount(),
    triangles,
    materials: model.listMaterials().length,
    textures: model.listTextures().map((texture) => ({
      name: texture.getName(),
      mime: texture.getMimeType(),
      bytes: texture.getImage()?.byteLength ?? 0
    })),
    joints: skins[0].listJoints().length,
    animations: animations.length,
    semantics
  }));
}
