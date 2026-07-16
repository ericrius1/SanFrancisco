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
import { meshopt, prune, reorder, unweld, weld } from "@gltf-transform/functions";
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

function triangleCount(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      n += (indices ? indices.getCount() : (prim.getAttribute("POSITION")?.getCount() ?? 0)) / 3;
    }
  }
  return n;
}

// Ground drapes (park lawns, road ribbons) are lit from the terrain normal
// field at runtime (terrainClipmap.groundConformNormalBase; flat-shading
// derivative normals cover the gate fallback), so their baked flat-shaded
// normals are dead weight. Dropping NORMAL also lets weld() collapse the
// per-face-unwelded corners the flat bake produced (~3x vertex inflation).
const DRAPE_MESH = /^(grn_|road_)/;

function stripDrapeNormals(doc) {
  let stripped = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    if (!DRAPE_MESH.test(mesh.getName())) continue;
    for (const prim of mesh.listPrimitives()) {
      if (!prim.getAttribute("NORMAL")) continue;
      prim.setAttribute("NORMAL", null);
      stripped++;
    }
  }
  return stripped;
}

// Park lawns render on the terrain clipmap now (surface class 1 = grass), so
// lawn triangles in grn_ meshes are dropped entirely; only the pier decks that
// share those meshes survive. Classified by baked corner color: lawns are
// uniform PARK_COLOR, piers use PIER_COLOR (+0.6x dark sides) — verified byte
// values from shipped tiles. Idempotent: pier-only meshes have no lawn corners.
const LAWN_COLOR_BYTES = [39, 70, 29];
const LAWN_COLOR_TOLERANCE = 4;

function isLawnCorner(colors, index, element) {
  colors.getElement(index, element);
  for (let channel = 0; channel < 3; channel++) {
    if (Math.abs(element[channel] * 255 - LAWN_COLOR_BYTES[channel]) > LAWN_COLOR_TOLERANCE) {
      return false;
    }
  }
  return true;
}

function dropLawnTriangles(doc) {
  let dropped = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    if (!mesh.getName().startsWith("grn_")) continue;
    for (const prim of mesh.listPrimitives()) {
      const colors = prim.getAttribute("COLOR_0");
      const indices = prim.getIndices();
      if (!colors || !indices) continue;
      const source = indices.getArray();
      const kept = [];
      const element = [];
      for (let tri = 0; tri < source.length; tri += 3) {
        const lawn = isLawnCorner(colors, source[tri], element) &&
          isLawnCorner(colors, source[tri + 1], element) &&
          isLawnCorner(colors, source[tri + 2], element);
        if (!lawn) kept.push(source[tri], source[tri + 1], source[tri + 2]);
        else dropped++;
      }
      if (kept.length === source.length) continue;
      if (kept.length === 0) {
        prim.dispose();
        continue;
      }
      indices.setArray(source.constructor.from(kept));
    }
    if (mesh.listPrimitives().length === 0) mesh.dispose();
  }
  return dropped;
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
    const trisBefore = triangleCount(doc);
    let lawnDropped = 0;
    if (SKIP_QUANTIZE.has(name)) {
      await doc.transform(reorder({ encoder: MeshoptEncoder, target: "size" }));
      doc
        .createExtension(EXTMeshoptCompression)
        .setRequired(true)
        .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
    } else {
      stripDrapeNormals(doc);
      lawnDropped = dropLawnTriangles(doc);
      // unweld+weld round-trips welded meshes untouched while reclaiming
      // vertices orphaned by the lawn drop; weld() only merges bitwise-identical
      // vertices, which cannot change the rendered image.
      await doc.transform(
        prune(),
        unweld(),
        weld(),
        meshopt({ encoder: MeshoptEncoder, level: "high", quantizePosition: QUANTIZE_POSITION_BITS })
      );
    }
    const output = await io.writeBinary(doc);

    // prove the bytes decode before replacing the original. Triangles are the
    // invariant (weld may legitimately reduce vertices; dropped lawn triangles
    // are accounted exactly).
    const check = await io.readBinary(output);
    const trisAfter = triangleCount(check);
    if (trisAfter !== trisBefore - lawnDropped) {
      throw new Error(
        `${name}: triangle count ${trisBefore} -> ${trisAfter} (expected ${trisBefore - lawnDropped}), aborting`
      );
    }
    await fs.writeFile(file, output);

    inTotal += input.length;
    outTotal += output.length;
    console.log(
      `${name}: ${(input.length / 1e6).toFixed(2)}MB -> ${(output.length / 1e6).toFixed(2)}MB` +
        (vertsBefore === vertexCount(check) ? "" : ` (verts ${vertsBefore} -> ${vertexCount(check)})`)
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
