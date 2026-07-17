#!/usr/bin/env node
// GLB embedded-texture optimizer: rewrites a .glb so its embedded PNG/JPEG
// textures become GPU-native KTX2 (KHR_texture_basisu). KTX2 stays COMPRESSED in
// VRAM (transcodes to BC7/ASTC/ETC on load), so a 2048^2 map costs ~4 MB instead
// of the ~16 MB RGBA a JPEG reinflates to on the GPU. Download size can grow
// (esp. UASTC normals) — this trades disk for VRAM, which is the win for a
// WebGPU, VRAM-bound app. Meshopt (EXT_meshopt_compression) and mesh
// quantization on the input are preserved automatically on write.
//
//   node tools/optimize-glb-textures.mjs <input.glb> [output.glb] [--dry] [--verbose]
//
// If <output.glb> is omitted the file is rewritten in place (via a temp file +
// atomic rename). --dry converts + reports sizes but writes nothing.
//
// Per-texture encode policy (mirrors tools/optimize-textures.mjs / the app KTX2
// standard, split by material slot):
//   - normal slot                       -> UASTC  (--uastc_quality 2 --zcmp 18),
//                                           linear OETF. ETC1S mangles normals.
//   - baseColor / emissive              -> ETC1S  (--clevel 4 --qlevel 255), sRGB
//   - metallicRoughness / occlusion     -> ETC1S, linear OETF (data, not color)
//   - anything else / unused            -> ETC1S, sRGB (safe default)
// Both modes generate mipmaps (--genmipmap). Dimensions are floored to a
// multiple of 4 (Basis block size) via sharp when necessary.
//
// The loader side must call setKTX2Loader(...) on its GLTFLoader (see
// src/render/textures.ts attachKtx2 + the wired GLTFLoader sites). KTX2 GLBs
// mark KHR_texture_basisu as required, so a loader without a KTX2Loader will
// fail loudly rather than render an untextured mesh.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRTextureBasisu } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const TOKTX = process.env.TOKTX_BIN || "/Users/eric/.local/bin/toktx";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const [input, outputArg] = positional;
const dry = args.includes("--dry");
const verbose = args.includes("--verbose");
if (!input) {
  console.error("usage: node tools/optimize-glb-textures.mjs <input.glb> [output.glb] [--dry] [--verbose]");
  process.exit(1);
}
const output = outputArg || input;

const mult4 = (n) => Math.max(4, n - (n % 4)); // Basis needs dims that are multiples of 4
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

// --- encode recipes (match tools/optimize-textures.mjs) ---
const ETC1S = ["--encode", "etc1s", "--clevel", "4", "--qlevel", "255"];
const UASTC = ["--encode", "uastc", "--uastc_quality", "2", "--zcmp", "18"];

/** Decide encode mode + OETF from the set of material slots a texture feeds. */
function policyFor(slots) {
  if (slots.has("normal")) return { mode: "uastc", encodeArgs: UASTC, oetf: "linear" };
  const linear = !slots.has("baseColor") && !slots.has("emissive") &&
    (slots.has("metallicRoughness") || slots.has("occlusion"));
  return { mode: "etc1s", encodeArgs: ETC1S, oetf: linear ? "linear" : "srgb" };
}

