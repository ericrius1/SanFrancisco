#!/usr/bin/env node
// Reusable texture optimizer: source PNG/JPG -> GPU-native KTX2 (UASTC, mipmapped,
// stays compressed in VRAM) + a WebP fallback (for DOM <img> and browsers without
// KTX2). This is the app standard for pre-authored image textures.
//
//   node tools/optimize-textures.mjs <srcDir> <outDir> [--max 1024] [--linear] [--webp-only]
//
// KTX2 is loaded in-app via src/render/textures.ts loadTexture(); it transcodes to
// BC7/ASTC/ETC on the GPU so a 1024^2 map costs ~1 MB VRAM instead of ~4 MB RGBA.
import { readdirSync, mkdirSync, statSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import sharp from "sharp";

const TOKTX = process.env.TOKTX_BIN || "/Users/eric/.local/bin/toktx";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const [srcDir, outDir] = positional;
if (!srcDir || !outDir) {
  console.error("usage: node tools/optimize-textures.mjs <srcDir> <outDir> [--max N] [--linear] [--webp-only]");
  process.exit(1);
}
const maxDim = Number((args.find((a) => a.startsWith("--max")) || "--max=1024").split("=")[1] || 1024);
const linear = args.includes("--linear");
const webpOnly = args.includes("--webp-only");
const oetf = linear ? "linear" : "srgb";
// etc1s = small download + smallest VRAM (transcodes to BC1/ETC1), tiny gradient
// banding; uastc = larger but near-lossless. etc1s is the app default.
const encode = (args.find((a) => a.startsWith("--encode")) || "--encode=etc1s").split("=")[1] || "etc1s";
const encodeArgs =
  encode === "uastc"
    ? ["--encode", "uastc", "--uastc_quality", "2", "--zcmp", "18"]
    : ["--encode", "etc1s", "--clevel", "4", "--qlevel", "255"];

mkdirSync(outDir, { recursive: true });
const mult4 = (n) => Math.max(4, n - (n % 4)); // Basis needs dims that are multiples of 4

const files = readdirSync(srcDir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
if (!files.length) {
  console.error(`no images in ${srcDir}`);
  process.exit(1);
}
console.log(`optimizing ${files.length} textures ${srcDir} -> ${outDir} (max ${maxDim}, ${oetf}${webpOnly ? ", webp-only" : ", ktx2+webp"})`);

let ktxTotal = 0;
let webpTotal = 0;
for (const f of files) {
  const name = f.replace(/\.(png|jpg|jpeg)$/i, "");
  const src = path.join(srcDir, f);
  const meta = await sharp(src).metadata();
  const scale = Math.min(1, maxDim / Math.max(meta.width, meta.height));
  const w = mult4(Math.round(meta.width * scale));
  const h = mult4(Math.round(meta.height * scale));

  // resized intermediate (mult-of-4) for both encoders
  const tmp = path.join(outDir, `.${name}.tmp.png`);
  await sharp(src).resize(w, h, { fit: "fill" }).png().toFile(tmp);

  // WebP fallback / DOM
  const webpOut = path.join(outDir, `${name}.webp`);
  await sharp(tmp).webp({ quality: 84, effort: 5 }).toFile(webpOut);
  webpTotal += statSync(webpOut).size;

  // KTX2 UASTC (GPU-compressed, mipmapped)
  if (!webpOnly) {
    const ktxOut = path.join(outDir, `${name}.ktx2`);
    execFileSync(TOKTX, [...encodeArgs, "--genmipmap", "--assign_oetf", oetf, ktxOut, tmp], { stdio: "pipe" });
    ktxTotal += statSync(ktxOut).size;
  }
  rmSync(tmp);
  console.log(`  ${name}  ${w}x${h}`);
}
const kb = (b) => `${(b / 1024).toFixed(0)}KB`;
console.log(`done. webp ${kb(webpTotal)}${webpOnly ? "" : `, ktx2 ${kb(ktxTotal)}`} across ${files.length} files`);
