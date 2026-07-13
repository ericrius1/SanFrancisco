#!/usr/bin/env node

// Native foliage texture compiler.
//
// Source pixels are deterministic and procedural; the pipeline has no external
// source-texture or vendor dependency.
// The tool synthesizes species-specific leaves and bark, packs linear surface
// channels, emits explicit mip chains, encodes KTX2, validates every output,
// and writes the runtime manifest under public/native-foliage.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = path.join(ROOT, "public", "native-foliage");
const WORK_ROOT = path.join(ROOT, ".data", "native-foliage-texture-build");
const BASIS_RELEASE = "basis-r185";
const BASIS_SOURCE_ROOT = path.join(ROOT, "node_modules", "three", "examples", "jsm", "libs", "basis");
const BASIS_FILES = ["basis_transcoder.js", "basis_transcoder.wasm"];
const TOKTX = process.env.TOKTX ?? "toktx";
const KTX2CHECK = process.env.KTX2CHECK ?? "ktx2check";
const KTXINFO = process.env.KTXINFO ?? "ktxinfo";
const KEEP_INTERMEDIATE = process.argv.includes("--keep-intermediate");
const CHECK_ONLY = process.argv.includes("--check");
const TEXTURE_SIZE = 512;
const TWO_PI = Math.PI * 2;

const MATERIAL_SETS = [
  {
    id: "coast-redwood",
    seed: 1103,
    leafStyle: style("needle-spray", 0.4, 0.35),
    leafGenerator: "redwood-spray",
    palettes: { default: [[42, 83, 52], [91, 130, 70]], "new-growth": [[75, 112, 58], [139, 157, 76]] },
    bark: barkStyle("fibrous-redwood", [103, 53, 34], [176, 101, 61], 0.84, 0.42)
  },
  {
    id: "monterey-cypress",
    seed: 1201,
    leafStyle: style("scale-spray", 0.42, 0.52),
    leafGenerator: "cypress-spray",
    palettes: { default: [[38, 71, 45], [82, 108, 58]] },
    bark: barkStyle("twisted-cypress", [72, 64, 52], [139, 116, 78], 0.88, 0.5)
  },
  {
    id: "coast-live-oak",
    seed: 1301,
    leafStyle: style("broadleaf", 0.5, 0.62),
    leafGenerator: "live-oak",
    palettes: { default: [[49, 84, 48], [100, 128, 67]] },
    bark: barkStyle("blocky-oak", [66, 61, 49], [132, 115, 81], 0.92, 0.56)
  },
  {
    id: "eucalyptus",
    seed: 1409,
    leafStyle: style("broadleaf", 0.47, 0.78),
    leafGenerator: "eucalyptus",
    palettes: { default: [[65, 101, 81], [143, 158, 114]], juvenile: [[78, 116, 111], [162, 174, 137]] },
    bark: barkStyle("mottled-eucalyptus", [155, 147, 118], [216, 202, 164], 0.64, 0.72)
  },
  {
    id: "japanese-black-pine",
    seed: 1501,
    leafStyle: style("needle-tuft", 0.38, 0.28),
    leafGenerator: "pine-tuft",
    palettes: { default: [[31, 66, 42], [77, 107, 51]] },
    bark: barkStyle("plated-black-pine", [50, 43, 38], [113, 79, 53], 0.94, 0.38)
  },
  {
    id: "japanese-maple",
    seed: 1607,
    leafStyle: style("broadleaf", 0.49, 0.63),
    leafGenerator: "maple",
    palettes: { default: [[52, 94, 50], [118, 139, 60]], autumn: [[125, 42, 31], [229, 103, 38]] },
    bark: barkStyle("smooth-maple", [91, 73, 65], [157, 125, 105], 0.7, 0.66)
  },
  {
    id: "flowering-cherry",
    seed: 1709,
    leafStyle: style("broadleaf", 0.49, 0.7),
    leafGenerator: "cherry",
    palettes: { default: [[58, 100, 49], [132, 149, 66]], blossom: [[183, 88, 111], [255, 198, 205]] },
    bark: barkStyle("lenticel-cherry", [92, 55, 49], [172, 106, 91], 0.76, 0.62)
  },
  {
    id: "ginkgo",
    seed: 1801,
    leafStyle: style("broadleaf", 0.48, 0.74),
    leafGenerator: "ginkgo",
    palettes: { default: [[73, 112, 48], [157, 164, 65]], autumn: [[183, 135, 22], [247, 211, 65]] },
    bark: barkStyle("furrowed-ginkgo", [80, 71, 57], [145, 126, 91], 0.9, 0.5)
  },
  {
    id: "magnolia",
    seed: 1901,
    leafStyle: style("broadleaf", 0.5, 0.68),
    leafGenerator: "magnolia",
    palettes: { default: [[37, 83, 48], [104, 131, 66]] },
    bark: barkStyle("smooth-magnolia", [102, 103, 88], [164, 158, 132], 0.68, 0.7)
  },
  {
    id: "chilean-palm",
    seed: 2003,
    leafStyle: style("palm-frond", 0.4, 0.42),
    leafGenerator: "palm-frond",
    palettes: { default: [[45, 91, 53], [117, 142, 67]], dry: [[100, 94, 56], [176, 147, 78]] },
    bark: barkStyle("ringed-palm", [101, 83, 58], [170, 139, 88], 0.86, 0.56)
  }
];

