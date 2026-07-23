#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "assets-src/building-facades/generated");
const STAGING = path.join(ROOT, ".data/building-facade-textures");
const COLOR_STAGING = path.join(STAGING, "color");
const SURFACE_STAGING = path.join(STAGING, "surface");
const OUTPUT = path.join(ROOT, "public/building-facades");
const OPTIMIZER = path.join(ROOT, "tools/optimize-textures.mjs");
const TOKTX = process.env.TOKTX_BIN || "/Users/eric/.local/bin/toktx";

const ATLAS_SIZE = 1024;
const CELL_SIZE = ATLAS_SIZE / 2;
const GUTTER = 8;
const CONTENT_SIZE = CELL_SIZE - GUTTER * 2;
const EDGE_BLEND = 24;

// Window boxes are authored against the generated elevation sources. They are
// deliberately inside the surrounding trim: alpha becomes the runtime's glass
// and night-emissive mask, while the RGB channels remain untouched source art.
const RECIPES = [
  {
    source: "red-brick.png",
    slotX: 0,
    slotY: 0,
    window: [0.345, 0.302, 0.657, 0.72],
    roughness: 0.86
  },
  {
    source: "limestone.png",
    slotX: 1,
    slotY: 0,
    window: [0.35, 0.328, 0.645, 0.776],
    roughness: 0.9
  },
  {
    source: "painted-stucco.png",
    slotX: 0,
    slotY: 1,
    window: [0.37, 0.27, 0.63, 0.75],
    roughness: 0.88
  },
  {
    source: "early-modern-concrete.png",
    slotX: 1,
    slotY: 1,
    window: [0.128, 0.327, 0.875, 0.66],
    roughness: 0.84
  }
];

