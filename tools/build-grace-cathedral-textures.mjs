#!/usr/bin/env node

// Prepare the original image-generation plates for Blender/glTF and derive a
// tangent-space relief normal from their lead/cement boundaries. The source
// plates remain beside the authored .blend so an artist can always revisit the
// crop and normal strength without regenerating the artwork.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "assets-src", "world", "sites", "grace-cathedral", "textures");

const assets = [
  {
    name: "rose-window",
    source: "source/rose-window-gpt-image.png",
    width: 1024,
    height: 1024,
    normalStrength: 2.4
  },
  {
    name: "angel-lancet",
    source: "source/angel-lancet-gpt-image.png",
    width: 512,
    height: 1024,
    normalStrength: 2.1,
    trim: true
  }
];

function normalMapFromHeight(raw, width, height, channels, strength) {
  const out = Buffer.alloc(width * height * 4);
  const heightAt = (x, y) => {
    const px = Math.max(0, Math.min(width - 1, x));
    const py = Math.max(0, Math.min(height - 1, y));
    const offset = (py * width + px) * channels;
    const r = raw[offset] / 255;
    const g = raw[offset + 1] / 255;
    const b = raw[offset + 2] / 255;
    // Dark lead/cement should sit proud of the glass. Inverting luminance
    // gives its strong silhouette a raised bevel in the derived normal.
    return 1 - (r * 0.2126 + g * 0.7152 + b * 0.0722);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (heightAt(x + 1, y) - heightAt(x - 1, y)) * strength;
      const dy = (heightAt(x, y + 1) - heightAt(x, y - 1)) * strength;
      const invLength = 1 / Math.hypot(dx, dy, 1);
      const nx = -dx * invLength;
      const ny = dy * invLength;
      const nz = invLength;
      const offset = (y * width + x) * 4;
      out[offset] = Math.round((nx * 0.5 + 0.5) * 255);
      out[offset + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[offset + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[offset + 3] = 255;
    }
  }
  return out;
}

await fs.mkdir(DIR, { recursive: true });
for (const asset of assets) {
  const input = path.join(DIR, asset.source);
  let pipeline = sharp(input, { failOn: "error" });
  if (asset.trim) pipeline = pipeline.trim({ background: "#000000", threshold: 7 });
  pipeline = pipeline.resize(asset.width, asset.height, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 1 },
    kernel: sharp.kernel.lanczos3
  });

  const colorPath = path.join(DIR, `${asset.name}.jpg`);
  await pipeline.clone().jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toFile(colorPath);
  const { data, info } = await pipeline
    .clone()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const normal = normalMapFromHeight(
    data,
    info.width,
    info.height,
    info.channels,
    asset.normalStrength
  );
  const normalPath = path.join(DIR, `${asset.name}-normal.jpg`);
  await sharp(normal, { raw: { width: info.width, height: info.height, channels: 4 } })
    .removeAlpha()
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
    .toFile(normalPath);
  console.log(`[grace-cathedral] ${asset.name}: ${info.width}x${info.height}`);
}
