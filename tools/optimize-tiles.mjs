// Compresses baked GLB tiles in place: quantization (KHR_mesh_quantization) +
// meshopt (EXT_meshopt_compression). Run after `bc.export_all()` in Blender.
// Idempotent — already-compressed files are skipped, so partial rebakes only
// pay for the tiles Blender actually re-exported.
//
//   node tools/optimize-tiles.mjs [dir...] [--force]
//
// Defaults to public/tiles. Runtime requires GLTFLoader.setMeshoptDecoder().
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { meshopt, reorder } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const dirs = args.filter((a) => !a.startsWith("--"));
if (dirs.length === 0) dirs.push("public/tiles");

// landmarks.glb keeps float32 positions: the Salesforce crown material reads
// geometry.boundingBox in world meters, which quantization would rescale
const SKIP_QUANTIZE = new Set(["landmarks.glb"]);

// positions: 16 bits over an 800m tile ≈ 1.2cm grid. The z-fight lifts on
// draped roads/parks are larger than that; the default 14 bits (~5cm) is not.
const QUANTIZE_POSITION_BITS = 16;

function vertexCount(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      n += prim.getAttribute("POSITION")?.getCount() ?? 0;
    }
  }
  return n;
}

function isCompressed(buffer) {
  // GLB: 12-byte header, then JSON chunk (length u32, type u32 = 'JSON')
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67) return false;
  const jsonLen = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLen).toString("utf8"));
  return (json.extensionsUsed ?? []).includes("EXT_meshopt_compression");
}

async function main() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({
      "meshopt.encoder": MeshoptEncoder,
      "meshopt.decoder": MeshoptDecoder
    });

  let files = [];
  for (const dir of dirs) {
    const abs = path.resolve(ROOT, dir);
    const names = await fs.readdir(abs);
    files.push(...names.filter((n) => n.endsWith(".glb")).map((n) => path.join(abs, n)));
  }
  files.sort();

  let inTotal = 0;
  let outTotal = 0;
  let skipped = 0;
  for (const file of files) {
    const name = path.basename(file);
    const input = await fs.readFile(file);
    if (!force && isCompressed(input)) {
      skipped++;
      continue;
    }

    const doc = await io.readBinary(input);
    const vertsBefore = vertexCount(doc);
    if (SKIP_QUANTIZE.has(name)) {
      await doc.transform(reorder({ encoder: MeshoptEncoder, target: "size" }));
      doc
        .createExtension(EXTMeshoptCompression)
        .setRequired(true)
        .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
    } else {
      await doc.transform(
        meshopt({ encoder: MeshoptEncoder, level: "high", quantizePosition: QUANTIZE_POSITION_BITS })
      );
    }
    const output = await io.writeBinary(doc);

    // prove the bytes decode before replacing the original
    const check = await io.readBinary(output);
    const vertsAfter = vertexCount(check);
    if (vertsAfter !== vertsBefore) {
      throw new Error(`${name}: vertex count changed ${vertsBefore} -> ${vertsAfter}, aborting`);
    }
    await fs.writeFile(file, output);

    inTotal += input.length;
    outTotal += output.length;
    console.log(
      `${name}: ${(input.length / 1e6).toFixed(2)}MB -> ${(output.length / 1e6).toFixed(2)}MB`
    );
  }
  const mb = (n) => (n / 1e6).toFixed(1);
  console.log(
    `done: ${files.length - skipped} compressed (${mb(inTotal)}MB -> ${mb(outTotal)}MB), ${skipped} already compressed`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