async function main() {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

  const doc = await io.read(input);
  const root = doc.getRoot();
  const textures = root.listTextures();
  if (textures.length === 0) {
    console.log(`[optimize-glb] ${input}: no textures — nothing to do.`);
    return;
  }

  // Map each texture -> the set of slots it feeds across all materials.
  const slotsByTexture = new Map();
  const addSlot = (tex, slot) => {
    if (!tex) return;
    const s = slotsByTexture.get(tex) || new Set();
    s.add(slot);
    slotsByTexture.set(tex, s);
  };
  for (const m of root.listMaterials()) {
    addSlot(m.getBaseColorTexture(), "baseColor");
    addSlot(m.getNormalTexture(), "normal");
    addSlot(m.getMetallicRoughnessTexture(), "metallicRoughness");
    addSlot(m.getEmissiveTexture(), "emissive");
    addSlot(m.getOcclusionTexture(), "occlusion");
  }

  const tmp = mkdtempSync(path.join(tmpdir(), "glbktx-"));
  let beforeTotal = 0;
  let afterTotal = 0;
  const rows = [];
  try {
    let i = 0;
    for (const tex of textures) {
      const image = tex.getImage();
      if (!image) {
        console.warn(`[optimize-glb] texture "${tex.getName()}" has no image — skipped`);
        continue;
      }
      const mime = tex.getMimeType();
      if (mime === "image/ktx2") {
        if (verbose) console.log(`[optimize-glb] texture "${tex.getName()}" already KTX2 — skipped`);
        beforeTotal += image.byteLength;
        afterTotal += image.byteLength;
        continue;
      }
      const slots = slotsByTexture.get(tex) || new Set();
      const { mode, encodeArgs, oetf } = policyFor(slots);

      // Write the source image (resizing to a multiple of 4 only when needed so
      // Basis' 4x4 blocks tile cleanly). toktx reads PNG/JPEG only, so WebP/AVIF
      // (EXT_texture_webp GLBs) are decoded to PNG via sharp first.
      const [w0, h0] = tex.getSize() || [0, 0];
      const w = mult4(w0);
      const h = mult4(h0);
      const direct = mime === "image/png" || mime === "image/jpeg";
      const srcExt = mime === "image/png" ? "png" : direct ? "jpg" : "png";
      const srcPath = path.join(tmp, `tex_${i}.${srcExt}`);
      if (w !== w0 || h !== h0) {
        await sharp(Buffer.from(image)).resize(w, h, { fit: "fill" }).toFile(srcPath);
      } else if (direct) {
        writeFileSync(srcPath, Buffer.from(image));
      } else {
        await sharp(Buffer.from(image)).png().toFile(srcPath);
      }
      const ktx2Path = path.join(tmp, `tex_${i}.ktx2`);
      execFileSync(
        TOKTX,
        ["--t2", "--genmipmap", "--assign_oetf", oetf, ...encodeArgs, ktx2Path, srcPath],
        { stdio: verbose ? "inherit" : ["ignore", "ignore", "pipe"] }
      );
      const ktx2 = readFileSync(ktx2Path);
      tex.setImage(new Uint8Array(ktx2)).setMimeType("image/ktx2");

      beforeTotal += image.byteLength;
      afterTotal += ktx2.byteLength;
      rows.push({
        name: (tex.getName() || `tex_${i}`).slice(0, 40),
        slot: [...slots].join("+") || "unused",
        mode,
        oetf,
        dims: `${w}x${h}`,
        before: image.byteLength,
        after: ktx2.byteLength
      });
      i++;
    }

    // Declare KHR_texture_basisu. Required=true so a GLTFLoader lacking a
    // KTX2Loader fails loudly instead of silently dropping the textures.
    doc.createExtension(KHRTextureBasisu).setRequired(true);

    // Drop texture-format extensions that no remaining texture uses (e.g. a
    // formerly all-WebP GLB must not keep EXT_texture_webp in extensionsRequired).
    const remainingMimes = new Set(root.listTextures().map((t) => t.getMimeType()));
    for (const [extName, extMime] of [
      ["EXT_texture_webp", "image/webp"],
      ["EXT_texture_avif", "image/avif"]
    ]) {
      if (remainingMimes.has(extMime)) continue;
      const ext = root.listExtensionsUsed().find((e) => e.extensionName === extName);
      if (ext) {
        ext.dispose();
        if (verbose) console.log(`[optimize-glb] dropped now-unused ${extName}`);
      }
    }

    console.log(`\n[optimize-glb] ${path.basename(input)}  (${textures.length} textures)`);
    for (const r of rows) {
      console.log(
        `  ${r.mode.padEnd(5)} ${r.oetf.padEnd(6)} ${r.dims.padEnd(9)} ${r.slot.padEnd(18)} ` +
        `${kb(r.before).padStart(8)} -> ${kb(r.after).padStart(8)}  ${r.name}`
      );
    }
    console.log(`  textures on disk: ${kb(beforeTotal)} -> ${kb(afterTotal)}`);

    if (dry) {
      console.log(`[optimize-glb] --dry: not writing ${output}`);
      return;
    }

    const beforeFile = statSync(input).size;
    const inPlace = path.resolve(output) === path.resolve(input);
    // writeBinary() guarantees a single self-contained .glb (all buffers +
    // KTX2 images embedded). We write the bytes ourselves so the temp path's
    // extension can't trick NodeIO.write into emitting external-resource glTF.
    const glb = await io.writeBinary(doc);
    const writePath = inPlace ? `${output}.tmp-${process.pid}.glb` : output;
    writeFileSync(writePath, Buffer.from(glb));
    if (inPlace) renameSync(writePath, output);
    const afterFile = statSync(output).size;
    console.log(
      `[optimize-glb] wrote ${output}  GLB ${kb(beforeFile)} -> ${kb(afterFile)} ` +
      `(${afterFile >= beforeFile ? "+" : ""}${(((afterFile - beforeFile) / beforeFile) * 100).toFixed(0)}%)`
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[optimize-glb] failed:", err?.message || err);
  process.exit(1);
});
