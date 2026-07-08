// Surgical patch: stamp road ribbons into surface.bin as a new surface class so
// ground-cover (wildlands grass + wildflower ring, botanical grass) stops growing
// ON the streets. Roads are NOT part of the baked surface grid — prepare-city
// rasterizes only water/green/sand, and builds roads as separate tile geometry —
// so every grass gate that keys on surfaceType was blind to them and planted grass
// straight down the middle of the asphalt (worst in the Presidio, whose plant
// classes include developed ground 0, and on any park path in class-1 green).
//
// This reads the SAME roads.json + ROAD_WIDTH the bake uses, sweeps each road as a
// width-w ribbon, and flips the covered land cells (classes 0/1 only — leaves
// water 3 and sand 2 alone) to ROAD_CLASS. Re-runnable; only touches surface.bin.
//
//   node tools/mark-roads-surface.mjs
//
// After running, reload the app: WorldMap.load() picks up the new bytes and the
// grass/flower gates (src/world/wildlands/layout.ts grassyGround) skip ROAD_CLASS.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { GRID, lonLatToLocal } from "./geo.mjs";

const { width: W, height: H, cellSize: CELL, minX: MINX, minZ: MINZ } = GRID;

// road class written into surface.bin. Distinct from 0 developed / 1 green /
// 2 sand / 3 water. No runtime consumer keys on a value this high, so it reads as
// "not plantable, not water" everywhere (minimap lumps it with developed grey).
export const ROAD_CLASS = 4;

// carriageway widths — MUST match tools/prepare-city.mjs so the mask lines up with
// the visible asphalt ribbons.
const ROAD_WIDTH = {
  motorway: 19,
  trunk: 16,
  primary: 14,
  secondary: 11,
  tertiary: 9,
  residential: 7.5,
  unclassified: 7,
  living_street: 6,
  pedestrian: 4.5,
  motorway_link: 9,
  trunk_link: 8,
  primary_link: 8,
  secondary_link: 7,
  tertiary_link: 7
};

const EDGE_PAD = 1.5; // widen the mask past the curb a touch so no blades poke onto the shoulder

const RAW = new URL("../data/raw/", import.meta.url);
// write every copy the app might serve: public (vite dev source of truth) + dist
// (an already-built bundle) so live + headless agree.
const TARGETS = [
  new URL("../public/data/surface.bin", import.meta.url),
  new URL("../dist/data/surface.bin", import.meta.url)
];

const idx = (gx, gy) => gy * W + gx;

/** Scanline-fill a convex quad [[x,z]*4] (local metres), calling fn(gx,gy) per cell. */
function rasterizeQuad(quad, fn) {
  let minZ = Infinity, maxZ = -Infinity;
  for (const [, z] of quad) {
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const gy0 = Math.max(0, Math.floor((minZ - MINZ) / CELL));
  const gy1 = Math.min(H - 1, Math.ceil((maxZ - MINZ) / CELL));
  for (let gy = gy0; gy <= gy1; gy++) {
    const zc = MINZ + (gy + 0.5) * CELL;
    const xs = [];
    for (let i = 0; i < quad.length; i++) {
      const [x1, z1] = quad[i];
      const [x2, z2] = quad[(i + 1) % quad.length];
      if (z1 === z2) continue;
      if ((zc >= z1 && zc < z2) || (zc >= z2 && zc < z1)) {
        xs.push(x1 + ((zc - z1) / (z2 - z1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const gx0 = Math.max(0, Math.floor((xs[k] - MINX) / CELL));
      const gx1 = Math.min(W - 1, Math.ceil((xs[k + 1] - MINX) / CELL));
      for (let gx = gx0; gx <= gx1; gx++) fn(gx, gy);
    }
  }
}

async function main() {
  const surface = new Uint8Array((await readFile(new URL("../public/data/surface.bin", import.meta.url))).buffer.slice(0));
  if (surface.length !== W * H) throw new Error(`surface.bin size ${surface.length} != ${W * H}`);

  const json = JSON.parse(await readFile(new URL("roads.json", RAW), "utf8"));
  let ways = 0, flipped = 0;

  const stamp = (gx, gy) => {
    const i = idx(gx, gy);
    const s = surface[i];
    if (s === 0 || s === 1) {
      // only re-class grass-bearing land (developed / green); leave sand + water
      surface[i] = ROAD_CLASS;
      flipped++;
    }
  };

  for (const el of json.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const width = ROAD_WIDTH[tags.highway];
    if (!width) continue;
    if (tags.bridge === "yes" || tags.bridge === "viaduct") continue; // elevated: don't mask the ground below
    ways++;
    const pts = el.geometry.map((g) => lonLatToLocal(g.lon, g.lat));
    const half = width / 2 + EDGE_PAD;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      let dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;
      dx /= len; dz /= len;
      const nx = -dz, nz = dx; // left normal
      // Extend only at INTERIOR joints (shared vertices) by `half` so consecutive
      // segments overlap and the bend wedge fills — but NOT past the polyline's true
      // termini, which would stub grass-free stumps into intersections/plazas.
      const ext0 = i > 0 ? half : 0;
      const ext1 = i < pts.length - 2 ? half : 0;
      const a0x = ax - dx * ext0, a0z = az - dz * ext0;
      const b0x = bx + dx * ext1, b0z = bz + dz * ext1;
      rasterizeQuad(
        [
          [a0x + nx * half, a0z + nz * half],
          [b0x + nx * half, b0z + nz * half],
          [b0x - nx * half, b0z - nz * half],
          [a0x - nx * half, a0z - nz * half]
        ],
        stamp
      );
    }
  }

  for (const url of TARGETS) {
    if (!existsSync(url)) continue;
    await writeFile(url, surface);
    console.log(`[roads] wrote ${url.pathname}`);
  }
  console.log(`[roads] ${ways} road ways → ${flipped} cells re-classed to ${ROAD_CLASS} (${((flipped / (W * H)) * 100).toFixed(1)}% of grid)`);
}

main();
