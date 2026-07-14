#!/usr/bin/env node

/**
 * Build a geographically registered control image for the GPT-painted
 * historical map pilot. The output is intentionally plain: categorical terrain
 * plus the exact runtime road graph. It is an image-editing constraint, not a
 * shipped game asset.
 */

import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = new URL("../", import.meta.url);
const DETAIL = process.argv.includes("--detail");
const OUT = new URL(
  DETAIL
    ? "../.data/historical-map-pilot/control-golden-gate-detail.png"
    : "../.data/historical-map-pilot/control.png",
  import.meta.url
);

// Portrait slice containing Lands End, the Presidio, and Golden Gate Park.
// The 2:3 world aspect exactly matches the control image aspect.
export const PILOT_BOUNDS = Object.freeze(
  DETAIL
    ? {
        // 500 × 750 m detail tile centred on the Golden Gate main span.
        minX: -3232,
        maxX: -2732,
        minZ: -3172.5,
        maxZ: -2422.5
      }
    : {
        minX: -5800,
        maxX: -1600,
        minZ: -3900,
        maxZ: 2400
      }
);

const WIDTH = 1536;
const HEIGHT = 2304;
const WORLD_W = PILOT_BOUNDS.maxX - PILOT_BOUNDS.minX;
const WORLD_H = PILOT_BOUNDS.maxZ - PILOT_BOUNDS.minZ;

function screenX(x) {
  return ((x - PILOT_BOUNDS.minX) / WORLD_W) * WIDTH;
}

function screenY(z) {
  return ((z - PILOT_BOUNDS.minZ) / WORLD_H) * HEIGHT;
}

function pathFor(points) {
  let d = "";
  for (let i = 0; i < points.length; i += 2) {
    const command = i === 0 ? "M" : "L";
    d += `${command}${screenX(points[i] / 10).toFixed(2)} ${screenY(points[i + 1] / 10).toFixed(2)}`;
  }
  return d;
}

function segmentVisible(points) {
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
  return !(
    maxX < PILOT_BOUNDS.minX - 100 ||
    minX > PILOT_BOUNDS.maxX + 100 ||
    maxZ < PILOT_BOUNDS.minZ - 100 ||
    minZ > PILOT_BOUNDS.maxZ + 100
  );
}

async function main() {
  const meta = JSON.parse(await readFile(new URL("public/data/meta.json", ROOT), "utf8"));
  const surface = new Uint8Array(await readFile(new URL("public/data/surface.bin", ROOT)));
  const encodedHeight = new Int16Array(
    (await readFile(new URL("public/data/heightmap.bin", ROOT))).buffer
  );
  const roads = JSON.parse(await readFile(new URL("public/data/roads.json", ROOT), "utf8"));
  const grid = meta.grid;
  const terrain = meta.terrain;
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);

  const sampleHeight = (gx, gy) => {
    const x = Math.max(0, Math.min(grid.width - 1, gx));
    const y = Math.max(0, Math.min(grid.height - 1, gy));
    const v = encodedHeight[y * grid.width + x];
    return terrain ? terrain.heightBase + v * terrain.heightQuant : v;
  };

  for (let py = 0; py < HEIGHT; py++) {
    const z = PILOT_BOUNDS.minZ + ((py + 0.5) / HEIGHT) * WORLD_H;
    const gy = Math.max(0, Math.min(grid.height - 1, Math.floor((z - grid.minZ) / grid.cellSize)));
    for (let px = 0; px < WIDTH; px++) {
      const x = PILOT_BOUNDS.minX + ((px + 0.5) / WIDTH) * WORLD_W;
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
      const o = (py * WIDTH + px) * 4;
      rgba[o] = Math.round(color[0] * shade);
      rgba[o + 1] = Math.round(color[1] * shade);
      rgba[o + 2] = Math.round(color[2] * shade);
      rgba[o + 3] = 255;
    }
  }

  const visibleRoads = roads.segs.filter((seg) => segmentVisible(seg.p));
  const casing = [];
  const ink = [];
  for (const seg of visibleRoads) {
    const d = pathFor(seg.p);
    const roadPx = Math.max(1.2, (seg.w / WORLD_W) * WIDTH);
    casing.push(`<path d="${d}" stroke="#4b4031" stroke-width="${(roadPx + 2.2).toFixed(2)}"/>`);
    ink.push(`<path d="${d}" stroke="#ead9b7" stroke-width="${roadPx.toFixed(2)}"/>`);
  }

  const bridgePaths = [];
  for (const bridge of meta.bridges) {
    const points = bridge.line.flatMap(([x, z]) => [x * 10, z * 10]);
    if (!segmentVisible(points)) continue;
    bridgePaths.push(
      `<path d="${pathFor(points)}" stroke="#bb5a31" stroke-width="${Math.max(4, (bridge.width / WORLD_W) * WIDTH).toFixed(2)}"/>`
    );
  }

  const overlay = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
      <g fill="none" stroke-linecap="round" stroke-linejoin="round">
        ${casing.join("\n")}
        ${ink.join("\n")}
        ${bridgePaths.join("\n")}
      </g>
    </svg>
  `);

  await mkdir(new URL("../.data/historical-map-pilot/", import.meta.url), { recursive: true });
  await sharp(rgba, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
    .composite([{ input: overlay }])
    .png()
    .toFile(fileURLToPath(OUT));

  console.log(fileURLToPath(OUT));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
