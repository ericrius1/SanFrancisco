#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "assets-src/japanese-tea-garden/drum-bridge");
const STAGING = path.join(ROOT, ".data/drum-bridge-textures");
const COLOR_STAGING = path.join(STAGING, "color");
const NORMAL_STAGING = path.join(STAGING, "normal");
const OUTPUT = path.join(ROOT, "public/japanese-tea-garden/drum-bridge");
const OPTIMIZER = path.join(ROOT, "tools/optimize-textures.mjs");
const SIZE = 1024;

const RECIPES = [
  {
    source: "painted-timber-source.png",
    output: "painted-timber",
    normalStrength: 3.2
  },
  {
    source: "worn-timber-source.png",
    output: "worn-timber",
    normalStrength: 2.5
  }
];

function pixelIndex(x, y, width) {
  return (y * width + x) * 3;
}

/** Mirror-wrap the authored source before cropping so the runtime tile has
 * mathematically matching edges without painting over its authored detail. */
async function makeSeamless(source) {
  const square = await sharp(source)
    .resize(SIZE, SIZE, { fit: "cover", position: "centre" })
    .removeAlpha()
    .png()
    .toBuffer();
  const [flopped, flipped, both] = await Promise.all([
    sharp(square).flop().png().toBuffer(),
    sharp(square).flip().png().toBuffer(),
    sharp(square).flip().flop().png().toBuffer()
  ]);
  const mirrored = await sharp({
    create: { width: SIZE * 2, height: SIZE * 2, channels: 3, background: "#000000" }
  })
    .composite([
      { input: square, left: 0, top: 0 },
      { input: flopped, left: SIZE, top: 0 },
      { input: flipped, left: 0, top: SIZE },
      { input: both, left: SIZE, top: SIZE }
    ])
    .extract({ left: SIZE / 2, top: SIZE / 2, width: SIZE, height: SIZE })
    .png()
    .toBuffer();
  return mirrored;
}

/** Derive a tangent-space detail normal from the authored color source. This
 * adds no invented motifs: it converts the source's real grain and paint wear
 * into lighting response, using wrap-aware central differences. */
async function makeNormal(color, strength) {
  const { data, info } = await sharp(color)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const normal = Buffer.alloc(info.width * info.height * 3);
  const sample = (x, y) => data[((y + info.height) % info.height) * info.width + ((x + info.width) % info.width)];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const dx = (sample(x + 1, y) - sample(x - 1, y)) / 255;
      const dy = (sample(x, y + 1) - sample(x, y - 1)) / 255;
      let nx = -dx * strength;
      let ny = dy * strength;
      let nz = 1;
      const inverseLength = 1 / Math.hypot(nx, ny, nz);
      nx *= inverseLength;
      ny *= inverseLength;
      nz *= inverseLength;
      const index = pixelIndex(x, y, info.width);
      normal[index] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[index + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[index + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }

  // Averaging opposing edge texels removes the final sub-texel normal cusp at
  // the wrap boundary while preserving all interior authored grain.
  for (let y = 0; y < info.height; y++) {
    const left = pixelIndex(0, y, info.width);
    const right = pixelIndex(info.width - 1, y, info.width);
    for (let channel = 0; channel < 3; channel++) {
      const average = Math.round((normal[left + channel] + normal[right + channel]) / 2);
      normal[left + channel] = average;
      normal[right + channel] = average;
    }
  }
  for (let x = 0; x < info.width; x++) {
    const top = pixelIndex(x, 0, info.width);
    const bottom = pixelIndex(x, info.height - 1, info.width);
    for (let channel = 0; channel < 3; channel++) {
      const average = Math.round((normal[top + channel] + normal[bottom + channel]) / 2);
      normal[top + channel] = average;
      normal[bottom + channel] = average;
    }
  }
  return sharp(normal, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}

rmSync(STAGING, { recursive: true, force: true });
rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(COLOR_STAGING, { recursive: true });
mkdirSync(NORMAL_STAGING, { recursive: true });
mkdirSync(OUTPUT, { recursive: true });

for (const recipe of RECIPES) {
  const color = await makeSeamless(path.join(SOURCE, recipe.source));
  const normal = await makeNormal(color, recipe.normalStrength);
  await Promise.all([
    sharp(color).png({ compressionLevel: 9 }).toFile(path.join(COLOR_STAGING, `${recipe.output}-basecolor.png`)),
    sharp(normal).png({ compressionLevel: 9 }).toFile(path.join(NORMAL_STAGING, `${recipe.output}-normal.png`))
  ]);
}

execFileSync(process.execPath, [OPTIMIZER, COLOR_STAGING, OUTPUT, "--max=1024", "--encode=etc1s"], {
  cwd: ROOT,
  stdio: "inherit"
});
execFileSync(process.execPath, [OPTIMIZER, NORMAL_STAGING, OUTPUT, "--max=1024", "--linear", "--encode=uastc"], {
  cwd: ROOT,
  stdio: "inherit"
});

rmSync(STAGING, { recursive: true, force: true });
console.log(`drum bridge textures ready in ${path.relative(ROOT, OUTPUT)}`);