const NATIVE_ALIASES = {
  "coast-redwood": "coast-redwood",
  redwood: "coast-redwood",
  "monterey-cypress": "monterey-cypress",
  cypress: "monterey-cypress",
  "coast-live-oak": "coast-live-oak",
  oak: "coast-live-oak",
  corona_coast_live_oak: "coast-live-oak",
  eucalyptus: "eucalyptus",
  "japanese-black-pine": "japanese-black-pine",
  "black-pine": "japanese-black-pine",
  "japanese-maple": "japanese-maple",
  "flowering-cherry": "flowering-cherry",
  ginkgo: "ginkgo",
  "survivor-ginkgo": "ginkgo",
  magnolia: "magnolia",
  "chilean-palm": "chilean-palm"
};

function style(family, alphaCutoff, translucency) {
  return { family, alphaCutoff, translucency, twoSided: true };
}

function barkStyle(generator, dark, light, roughness, normalStrength) {
  return { generator, dark, light, roughness, normalStrength };
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function hash2(x, y, seed) {
  let h = Math.imul((x | 0) ^ seed, 0x45d9f3b) ^ Math.imul((y | 0) + seed, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function wrappedNoise(u, v, cells, seed) {
  const x = u * cells;
  const y = v * cells;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(0, 1, x - x0);
  const fy = smoothstep(0, 1, y - y0);
  const at = (ix, iy) => hash2((ix + cells) % cells, (iy + cells) % cells, seed);
  return mix(mix(at(x0, y0), at(x0 + 1, y0), fx), mix(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx), fy);
}

function fbm(u, v, seed) {
  let value = 0;
  let weight = 0.55;
  let total = 0;
  for (const cells of [4, 8, 16, 32]) {
    value += wrappedNoise(u, v, cells, seed + cells * 17) * weight;
    total += weight;
    weight *= 0.5;
  }
  return value / total;
}

function distanceToSegment(x, y, segment) {
  const vx = segment.bx - segment.ax;
  const vy = segment.by - segment.ay;
  const length2 = vx * vx + vy * vy;
  const t = length2 > 0 ? clamp(((x - segment.ax) * vx + (y - segment.ay) * vy) / length2) : 0;
  const px = segment.ax + vx * t;
  const py = segment.ay + vy * t;
  const width = mix(segment.w0, segment.w1, t);
  return { signed: width - Math.hypot(x - px, y - py), height: clamp(1 - Math.hypot(x - px, y - py) / width), t };
}

function addSegment(segments, ax, ay, bx, by, w0, w1 = w0, role = "leaf") {
  segments.push({ ax, ay, bx, by, w0, w1, role });
}

function spraySegments(generator, seed) {
  const segments = [];
  if (generator === "redwood-spray") {
    addSegment(segments, 0, -0.9, 0.03, 0.86, 0.025, 0.012, "vein");
    for (let i = 0; i < 18; i++) {
      const y = -0.72 + i * 0.087;
      const taper = 1 - Math.max(0, y - 0.25) * 0.7;
      for (const side of [-1, 1]) {
        const jitter = (hash2(i, side, seed) - 0.5) * 0.045;
        addSegment(segments, 0.01, y, side * (0.47 + 0.13 * taper), y + 0.13 + jitter, 0.024, 0.012);
      }
    }
  } else if (generator === "cypress-spray") {
    addSegment(segments, 0, -0.9, 0.02, 0.88, 0.045, 0.018, "vein");
    for (let i = 0; i < 11; i++) {
      const y = -0.68 + i * 0.135;
      const reach = 0.62 * (1 - Math.max(0, y - 0.2) * 0.65);
      for (const side of [-1, 1]) {
        const bx = side * reach;
        const by = y + 0.2 + (hash2(i, side, seed) - 0.5) * 0.08;
        addSegment(segments, 0, y, bx, by, 0.038, 0.015, "vein");
        for (let j = 1; j <= 3; j++) {
          const t = j / 4;
          const px = mix(0, bx, t);
          const py = mix(y, by, t);
          addSegment(segments, px, py, px + side * 0.1, py + 0.095, 0.025, 0.01);
        }
      }
    }
  } else if (generator === "pine-tuft") {
    // A card represents a small black-pine needle fascicle. Keep the negative
    // space between needles, but give the close Tea Garden specimens enough
    // covered pixels to read as layered tufts instead of bare sticks.
    const needleCount = 36;
    for (let i = 0; i < needleCount; i++) {
      const angle = -1.16 + (2.32 * i) / (needleCount - 1) + (hash2(i, 2, seed) - 0.5) * 0.06;
      const length = 0.84 + hash2(i, 9, seed) * 0.18;
      const ax = (hash2(i, 4, seed) - 0.5) * 0.09;
      const ay = -0.78 + hash2(i, 5, seed) * 0.12;
      addSegment(segments, ax, ay, ax + Math.sin(angle) * length, ay + Math.cos(angle) * length, 0.024, 0.01);
    }
    addSegment(segments, -0.04, -0.92, 0.02, -0.6, 0.035, 0.02, "vein");
  } else if (generator === "palm-frond") {
    addSegment(segments, 0, -0.92, 0.04, 0.88, 0.035, 0.014, "vein");
    for (let i = 0; i < 18; i++) {
      const y = -0.62 + i * 0.082;
      const reach = 0.68 * Math.sin(((i + 2) / 21) * Math.PI);
      for (const side of [-1, 1]) {
        const droop = -0.05 - 0.09 * (1 - i / 18);
        addSegment(segments, 0.015, y, side * reach, y + 0.12 + droop, 0.021, 0.006);
      }
    }
  }
  return segments;
}

function broadleafField(generator, x, y) {
  const stem = distanceToSegment(x, y, { ax: 0, ay: -0.97, bx: 0, by: -0.56, w0: 0.018, w1: 0.03 });
  let sx = 0.65;
  let sy = 0.82;
  let centerY = 0.02;
  let serration = 0;
  let boundary = 1;
  let notch = 0;

  if (generator === "live-oak") {
    sx = 0.58; sy = 0.78; centerY = 0.01;
    const angle = Math.atan2(x / sx, (y - centerY) / sy);
    serration = 0.065 * Math.cos(angle * 12) + 0.025 * Math.cos(angle * 23);
  } else if (generator === "eucalyptus") {
    sx = 0.33; sy = 0.9; centerY = 0;
    const angle = Math.atan2(x / sx, (y - centerY) / sy);
    serration = 0.012 * Math.cos(angle * 7);
  } else if (generator === "cherry") {
    sx = 0.58; sy = 0.82; centerY = 0.02;
    const angle = Math.atan2(x / sx, (y - centerY) / sy);
    serration = 0.035 * Math.cos(angle * 30);
  } else if (generator === "magnolia") {
    sx = 0.64; sy = 0.86; centerY = 0.02;
    const angle = Math.atan2(x / sx, (y - centerY) / sy);
    serration = 0.009 * Math.cos(angle * 5);
  } else if (generator === "maple") {
    const px = x;
    const py = y + 0.03;
    const radius = Math.hypot(px, py);
    const angle = Math.atan2(px, py);
    const lobes = Math.pow(Math.max(0, Math.cos(angle * 5)), 2.4);
    boundary = 0.49 + 0.42 * lobes + 0.08 * Math.cos(angle * 10);
    const signed = boundary - radius;
    const vein = Math.max(stem.height, Math.exp(-Math.abs(Math.sin(angle * 5)) * 54) * smoothstep(0.12, 0.76, radius));
    return { signed: Math.max(signed, stem.signed), height: Math.max(clamp(signed * 3.2 + 0.12), stem.height * 0.35), vein };
  } else if (generator === "ginkgo") {
    const px = x;
    const py = y + 0.68;
    const radius = Math.hypot(px, py);
    const angle = Math.atan2(px, py);
    const inWedge = 1.33 - Math.abs(angle);
    const scallop = 0.055 * Math.cos(angle * 8);
    const radial = 0.84 + scallop - radius;
    notch = 0.18 - Math.hypot(x, y - 0.15);
    const signed = Math.min(inWedge, Math.min(radial, y + 0.67));
    const cut = y > 0.18 ? notch : -1;
    const fanVeins = Math.exp(-Math.abs(Math.sin(angle * 8)) * 42) * smoothstep(0.18, 0.82, radius);
    return {
      signed: Math.max(Math.min(signed, -cut), stem.signed),
      height: Math.max(clamp(radial * 2.5 + 0.15), stem.height * 0.3),
      vein: Math.max(stem.height, fanVeins)
    };
  }

  const nx = x / sx;
  const ny = (y - centerY) / sy;
  const radius = Math.hypot(nx, ny);
  const signed = 1 + serration - radius;
  const midrib = Math.exp(-Math.abs(x) * 90) * smoothstep(-0.72, 0.7, y);
  const sideAngle = Math.atan2(nx, ny);
  const sideVeins = Math.exp(-Math.abs(Math.sin(sideAngle * 7)) * 34) * smoothstep(0.18, 0.92, radius);
  return {
    signed: Math.max(signed * Math.min(sx, sy), stem.signed),
    height: Math.max(clamp((1 - radius) * 1.25 + 0.12), stem.height * 0.3),
    vein: Math.max(stem.height, Math.max(midrib, sideVeins * 0.72))
  };
}

function createLeafFields(spec) {
  const size = TEXTURE_SIZE;
  const count = size * size;
  const alpha = new Float32Array(count);
  const height = new Float32Array(count);
  const vein = new Float32Array(count);
  const segments = spraySegments(spec.leafGenerator, spec.seed);
  const isSpray = segments.length > 0;
  const aa = 2.2 / size;

  for (let py = 0; py < size; py++) {
    const y = 1 - ((py + 0.5) / size) * 2;
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size) * 2 - 1;
      const index = py * size + px;
      let signed = -1;
      let h = 0;
      let v = 0;
      if (isSpray) {
        for (const segment of segments) {
          const field = distanceToSegment(x, y, segment);
          if (field.signed > signed) signed = field.signed;
          h = Math.max(h, field.height * (segment.role === "vein" ? 0.55 : 1));
          if (segment.role === "vein") v = Math.max(v, field.height);
        }
      } else {
        const field = broadleafField(spec.leafGenerator, x, y);
        signed = field.signed;
        h = field.height;
        v = field.vein;
      }
      alpha[index] = smoothstep(-aa, aa, signed);
      height[index] = h * alpha[index];
      vein[index] = v * alpha[index];
    }
  }
  return { alpha, height, vein, width: size, heightPx: size };
}

function createLeafImages(spec, fields, palette) {
  const { alpha, height, vein, width, heightPx } = fields;
  const count = width * heightPx;
  const color = Buffer.allocUnsafe(count * 4);
  const surface = Buffer.allocUnsafe(count * 4);
  const [dark, light] = palette;
  const roughBase = spec.leafStyle.family === "broadleaf" ? 0.67 : 0.78;

  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const at = index * 4;
      const h = height[index];
      const v = vein[index];
      const noise = hash2(x, y, spec.seed + 41) - 0.5;
      const gradient = 0.25 + h * 0.68 + noise * 0.08 - v * 0.1;
      color[at] = Math.round(clamp(mix(dark[0], light[0], gradient), 0, 255));
      color[at + 1] = Math.round(clamp(mix(dark[1], light[1], gradient), 0, 255));
      color[at + 2] = Math.round(clamp(mix(dark[2], light[2], gradient), 0, 255));
      color[at + 3] = Math.round(alpha[index] * 255);

      const left = height[y * width + Math.max(0, x - 1)];
      const right = height[y * width + Math.min(width - 1, x + 1)];
      const up = height[Math.max(0, y - 1) * width + x];
      const down = height[Math.min(heightPx - 1, y + 1) * width + x];
      const nx = (left - right) * 13;
      const ny = (down - up) * 13;
      const invLength = 1 / Math.hypot(nx, ny, 1);
      surface[at] = Math.round((nx * invLength * 0.5 + 0.5) * 255);
      surface[at + 1] = Math.round((ny * invLength * 0.5 + 0.5) * 255);
      surface[at + 2] = Math.round(clamp(roughBase + noise * 0.09 - v * 0.1) * 255);
      surface[at + 3] = Math.round(
        clamp(spec.leafStyle.translucency * (0.55 + (1 - h) * 0.45) * (1 - v * 0.3) * alpha[index]) * 255
      );
    }
  }
  return {
    color: { data: color, width, height: heightPx, channels: 4 },
    surface: { data: surface, width, height: heightPx, channels: 4 }
  };
}

