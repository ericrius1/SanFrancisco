// Applies lossless meshopt compression to the two shipping phoenix GLBs.
// Runtime must call GLTFLoader.setMeshoptDecoder() after the lazy phoenix gate.
import fs from "node:fs/promises";
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
import { reorder } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  path.join(root, "public/models/phoenix-hero.glb"),
  path.join(root, "public/models/phoenix-hero-lod1.glb")
];

function stats(document) {
  let vertices = 0;
  let triangles = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      vertices += primitive.getAttribute("POSITION")?.getCount() ?? 0;
      triangles += (primitive.getIndices()?.getCount() ?? 0) / 3;
    }
  }
  return { vertices, triangles };
}

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions([
    EXTMeshoptCompression,
    EXTTextureWebP,
    KHRMaterialsClearcoat,
    KHRMaterialsEmissiveStrength,
    KHRMaterialsSheen
  ])
  .registerDependencies({
    "meshopt.encoder": MeshoptEncoder,
    "meshopt.decoder": MeshoptDecoder
  });

for (const file of files) {
  const input = await fs.readFile(file);
  const document = await io.readBinary(input);
  const before = stats(document);
  await document.transform(reorder({ encoder: MeshoptEncoder, target: "size" }));
  document
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const output = await io.writeBinary(document);
  const check = await io.readBinary(output);
  const after = stats(check);
  if (before.vertices !== after.vertices || before.triangles !== after.triangles) {
    throw new Error(`${path.basename(file)} geometry changed during compression`);
  }
  await fs.writeFile(file, output);
  console.log(`${path.basename(file)}: ${(input.length / 1e6).toFixed(2)}MB -> ${(output.length / 1e6).toFixed(2)}MB`);
}
