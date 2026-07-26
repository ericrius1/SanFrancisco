// Surgical patch: make the shore below Sutro Baths read as a real coast.
//
// Looking out through the hall's ocean glass, three baked-data artefacts were
// doing the damage:
//
//  1. FLAT GREEN PADS ON THE SEA. The offshore rocks off Point Lobos are tagged
//     green in OSM, so prepare-city rasterized them into surface class 1 (park)
//     and then floor-clamped them to >= 0.6 m. Class 1 shades to 0x7aa163, which
//     against the neighbouring bay floor reads as olive; and because the water
//     shader discards its plane wherever the floor is above 0.55 m, the ocean
//     was cut away on top of them. The result was a scatter of flat lawn-green
//     blobs floating on the surface. The low ones are pure artefact and get
//     submerged; the tall ones are genuinely Seal Rocks and instead get
//     reclassified so they shade as rock rather than grass.
//
//  2. NO BEACH. The whole shore here is surface class 0 (developed grey), graded
//     toward rock by slope. There was exactly ONE sand cell in the transect
//     across the baths, because prepare-city's natural sand band only fires for
//     class-0 cells below 6 m and Sutro's coast is a bluff. So the hall sat on a
//     grey shelf that the ocean plane simply cut into. This stamps a sand apron
//     around the cove.
//
//  3. NO SURF LINE. The bake clamps the first wet cell to about -2 m, and the
//     water shader's shore foam only lives in 0.15..1.4 m of depth — a band a
//     couple of metres wide, then blurred away by the 16 m floor texture. This
//     lays a gentle nearshore ramp so that band becomes tens of metres wide and
//     the existing foam actually shows.
//
// Re-runnable and idempotent. That needs a real baseline rather than "read the
// current bytes and assume they are pristine": submerging the green pads adds
// water neighbours, which moves the offshore/mainland tests, which moves the
// waterline — so a naive second run derives different answers from its own
// output and the shore creeps. On first run the script therefore snapshots the
// window's untouched bytes to a sidecar under .data/ and derives every later run
// from that. Only surface.bin and heightmap.bin change.
//
//   node tools/patch-sutro-shoreline.mjs [--dry-run] [--revert]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const DRY = process.argv.includes("--dry-run");
const REVERT = process.argv.includes("--revert");
const BASELINE_DIR = new URL(".data/sutro-shoreline-baseline/", ROOT);

const meta = JSON.parse(await readFile(new URL("public/data/meta.json", ROOT), "utf8"));
const { width: W, height: H, cellSize: CELL, minX: MINX, minZ: MINZ } = meta.grid;
const { heightBase, heightQuant, heightEncoding } = meta.terrain;
if (heightEncoding !== "int16") throw new Error(`Unexpected height encoding ${heightEncoding}`);

const SURFACE_TARGETS = ["public/data/surface.bin", "dist/data/surface.bin"];
const HEIGHT_TARGETS = ["public/data/heightmap.bin", "dist/data/heightmap.bin"];

const WATER = 3;
const SAND = 2;
const GREEN = 1;
const DEVELOPED = 0;

// The window this script is allowed to touch: the cove and headland around the
// baths (world centre -6125, 1117). Nothing outside it is written, so the patch
// cannot disturb Ocean Beach to the south or the Golden Gate to the north.
const WINDOW = { minX: -6560, maxX: -6060, minZ: 940, maxZ: 1360 };

// Offshore green pads at or below this height are artefacts and get submerged.
// Above it they are real rock stacks and only get reclassified.
const ROCK_KEEP_HEIGHT = 3.0;
const SUBMERGE_TO = -1.45;

// Nearshore bathymetry ramp, metres of depth per cell going offshore. Replaces
// the bake's flat -2 m first cell so the shader's 0.15..1.4 m foam band is wide.
const NEARSHORE_RAMP = [-0.32, -0.85, -1.55, -2.4, -3.4];
// Sand apron: how many cells inland of the waterline to stamp, and the height
// ceiling above which we stop (so the bluff face stays rock, not beach).
const SAND_INLAND_CELLS = 5;
const SAND_MAX_HEIGHT = 9.0;

const gx0 = Math.max(0, Math.floor((WINDOW.minX - MINX) / CELL));
const gx1 = Math.min(W - 1, Math.ceil((WINDOW.maxX - MINX) / CELL));
const gy0 = Math.max(0, Math.floor((WINDOW.minZ - MINZ) / CELL));
const gy1 = Math.min(H - 1, Math.ceil((WINDOW.maxZ - MINZ) / CELL));
const idx = (gx, gy) => gy * W + gx;

const surface = new Uint8Array(await readFile(new URL(SURFACE_TARGETS[0], ROOT)));
const heightRaw = await readFile(new URL(HEIGHT_TARGETS[0], ROOT));
const heights = new Int16Array(
  heightRaw.buffer.slice(heightRaw.byteOffset, heightRaw.byteOffset + heightRaw.byteLength)
);
if (surface.length !== W * H || heights.length !== W * H) {
  throw new Error(`Grid mismatch: surface=${surface.length} heights=${heights.length} expected=${W * H}`);
}