function barkField(styleName, u, v, seed) {
  const noise = fbm(u, v, seed);
  const fine = wrappedNoise(u, v, 32, seed + 317);
  if (styleName === "fibrous-redwood") {
    const ridges = Math.abs(Math.sin(TWO_PI * (u * 13 + noise * 1.5)));
    return clamp(0.2 + ridges * 0.62 + fine * 0.18);
  }
  if (styleName === "twisted-cypress") {
    const ridges = Math.abs(Math.sin(TWO_PI * (u * 8 + v * 0.8 + noise * 1.15)));
    return clamp(0.18 + ridges * 0.56 + fine * 0.24);
  }
  if (styleName === "blocky-oak") {
    const vertical = Math.abs(Math.sin(TWO_PI * (u * 7 + noise * 0.8)));
    const horizontal = Math.abs(Math.sin(TWO_PI * (v * 5 + noise * 0.45)));
    return clamp(0.12 + Math.min(vertical, horizontal) * 0.7 + fine * 0.18);
  }
  if (styleName === "mottled-eucalyptus") {
    const blotch = smoothstep(0.35, 0.72, wrappedNoise(u, v, 7, seed + 71));
    return clamp(0.34 + noise * 0.3 + blotch * 0.28);
  }
  if (styleName === "plated-black-pine") {
    const cells = Math.abs(Math.sin(TWO_PI * (u * 6 + noise))) * Math.abs(Math.sin(TWO_PI * (v * 7 + noise * 0.7)));
    return clamp(0.12 + Math.sqrt(cells) * 0.72 + fine * 0.16);
  }
  if (styleName === "lenticel-cherry") {
    const row = Math.floor(v * 20);
    const rowY = (row + 0.5 + (hash2(row, 2, seed) - 0.5) * 0.45) / 20;
    const dash = Math.pow(Math.max(0, Math.cos(TWO_PI * (u * 8 + hash2(row, 4, seed)))), 22);
    const lenticel = Math.exp(-Math.abs(v - rowY) * 520) * dash;
    return clamp(0.38 + noise * 0.3 + lenticel * 0.32);
  }
  if (styleName === "furrowed-ginkgo") {
    const groove = Math.abs(Math.sin(TWO_PI * (u * 10 + noise * 0.95)));
    return clamp(0.18 + groove * 0.58 + fine * 0.24);
  }
  if (styleName === "ringed-palm") {
    const rings = Math.abs(Math.sin(TWO_PI * (v * 12 + noise * 0.25)));
    const scars = Math.abs(Math.sin(TWO_PI * (u * 5 + v * 6)));
    return clamp(0.18 + rings * 0.52 + scars * 0.13 + fine * 0.17);
  }
  // Smooth maple/magnolia bark keeps low-frequency form without looking flat.
  return clamp(0.28 + noise * 0.47 + fine * 0.2);
}

