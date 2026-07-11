// Encode .webp siblings for every PNG under public/seedthree so the SeedThree
// loaders (vendor/SeedThree/src/api/seedthree.js webp-first fallback) serve a
// fraction of the bytes. Originals are never touched — the .png stays as the
// runtime fallback. Normal maps go lossless (lossy webp mangles tangent-space
// normals); everything else is lossy albedo-grade. Longest edge is capped at
// 1024 (source maps go up to 2048 and the trees never resolve that density).
// Idempotent: a .webp newer than its source is skipped. Rerun after adding or
// regenerating any texture.
//
//   node tools/optimize-seedthree.mjs

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "public", "seedthree");
const MAX_EDGE = 1024;

async function* pngs(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* pngs(p);
    else if (e.isFile() && /\.png$/i.test(e.name)) yield p;
  }
}

const fmt = (n) => `${(n / 1024).toFixed(0)}KB`;
const rows = [];
let before = 0, after = 0, converted = 0, skipped = 0;

for await (const src of pngs(DIR)) {
  const out = src.replace(/\.png$/i, ".webp");
  const srcStat = await stat(src);
  const outStat = await stat(out).catch(() => null);
  if (outStat && outStat.mtimeMs > srcStat.mtimeMs) {
    skipped++;
    before += srcStat.size;
    after += outStat.size;
    continue;
  }
  const isNormal = path.basename(src).toLowerCase().includes("normal");
  let img = sharp(src);
  const meta = await img.metadata();
  if (Math.max(meta.width, meta.height) > MAX_EDGE) {
    img = img.resize({
      width: MAX_EDGE, height: MAX_EDGE,
      fit: "inside", withoutEnlargement: true, kernel: "lanczos3",
    });
  }
  img = isNormal ? img.webp({ lossless: true, effort: 6 }) : img.webp({ quality: 82, effort: 6 });
  const info = await img.toFile(out);
  converted++;
  before += srcStat.size;
  after += info.size;
  rows.push({
    file: path.relative(DIR, src),
    kind: isNormal ? "normal" : "color",
    dims: `${meta.width}→${Math.min(meta.width, MAX_EDGE)}`,
    png: fmt(srcStat.size),
    webp: fmt(info.size),
    saved: `${(100 * (1 - info.size / srcStat.size)).toFixed(0)}%`,
  });
}

if (rows.length) console.table(rows);
console.log(`converted ${converted}, skipped ${skipped} (webp up to date)`);
console.log(`png total ${fmt(before)} → webp total ${fmt(after)} — saved ${fmt(before - after)} (${(100 * (1 - after / before)).toFixed(1)}%)`);