const encode = (metres) => {
  const q = Math.round((metres - heightBase) / heightQuant);
  if (q < -32768 || q > 32767) throw new Error(`Height ${metres} out of int16 range`);
  return q;
};

// --- pristine baseline for the window ---------------------------------------
// Every decision below reads the BASELINE, never the values being written, and
// the baseline is the untouched bake rather than whatever is on disk now.
const winW = gx1 - gx0 + 1;
const winH = gy1 - gy0 + 1;
const baselineSurfaceUrl = new URL("surface-window.bin", BASELINE_DIR);
const baselineHeightUrl = new URL("height-window.bin", BASELINE_DIR);
const baselineMetaUrl = new URL("window.json", BASELINE_DIR);

const originalSurface = surface.slice();
const originalHeight = heights.slice();

const windowDescriptor = { window: WINDOW, gx0, gx1, gy0, gy1, winW, winH, grid: { W, H, CELL } };

if (existsSync(baselineSurfaceUrl) && existsSync(baselineHeightUrl)) {
  const savedMeta = JSON.parse(await readFile(baselineMetaUrl, "utf8"));
  if (JSON.stringify(savedMeta) !== JSON.stringify(windowDescriptor)) {
    throw new Error(
      "Baseline window does not match the current window/grid. Delete " +
      ".data/sutro-shoreline-baseline/ only if the terrain bake itself changed."
    );
  }
  const bs = new Uint8Array(await readFile(baselineSurfaceUrl));
  const bhRaw = await readFile(baselineHeightUrl);
  const bh = new Int16Array(bhRaw.buffer.slice(bhRaw.byteOffset, bhRaw.byteOffset + bhRaw.byteLength));
  if (bs.length !== winW * winH || bh.length !== winW * winH) {
    throw new Error("Corrupt shoreline baseline sidecar");
  }
  for (let row = 0; row < winH; row++) {
    for (let col = 0; col < winW; col++) {
      const dst = idx(gx0 + col, gy0 + row);
      originalSurface[dst] = bs[row * winW + col];
      originalHeight[dst] = bh[row * winW + col];
    }
  }
  console.log("using saved pristine baseline for the window");
} else if (!DRY) {
  const bs = new Uint8Array(winW * winH);
  const bh = new Int16Array(winW * winH);
  for (let row = 0; row < winH; row++) {
    for (let col = 0; col < winW; col++) {
      const src = idx(gx0 + col, gy0 + row);
      bs[row * winW + col] = originalSurface[src];
      bh[row * winW + col] = originalHeight[src];
    }
  }
  await mkdir(BASELINE_DIR, { recursive: true });
  await writeFile(baselineSurfaceUrl, bs);
  await writeFile(baselineHeightUrl, Buffer.from(bh.buffer, bh.byteOffset, bh.byteLength));
  await writeFile(baselineMetaUrl, JSON.stringify(windowDescriptor, null, 2));
  console.log("snapshotted pristine baseline for the window");
}

if (REVERT) {
  for (let row = 0; row < winH; row++) {
    for (let col = 0; col < winW; col++) {
      const dst = idx(gx0 + col, gy0 + row);
      surface[dst] = originalSurface[dst];
      heights[dst] = originalHeight[dst];
    }
  }
  if (!DRY) {
    await writeFile(new URL(SURFACE_TARGETS[0], ROOT), surface);
    await writeFile(
      new URL(HEIGHT_TARGETS[0], ROOT),
      Buffer.from(heights.buffer, heights.byteOffset, heights.byteLength)
    );
  }
  console.log(DRY ? "revert dry run" : "window reverted to the pristine bake");
  process.exit(0);
}

// Start from the baseline inside the window so a re-run rewrites the same bytes.
for (let row = 0; row < winH; row++) {
  for (let col = 0; col < winW; col++) {
    const dst = idx(gx0 + col, gy0 + row);
    surface[dst] = originalSurface[dst];
    heights[dst] = originalHeight[dst];
  }
}
const wasWater = (gx, gy) => originalSurface[idx(gx, gy)] === WATER;
const heightAt = (gx, gy) => heightBase + originalHeight[idx(gx, gy)] * heightQuant;

/**
 * The MAINLAND waterline for a row, walking in from the open sea.
 *
 * "First non-water cell" is not good enough: the rocks off Point Lobos are dry
 * cells sitting in open water, so that definition put the waterline out at an
 * islet and stamped a beach on top of it — tan pads floating on the sea, which
 * is the same artefact as the green ones, just repainted. The mainland is
 * distinguished by CONTINUITY: real shore has land carrying on inland behind it,
 * and no islet in this cove is 40 m wide.
 */