function createBarkImages(spec) {
  const size = TEXTURE_SIZE;
  const count = size * size;
  const field = new Float32Array(count);
  const color = Buffer.allocUnsafe(count * 3);
  const surface = Buffer.allocUnsafe(count * 3);
  const bark = spec.bark;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      field[index] = barkField(bark.generator, x / size, y / size, spec.seed + 809);
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const colorAt = index * 3;
      const h = field[index];
      const tintNoise = hash2(x, y, spec.seed + 997) - 0.5;
      const tone = clamp(h * 0.87 + tintNoise * 0.08);
      for (let channel = 0; channel < 3; channel++) {
        color[colorAt + channel] = Math.round(mix(bark.dark[channel], bark.light[channel], tone));
      }
      const left = field[y * size + ((x - 1 + size) % size)];
      const right = field[y * size + ((x + 1) % size)];
      const up = field[((y - 1 + size) % size) * size + x];
      const down = field[((y + 1) % size) * size + x];
      const nx = (left - right) * 9 * bark.normalStrength;
      const ny = (down - up) * 9 * bark.normalStrength;
      const invLength = 1 / Math.hypot(nx, ny, 1);
      surface[colorAt] = Math.round((nx * invLength * 0.5 + 0.5) * 255);
      surface[colorAt + 1] = Math.round((ny * invLength * 0.5 + 0.5) * 255);
      surface[colorAt + 2] = Math.round(clamp(bark.roughness + (0.5 - h) * 0.12 + tintNoise * 0.05) * 255);
    }
  }
  return {
    color: { data: color, width: size, height: size, channels: 3 },
    surface: { data: surface, width: size, height: size, channels: 3 }
  };
}