if (!existsSync(TOKTX)) {
  throw new Error(`toktx is required for the GPU-compressed facade bake; set TOKTX_BIN (looked for ${TOKTX})`);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function blendOpposingEdges(data, width, height, channels) {
  for (let y = 0; y < height; y++) {
    for (let d = 0; d < EDGE_BLEND; d++) {
      const weight = ((EDGE_BLEND - d) / EDGE_BLEND) ** 2;
      const left = (y * width + d) * channels;
      const right = (y * width + width - 1 - d) * channels;
      for (let channel = 0; channel < 3; channel++) {
        const average = (data[left + channel] + data[right + channel]) * 0.5;
        data[left + channel] = Math.round(data[left + channel] * (1 - weight) + average * weight);
        data[right + channel] = Math.round(data[right + channel] * (1 - weight) + average * weight);
      }
    }
  }
  for (let x = 0; x < width; x++) {
    for (let d = 0; d < EDGE_BLEND; d++) {
      const weight = ((EDGE_BLEND - d) / EDGE_BLEND) ** 2;
      const top = (d * width + x) * channels;
      const bottom = ((height - 1 - d) * width + x) * channels;
      for (let channel = 0; channel < 3; channel++) {
        const average = (data[top + channel] + data[bottom + channel]) * 0.5;
        data[top + channel] = Math.round(data[top + channel] * (1 - weight) + average * weight);
        data[bottom + channel] = Math.round(data[bottom + channel] * (1 - weight) + average * weight);
      }
    }
  }
}

function addWrapGutter(data, width, height, channels) {
  const cell = Buffer.alloc(CELL_SIZE * CELL_SIZE * channels);
  for (let y = 0; y < CELL_SIZE; y++) {
    const sourceY = (y - GUTTER + height) % height;
    for (let x = 0; x < CELL_SIZE; x++) {
      const sourceX = (x - GUTTER + width) % width;
      const source = (sourceY * width + sourceX) * channels;
      const target = (y * CELL_SIZE + x) * channels;
      for (let channel = 0; channel < channels; channel++) {
        cell[target + channel] = data[source + channel];
      }
    }
  }
  return cell;
}

function compositeCell(atlas, cell, slotX, slotY, channels) {
  const originX = slotX * CELL_SIZE;
  const originY = slotY * CELL_SIZE;
  for (let y = 0; y < CELL_SIZE; y++) {
    const source = y * CELL_SIZE * channels;
    const target = ((originY + y) * ATLAS_SIZE + originX) * channels;
    cell.copy(atlas, target, source, source + CELL_SIZE * channels);
  }
}

async function buildCell(recipe) {
  const { data, info } = await sharp(path.join(SOURCE, recipe.source))
    .resize(CONTENT_SIZE, CONTENT_SIZE, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  blendOpposingEdges(data, info.width, info.height, info.channels);

  const color = Buffer.from(data);
  const surface = Buffer.alloc(info.width * info.height * 3);
  const [x0, y0, x1, y1] = recipe.window;
  const feather = 0.012;
  for (let y = 0; y < info.height; y++) {
    const v = y / (info.height - 1);
    for (let x = 0; x < info.width; x++) {
      const u = x / (info.width - 1);
      const source = (y * info.width + x) * info.channels;
      const target = (y * info.width + x) * 3;
      const luminance =
        (data[source] * 0.2126 + data[source + 1] * 0.7152 + data[source + 2] * 0.0722) / 255;
      const box =
        smoothstep(x0 - feather, x0 + feather, u) *
        smoothstep(x1 + feather, x1 - feather, u) *
        smoothstep(y0 - feather, y0 + feather, v) *
        smoothstep(y1 + feather, y1 - feather, v);
      const glass = box * smoothstep(0.56, 0.24, luminance);

      // Store inverse glass coverage so masonry stays opaque. Lossy WebP
      // encoders are allowed to discard RGB beneath fully transparent pixels;
      // keeping the wall at alpha=1 preserves its authored color.
      color[source + 3] = Math.round((1 - glass) * 255);
      // R: wrap-safe height, G: roughness. Height is intentionally conservative;
      // the runtime turns it into a surface-gradient bump only in the near path.
      surface[target] = Math.round((0.2 + luminance * 0.62) * 255);
      surface[target + 1] = Math.round((recipe.roughness * (1 - glass) + 0.18 * glass) * 255);
      surface[target + 2] = 0;
    }
  }

  return {
    color: addWrapGutter(color, info.width, info.height, 4),
    surface: addWrapGutter(surface, info.width, info.height, 3)
  };
}

rmSync(STAGING, { recursive: true, force: true });
rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(COLOR_STAGING, { recursive: true });
mkdirSync(SURFACE_STAGING, { recursive: true });
mkdirSync(OUTPUT, { recursive: true });

const colorAtlas = Buffer.alloc(ATLAS_SIZE * ATLAS_SIZE * 4);
const surfaceAtlas = Buffer.alloc(ATLAS_SIZE * ATLAS_SIZE * 3);
for (const recipe of RECIPES) {
  const cell = await buildCell(recipe);
  compositeCell(colorAtlas, cell.color, recipe.slotX, recipe.slotY, 4);
  compositeCell(surfaceAtlas, cell.surface, recipe.slotX, recipe.slotY, 3);
}

await Promise.all([
  sharp(colorAtlas, { raw: { width: ATLAS_SIZE, height: ATLAS_SIZE, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(path.join(COLOR_STAGING, "facade-color.png")),
  sharp(surfaceAtlas, { raw: { width: ATLAS_SIZE, height: ATLAS_SIZE, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toFile(path.join(SURFACE_STAGING, "facade-surface.png"))
]);

execFileSync(process.execPath, [
  OPTIMIZER,
  COLOR_STAGING,
  OUTPUT,
  "--max=1024",
  "--encode=etc1s"
], {
  env: { ...process.env, TOKTX_BIN: TOKTX },
  cwd: ROOT,
  stdio: "inherit"
});
execFileSync(
  process.execPath,
  [OPTIMIZER, SURFACE_STAGING, OUTPUT, "--max=1024", "--linear", "--encode=etc1s"],
  { cwd: ROOT, env: { ...process.env, TOKTX_BIN: TOKTX }, stdio: "inherit" }
);

rmSync(STAGING, { recursive: true, force: true });
console.log(`building facade textures ready in ${path.relative(ROOT, OUTPUT)}`);
