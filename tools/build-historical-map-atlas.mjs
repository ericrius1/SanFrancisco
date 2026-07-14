#!/usr/bin/env node

/**
 * Build geographically registered control plates for the city-wide historical
 * map atlas. These are image-generation constraints, not runtime assets.
 *
 * Pyramid:
 *   - one full-world overview control
 *   - a 3 x 3 regional level with a small bleed around every core tile
 *
 * The bleed gives generated ink/paper texture room to feather across adjacent
 * plates while the manifest keeps the exact world registration for runtime.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = new URL("../", import.meta.url);
const OUT_DIR = new URL("../.data/historical-map-atlas/", import.meta.url);
const COLS = 3;
const ROWS = 3;
const BLEED_FRACTION = 0.055;
const CONTROL_WIDTH = 1536;

function intersects(a, b, margin = 0) {
  return !(
    a.maxX < b.minX - margin ||
    a.minX > b.maxX + margin ||
    a.maxZ < b.minZ - margin ||
    a.minZ > b.maxZ + margin
  );
}

function segmentBounds(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i] / 10;
    const z = points[i + 1] / 10;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ };
}

async function renderControl({ id, bounds, coreBounds, meta, surface, encodedHeight, roads }) {
  const worldW = bounds.maxX - bounds.minX;
  const worldH = bounds.maxZ - bounds.minZ;
  const width = CONTROL_WIDTH;
  const height = Math.max(512, Math.round(width * (worldH / worldW)));
  const rgba = Buffer.alloc(width * height * 4);
  const grid = meta.grid;
  const terrain = meta.terrain;

  const sampleHeight = (gx, gy) => {
    const x = Math.max(0, Math.min(grid.width - 1, gx));
    const y = Math.max(0, Math.min(grid.height - 1, gy));
    const v = encodedHeight[y * grid.width + x];
    return terrain ? terrain.heightBase + v * terrain.heightQuant : v;
  };
  const screenX = (x) => ((x - bounds.minX) / worldW) * width;
  const screenY = (z) => ((z - bounds.minZ) / worldH) * height;
  const pathFor = (points) => {
    let d = "";
    for (let i = 0; i < points.length; i += 2) {
      d += `${i === 0 ? "M" : "L"}${screenX(points[i] / 10).toFixed(2)} ${screenY(points[i + 1] / 10).toFixed(2)}`;
    }
    return d;
  };

  for (let py = 0; py < height; py++) {
    const z = bounds.minZ + ((py + 0.5) / height) * worldH;
    const gy = Math.max(0, Math.min(grid.height - 1, Math.floor((z - grid.minZ) / grid.cellSize)));
    for (let px = 0; px < width; px++) {
      const x = bounds.minX + ((px + 0.5) / width) * worldW;
      const gx = Math.max(0, Math.min(grid.width - 1, Math.floor((x - grid.minX) / grid.cellSize)));
      const i = gy * grid.width + gx;
      const h = sampleHeight(gx, gy);
      const hx = sampleHeight(gx + 1, gy) - h;
      const hz = sampleHeight(gx, gy + 1) - h;
      const shade = Math.max(0.72, Math.min(1.18, 1 - (hx + hz) * 0.018));
      const s = surface[i];
      let color;
      if (s === 3) color = [57, 121, 139];
      else if (s === 1) color = [113, 137, 87];
      else if (s === 2) color = [185, 158, 107];
      else color = [177, 164, 139];
      const o = (py * width + px) * 4;
      rgba[o] = Math.round(color[0] * shade);
      rgba[o + 1] = Math.round(color[1] * shade);
      rgba[o + 2] = Math.round(color[2] * shade);
      rgba[o + 3] = 255;
    }
  }

  const casing = [];
  const ink = [];
  for (const seg of roads.segs) {
    if (!intersects(segmentBounds(seg.p), bounds, 100)) continue;
    const d = pathFor(seg.p);
    const roadPx = Math.max(1.05, (seg.w / worldW) * width);
    casing.push(`<path d="${d}" stroke="#4b4031" stroke-width="${(roadPx + 2).toFixed(2)}"/>`);
    ink.push(`<path d="${d}" stroke="#ead9b7" stroke-width="${roadPx.toFixed(2)}"/>`);
  }

  const bridges = [];
  for (const bridge of meta.bridges) {
    const points = bridge.line.flatMap(([x, z]) => [x * 10, z * 10]);
    if (!intersects(segmentBounds(points), bounds, 100)) continue;
    bridges.push(
      `<path d="${pathFor(points)}" stroke="#bb5a31" stroke-width="${Math.max(3.5, (bridge.width / worldW) * width).toFixed(2)}"/>`
    );
  }

  const overlay = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <g fill="none" stroke-linecap="round" stroke-linejoin="round">
        ${casing.join("\n")}
        ${ink.join("\n")}
        ${bridges.join("\n")}
      </g>
    </svg>
  `);
  const filename = `control-${id}.png`;
  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .composite([{ input: overlay }])
    .png()
    .toFile(fileURLToPath(new URL(filename, OUT_DIR)));

  return { id, control: filename, bounds, coreBounds, width, height };
}

async function main() {
  const meta = JSON.parse(await readFile(new URL("public/data/meta.json", ROOT), "utf8"));
  const surface = new Uint8Array(await readFile(new URL("public/data/surface.bin", ROOT)));
  const heightBytes = await readFile(new URL("public/data/heightmap.bin", ROOT));
  const encodedHeight = new Int16Array(
    heightBytes.buffer,
    heightBytes.byteOffset,
    heightBytes.byteLength / Int16Array.BYTES_PER_ELEMENT
  );
  const roads = JSON.parse(await readFile(new URL("public/data/roads.json", ROOT), "utf8"));
  const g = meta.grid;
  const world = {
    minX: g.minX,
    maxX: g.minX + g.width * g.cellSize,
    minZ: g.minZ,
    maxZ: g.minZ + g.height * g.cellSize
  };
  const tileW = (world.maxX - world.minX) / COLS;
  const tileH = (world.maxZ - world.minZ) / ROWS;
  await mkdir(OUT_DIR, { recursive: true });

  const overview = await renderControl({
    id: "overview",
    bounds: world,
    coreBounds: world,
    meta,
    surface,
    encodedHeight,
    roads
  });
  const regions = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const coreBounds = {
        minX: world.minX + col * tileW,
        maxX: world.minX + (col + 1) * tileW,
        minZ: world.minZ + row * tileH,
        maxZ: world.minZ + (row + 1) * tileH
      };
      const bleedX = tileW * BLEED_FRACTION;
      const bleedZ = tileH * BLEED_FRACTION;
      const bounds = {
        minX: Math.max(world.minX, coreBounds.minX - bleedX),
        maxX: Math.min(world.maxX, coreBounds.maxX + bleedX),
        minZ: Math.max(world.minZ, coreBounds.minZ - bleedZ),
        maxZ: Math.min(world.maxZ, coreBounds.maxZ + bleedZ)
      };
      regions.push(
        await renderControl({
          id: `r${row}-c${col}`,
          bounds,
          coreBounds,
          meta,
          surface,
          encodedHeight,
          roads
        })
      );
    }
  }

  const manifest = {
    version: 1,
    grid: { cols: COLS, rows: ROWS, bleedFraction: BLEED_FRACTION },
    world,
    overview,
    regions
  };
  await writeFile(new URL("control-manifest.json", OUT_DIR), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(fileURLToPath(OUT_DIR));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