function publicUri(filePath) {
  return `/${path.relative(path.join(ROOT, "public"), filePath).split(path.sep).join("/")}`;
}

function mipDimensions(width, height) {
  const out = [];
  let w = width;
  let h = height;
  while (true) {
    out.push([w, h]);
    if (w === 1 && h === 1) break;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
  return out;
}

function alphaCoverage(data, channels, cutoffByte) {
  let covered = 0;
  for (let i = channels - 1; i < data.length; i += channels) if (data[i] >= cutoffByte) covered++;
  return covered / (data.length / channels);
}

function preserveAlphaCoverage(data, channels, targetCoverage, cutoff) {
  const cutoffByte = Math.round(cutoff * 255);
  const count = data.length / channels;
  let bestScale = 1;
  let bestDelta = Math.abs(alphaCoverage(data, channels, cutoffByte) - targetCoverage);
  let low = 0;
  let high = 8;
  for (let step = 0; step < 28; step++) {
    const scale = (low + high) * 0.5;
    let covered = 0;
    for (let i = channels - 1; i < data.length; i += channels) {
      if (Math.min(255, Math.round(data[i] * scale)) >= cutoffByte) covered++;
    }
    const coverage = covered / count;
    const delta = Math.abs(coverage - targetCoverage);
    if (delta < bestDelta || (delta === bestDelta && Math.abs(scale - 1) < Math.abs(bestScale - 1))) {
      bestDelta = delta;
      bestScale = scale;
    }
    if (coverage < targetCoverage) low = scale;
    else high = scale;
  }
  for (let i = channels - 1; i < data.length; i += channels) data[i] = Math.min(255, Math.round(data[i] * bestScale));
}

async function writeMipChain({ data, width, height, channels, directory, coverageCutoff = null }) {
  await fs.mkdir(directory, { recursive: true });
  const dimensions = mipDimensions(width, height);
  const files = [];
  const targetCoverage = coverageCutoff === null ? null : alphaCoverage(data, channels, Math.round(coverageCutoff * 255));
  for (let level = 0; level < dimensions.length; level++) {
    const [mipWidth, mipHeight] = dimensions[level];
    let mipData;
    if (level === 0) mipData = Buffer.from(data);
    else {
      mipData = (await sharp(data, { raw: { width, height, channels } })
        .resize(mipWidth, mipHeight, { kernel: sharp.kernel.lanczos3, fastShrinkOnLoad: false })
        .raw({ depth: "uchar" })
        .toBuffer({ resolveWithObject: true })).data;
    }
    if (targetCoverage !== null && level > 0) preserveAlphaCoverage(mipData, channels, targetCoverage, coverageCutoff);
    const filePath = path.join(directory, `mip-${String(level).padStart(2, "0")}.png`);
    await sharp(mipData, { raw: { width: mipWidth, height: mipHeight, channels } })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toFile(filePath);
    files.push(filePath);
  }
  return { files, levels: dimensions.length, targetCoverage };
}

async function encodeKtx2({ output, mipFiles, colorSpace, targetType, codec }) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const args = [
    "--encode", codec,
    "--threads", "1",
    "--mipmap",
    // Native foliage cards use v=0 at the branch/base and v=1 at the tip.
    // PNG row 0 contains the authored tip, so flip to lower-left storage: the
    // KTX2Loader keeps flipY=false and WebGPU then samples the base at t=0.
    "--lower_left_maps_to_s0t0",
    "--target_type", targetType,
    "--assign_oetf", colorSpace === "srgb" ? "srgb" : "linear",
    "--assign_primaries", colorSpace === "srgb" ? "srgb" : "none"
  ];
  if (codec === "uastc") {
    args.push("--uastc_quality", "2", "--uastc_rdo_l", colorSpace === "srgb" ? "0.75" : "0.5", "--uastc_rdo_m", "--zcmp", "18");
  } else {
    args.push("--clevel", "5", "--qlevel", "192");
  }
  args.push(output, ...mipFiles);
  await execFileAsync(TOKTX, args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  await execFileAsync(KTX2CHECK, ["-q", output], { cwd: ROOT });
  await assertKtxUvOrientation(output);
}

async function assertKtxUvOrientation(filePath) {
  const { stdout } = await execFileAsync(KTXINFO, [filePath], { cwd: ROOT, maxBuffer: 4 * 1024 * 1024 });
  if (!/KTXorientation:\s*ru\b/.test(stdout)) {
    throw new Error(`Leaf/base UV contract requires KTXorientation ru: ${filePath}`);
  }
}

async function fileDigest(filePath) {
  const data = await fs.readFile(filePath);
  return { bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") };
}

async function compileTexture({ spec, name, image, colorSpace, channels, codec, coverageCutoff = null, generator }) {
  const workDir = path.join(WORK_ROOT, spec.id, name);
  const temporaryOutput = path.join(OUTPUT_ROOT, "materials", spec.id, `${name}.ktx2`);
  const mipChain = await writeMipChain({ ...image, directory: workDir, coverageCutoff });
  await encodeKtx2({ output: temporaryOutput, mipFiles: mipChain.files, colorSpace, targetType: channels === 4 ? "RGBA" : "RGB", codec });
  const digest = await fileDigest(temporaryOutput);
  const output = path.join(OUTPUT_ROOT, "materials", spec.id, `${name}-${digest.sha256.slice(0, 16)}.ktx2`);
  await fs.rename(temporaryOutput, output);
  const uncompressedMipBytes = mipDimensions(image.width, image.height)
    .reduce((bytes, [width, height]) => bytes + width * height * channels, 0);
  return {
    uri: publicUri(output),
    colorSpace,
    channels: channels === 4 ? "rgba" : "rgb",
    codec,
    width: image.width,
    height: image.height,
    mipLevels: mipChain.levels,
    orientation: "S=r,T=u",
    bytes: digest.bytes,
    sha256: digest.sha256,
    uncompressedMipBytes,
    provenance: { kind: "procedural", generator, seed: spec.seed },
    ...(coverageCutoff === null ? {} : {
      alphaMode: "cutout",
      alphaCutoff: coverageCutoff,
      alphaCoverage: Number(mipChain.targetCoverage.toFixed(6)),
      mipPolicy: "coverage-preserving-lanczos3"
    })
  };
}

async function compileMaterialSet(spec) {
  const leafFields = createLeafFields(spec);
  const defaultLeaf = createLeafImages(spec, leafFields, spec.palettes.default);
  const barkImages = createBarkImages(spec);
  const textures = {
    leaf: {
      color: await compileTexture({
        spec, name: "leaf-color", image: defaultLeaf.color, colorSpace: "srgb", channels: 4, codec: "uastc",
        coverageCutoff: spec.leafStyle.alphaCutoff, generator: `leaf:${spec.leafGenerator}:color`
      }),
      surface: await compileTexture({
        spec, name: "leaf-surface", image: defaultLeaf.surface, colorSpace: "linear", channels: 4, codec: "uastc",
        generator: `leaf:${spec.leafGenerator}:normalXY-roughness-translucency`
      })
    },
    bark: {
      color: await compileTexture({
        spec, name: "bark-color", image: barkImages.color, colorSpace: "srgb", channels: 3, codec: "etc1s",
        generator: `bark:${spec.bark.generator}:color`
      }),
      surface: await compileTexture({
        spec, name: "bark-surface", image: barkImages.surface, colorSpace: "linear", channels: 3, codec: "uastc",
        generator: `bark:${spec.bark.generator}:normalXY-roughness`
      })
    }
  };

  const variants = Object.entries(spec.palettes).filter(([name]) => name !== "default");
  if (variants.length) {
    textures.leaf.colorVariants = {};
    for (const [name, palette] of variants) {
      const image = createLeafImages(spec, leafFields, palette).color;
      textures.leaf.colorVariants[name] = await compileTexture({
        spec, name: `leaf-color-${name}`, image, colorSpace: "srgb", channels: 4, codec: "uastc",
        coverageCutoff: spec.leafStyle.alphaCutoff, generator: `leaf:${spec.leafGenerator}:color:${name}`
      });
    }
  }

  return {
    // Only shader-owned controls live beside texture data. Card dimensions,
    // wind stiffness and bark UV scale are canonical native recipe controls.
    leafStyle: {
      alphaCutoff: spec.leafStyle.alphaCutoff,
      translucency: spec.leafStyle.translucency,
      twoSided: spec.leafStyle.twoSided
    },
    textures
  };
}

function collectTextureEntries(value, entries = []) {
  if (!value || typeof value !== "object") return entries;
  if (typeof value.uri === "string" && value.uri.endsWith(".ktx2")) entries.push(value);
  for (const child of Object.values(value)) collectTextureEntries(child, entries);
  return entries;
}

async function installBasisTranscoder() {
  const destination = path.join(OUTPUT_ROOT, BASIS_RELEASE);
  await fs.mkdir(destination, { recursive: true });
  await Promise.all(BASIS_FILES.map((name) => fs.copyFile(
    path.join(BASIS_SOURCE_ROOT, name),
    path.join(destination, name)
  )));
}

async function assertBasisTranscoder() {
  for (const name of BASIS_FILES) {
    const [source, output] = await Promise.all([
      fs.readFile(path.join(BASIS_SOURCE_ROOT, name)),
      fs.readFile(path.join(OUTPUT_ROOT, BASIS_RELEASE, name))
    ]);
    if (!source.equals(output)) throw new Error(`Basis transcoder mismatch: ${name}`);
  }
}

async function checkExisting() {
  const manifestPath = path.join(OUTPUT_ROOT, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const entries = collectTextureEntries(manifest.materialSets);
  for (const entry of entries) {
    const filePath = path.join(ROOT, "public", entry.uri.slice(1));
    await execFileAsync(KTX2CHECK, ["-q", filePath], { cwd: ROOT });
    if (entry.orientation !== "S=r,T=u") throw new Error(`Manifest UV orientation mismatch: ${entry.uri}`);
    await assertKtxUvOrientation(filePath);
    const digest = await fileDigest(filePath);
    if (digest.bytes !== entry.bytes || digest.sha256 !== entry.sha256) throw new Error(`Manifest digest mismatch: ${entry.uri}`);
  }
  await assertBasisTranscoder();
  console.log(`[native-foliage] validated ${entries.length} KTX2 files, manifest digests, and ${BASIS_RELEASE}`);
}

async function build() {
  await fs.rm(WORK_ROOT, { recursive: true, force: true });
  await fs.rm(OUTPUT_ROOT, { recursive: true, force: true });
  await fs.mkdir(WORK_ROOT, { recursive: true });
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  await installBasisTranscoder();

  const materialSets = {};
  for (const spec of MATERIAL_SETS) {
    console.log(`[native-foliage] compiling ${spec.id}`);
    materialSets[spec.id] = await compileMaterialSet(spec);
  }

  const manifest = {
    schemaVersion: 1,
    generator: "tools/build-native-foliage-textures.mjs",
    sourcePolicy: "deterministic-procedural-no-vendor-dependency",
    contract: {
      textureFormat: "KTX2 / Basis Universal",
      basisTranscoder: `/native-foliage/${BASIS_RELEASE}/`,
      uvOrigin: "lower-left; foliage v=0 is branch/base and v=1 is tip",
      colorAlpha: { colorSpace: "srgb", channels: { rgb: "baseColor", a: "opacity" } },
      leafSurface: {
        colorSpace: "linear",
        channels: { r: "normal.x", g: "normal.y", b: "roughness", a: "translucency" },
        normalDecode: "xy = rg * 2 - 1; z = sqrt(max(0, 1 - dot(xy, xy)))"
      },
      barkSurface: {
        colorSpace: "linear",
        channels: { r: "normal.x", g: "normal.y", b: "roughness" },
        normalDecode: "xy = rg * 2 - 1; z = sqrt(max(0, 1 - dot(xy, xy)))"
      }
    },
    aliases: { native: NATIVE_ALIASES },
    materialSets
  };
  const manifestPath = path.join(OUTPUT_ROOT, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const entries = collectTextureEntries(materialSets);
  const outputBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const rawBytes = entries.reduce((sum, entry) => sum + entry.uncompressedMipBytes, 0);
  console.log(`[native-foliage] wrote ${entries.length} KTX2 files (${(outputBytes / 1048576).toFixed(2)} MiB)`);
  console.log(`[native-foliage] packed source mip payload: ${(rawBytes / 1048576).toFixed(2)} MiB (${(rawBytes / outputBytes).toFixed(1)}x encoded size)`);
  console.log(`[native-foliage] manifest ${publicUri(manifestPath)}`);
  if (!KEEP_INTERMEDIATE) await fs.rm(WORK_ROOT, { recursive: true, force: true });
  else console.log(`[native-foliage] kept source/mip intermediates at ${WORK_ROOT}`);
}

try {
  if (CHECK_ONLY) await checkExisting();
  else await build();
} catch (error) {
  console.error(`[native-foliage] ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
}
