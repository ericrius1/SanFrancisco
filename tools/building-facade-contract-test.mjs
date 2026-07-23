#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => {
  throw new Error(`[building-facades] ${message}`);
};

const facadeSource = await readFile(path.join(ROOT, "src/world/facade.ts"), "utf8");
const bakedSource = await readFile(path.join(ROOT, "src/world/facadeBaked.ts"), "utf8");
if (/mx_(?:fractal_)?noise|fwidth|brickFace|mottle/.test(facadeSource + bakedSource)) {
  fail("fragment-time procedural facade detail returned");
}

const colorPath = path.join(ROOT, "public/building-facades/facade-color.webp");
const surfacePath = path.join(ROOT, "public/building-facades/facade-surface.webp");
const colorKtxPath = path.join(ROOT, "public/building-facades/facade-color.ktx2");
const surfaceKtxPath = path.join(ROOT, "public/building-facades/facade-surface.ktx2");
const [colorMeta, surfaceMeta, colorBytes, surfaceBytes, colorKtx, surfaceKtx] = await Promise.all([
  sharp(colorPath).metadata(),
  sharp(surfacePath).metadata(),
  stat(colorPath),
  stat(surfacePath),
  stat(colorKtxPath),
  stat(surfaceKtxPath)
]);
for (const [name, metadata] of [["color", colorMeta], ["surface", surfaceMeta]]) {
  if (metadata.width !== 1024 || metadata.height !== 1024) {
    fail(`${name} atlas is ${metadata.width}x${metadata.height}, expected 1024x1024`);
  }
}
if (!colorMeta.hasAlpha) fail("color atlas lost its baked window-mask alpha");
if (colorBytes.size + surfaceBytes.size > 256 * 1024) {
  fail(`boot payload is ${colorBytes.size + surfaceBytes.size} bytes, expected at most 256 KiB`);
}
if (colorKtx.size + surfaceKtx.size > 512 * 1024) {
  fail(`KTX2 payload is ${colorKtx.size + surfaceKtx.size} bytes, expected at most 512 KiB`);
}

const { data, info } = await sharp(colorPath).raw().toBuffer({ resolveWithObject: true });
let alphaMin = 255;
let alphaMax = 0;
let maskedPixels = 0;
for (let i = 3; i < data.length; i += info.channels) {
  alphaMin = Math.min(alphaMin, data[i]);
  alphaMax = Math.max(alphaMax, data[i]);
  if (data[i] < 128) maskedPixels++;
}
if (alphaMin > 16 || alphaMax < 239) fail(`window mask range is ${alphaMin}..${alphaMax}`);
const maskCoverage = maskedPixels / (info.width * info.height);
if (maskCoverage < 0.08 || maskCoverage > 0.35) {
  fail(`window mask covers ${(maskCoverage * 100).toFixed(1)}%, expected 8%..35%`);
}

console.log(
  `building facade contract: ok (2x 1024 atlases, ${Math.round((colorKtx.size + surfaceKtx.size) / 1024)} KiB KTX2, ` +
  `${Math.round((colorBytes.size + surfaceBytes.size) / 1024)} KiB WebP, ` +
  `${(maskCoverage * 100).toFixed(1)}% glass mask)`
);