const MAINLAND_RUN = 5;
function mainlandWaterline(gy) {
  for (let gx = gx0; gx <= gx1; gx++) {
    if (wasWater(gx, gy) || heightAt(gx, gy) <= 0.4) continue;
    let run = 0;
    for (let step = 0; step < MAINLAND_RUN; step++) {
      const nx = gx + step;
      if (nx > gx1 || wasWater(nx, gy)) break;
      run++;
    }
    if (run >= MAINLAND_RUN) return gx;
  }
  return -1;
}

const waterlines = new Map();
for (let gy = gy0; gy <= gy1; gy++) waterlines.set(gy, mainlandWaterline(gy));

/**
 * Offshore = seaward of this row's mainland waterline.
 *
 * A neighbour count was the first attempt and it only cleared the EDGES of each
 * rock cluster: an interior cell of a 3-by-5 pad has no water neighbour at all,
 * so the middle of every pad survived as a green island ringed by the water it
 * had just been given. Position relative to the waterline has no such blind spot.
 */
function isOffshore(gx, gy) {
  const waterline = waterlines.get(gy);
  return waterline !== undefined && waterline >= 0 && gx < waterline;
}

const stats = {
  padsSubmerged: 0,
  rocksReclassified: 0,
  sandStamped: 0,
  nearshoreEased: 0,
  waterlineRows: 0
};

// --- 1. offshore green pads ------------------------------------------------
// A green cell counts as offshore when it has water on at least two sides: that
// distinguishes a rock in the sea from the green bluff top on land.
for (let gy = gy0; gy <= gy1; gy++) {
  for (let gx = gx0; gx <= gx1; gx++) {
    const i = idx(gx, gy);
    if (originalSurface[i] !== GREEN) continue;
    if (!isOffshore(gx, gy)) continue;
    const height = heightAt(gx, gy);
    if (height <= ROCK_KEEP_HEIGHT) {
      surface[i] = WATER;
      heights[i] = encode(SUBMERGE_TO);
      stats.padsSubmerged++;
    } else {
      // A real stack. Developed class shades grey and the terrain shader's
      // slope-rock mix takes it the rest of the way on the steep flanks.
      surface[i] = DEVELOPED;
      stats.rocksReclassified++;
    }
  }
}

// --- 2 & 3. waterline walk: sand apron inland, gentle ramp offshore --------
// Walk each row from the open sea eastward to the first land cell. That cell is
// the waterline; everything either side of it gets treated.
for (let gy = gy0; gy <= gy1; gy++) {
  const waterline = waterlines.get(gy) ?? -1;
  if (waterline < 0) continue;
  stats.waterlineRows++;

  // Sand inland of the waterline, while the ground stays low enough to be beach.
  for (let step = 0; step < SAND_INLAND_CELLS; step++) {
    const gx = waterline + step;
    if (gx > gx1) break;
    const i = idx(gx, gy);
    if (originalSurface[i] === WATER) continue;
    // Never paint a beach onto a rock standing in the sea.
    if (isOffshore(gx, gy)) continue;
    const height = heightAt(gx, gy);
    if (height > SAND_MAX_HEIGHT) break;
    // Developed grey, existing sand, and the mis-tagged green that covers the
    // rocks at this shoreline are all fair game. Anything else (a road ribbon at
    // class 4, water) is left alone.
    if (
      originalSurface[i] !== DEVELOPED &&
      originalSurface[i] !== SAND &&
      originalSurface[i] !== GREEN
    ) continue;
    if (surface[i] !== SAND) {
      surface[i] = SAND;
      stats.sandStamped++;
    }
  }

  // Gentle shelf going offshore from the waterline.
  for (let step = 0; step < NEARSHORE_RAMP.length; step++) {
    const gx = waterline - 1 - step;
    if (gx < gx0) break;
    const i = idx(gx, gy);
    if (!wasWater(gx, gy)) continue;
    const target = NEARSHORE_RAMP[step];
    const current = heightAt(gx, gy);
    // Only ever RAISE the floor toward the target; never dig a channel deeper
    // than the bake already made it.
    if (target > current) {
      heights[i] = encode(target);
      stats.nearshoreEased++;
    }
  }
}

console.log({
  window: WINDOW,
  cells: { gx: [gx0, gx1], gy: [gy0, gy1] },
  ...stats,
  dryRun: DRY
});

if (DRY) {
  console.log("dry run — nothing written");
} else {
  for (const target of SURFACE_TARGETS) {
    const url = new URL(target, ROOT);
    if (target.startsWith("dist/") && !existsSync(url)) continue;
    await writeFile(url, surface);
  }
  for (const target of HEIGHT_TARGETS) {
    const url = new URL(target, ROOT);
    if (target.startsWith("dist/") && !existsSync(url)) continue;
    await writeFile(url, Buffer.from(heights.buffer, heights.byteOffset, heights.byteLength));
  }
  console.log("surface.bin + heightmap.bin patched");
}
