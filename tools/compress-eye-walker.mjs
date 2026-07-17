// One-shot: compress the Blender-merged eye-walker GLB (skinned mesh + walk/
// idle clips) for runtime — dedupe/prune, 16-bit quantize, meshopt — and drop
// it at public/models/eye-walker.glb. Usage:
//   node tools/compress-eye-walker.mjs [in.glb] [out.glb]
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { dedup, prune, quantize, reorder, simplify, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inPath = process.argv[2] ?? path.join(ROOT, ".data/tripo/eye-creature.glb");
const outPath = process.argv[3] ?? path.join(ROOT, "public/models/eye-walker.glb");
const simplifyRatio = Number(process.argv[4] ?? 0); // 0 = skip (already decimated upstream)

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(inPath);

let tris = 0;
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices();
    tris += (idx ? idx.getCount() : prim.getAttribute("POSITION").getCount()) / 3;
  }
}
console.log(`input tris: ${Math.round(tris).toLocaleString()}`);

// keep only the renamed NLA clips — the Blender export also carries the raw
// "Armature|preset:*" takes, and the runtime's /walk|idle/i lookup must not
// land on those
for (const anim of doc.getRoot().listAnimations()) {
  if (anim.getName() === "walk" || anim.getName() === "idle") continue;
  anim.dispose();
}

await doc.transform(
  dedup(),
  prune(),
  ...(simplifyRatio > 0
    ? [weld(), simplify({ simplifier: MeshoptSimplifier, ratio: simplifyRatio, error: 0.001 })]
    : []),
  reorder({ encoder: MeshoptEncoder }),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 })
);
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });

await io.write(outPath, doc);

const { statSync } = await import("node:fs");
console.log(
  `wrote ${outPath}: ${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB (from ${(statSync(inPath).size / 1024 / 1024).toFixed(1)} MB)`
);
const root = doc.getRoot();
const anims = root.listAnimations().map((a) => `${a.getName()} (${a.listChannels().length} ch)`);
let outTris = 0;
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices();
    outTris += (idx ? idx.getCount() : prim.getAttribute("POSITION").getCount()) / 3;
  }
}
console.log("animations:", anims);
console.log("skins:", root.listSkins().length, "| out tris:", Math.round(outTris).toLocaleString(), "| textures:", root.listTextures().map((t) => `${t.getMimeType()} ${t.getImage()?.byteLength}`));
if (root.listSkins().length < 1) {
  console.error("SKIN LOST — mesh will not animate");
  process.exit(1);
}
if (!root.listAnimations().some((a) => a.getName() === "walk") || !root.listAnimations().some((a) => a.getName() === "idle")) {
  console.error("MISSING walk/idle clip — check the Blender NLA export");
  process.exit(1);
}
