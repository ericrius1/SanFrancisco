// Downloads AWS terrarium elevation tiles (z14) covering the bbox, stitches
// them, and resamples onto the regular local-meter GRID.
// Output: data/raw/heightmap-raw.bin (Float32 W*H) + data/raw/heightmap-meta.json
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { PNG } from "pngjs";
import { BBOX, GRID, latToTileY, lonToTileX, localToLonLat } from "./geo.mjs";

const Z = 14;
const OUT_DIR = new URL("../data/raw/", import.meta.url);
const TILE_DIR = new URL("terrain/", OUT_DIR);

async function fetchTile(x, y) {
  const cache = new URL(`${Z}-${x}-${y}.png`, TILE_DIR);
  if (await access(cache).then(() => true, () => false)) {
    return PNG.sync.read(await readFile(cache));
  }
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(cache, buf);
      return PNG.sync.read(buf);
    } catch (err) {
      console.warn(`[terrain] ${x},${y} attempt ${attempt + 1}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`terrain tile ${x},${y} failed`);
}

function decodeElevation(png, px, py) {
  const idx = (py * png.width + px) * 4;
  const r = png.data[idx];
  const g = png.data[idx + 1];
  const b = png.data[idx + 2];
  return r * 256 + g + b / 256 - 32768;
}

async function main() {
  await mkdir(TILE_DIR, { recursive: true });

  const x0 = Math.floor(lonToTileX(BBOX.west, Z));
  const x1 = Math.floor(lonToTileX(BBOX.east, Z));
  const y0 = Math.floor(latToTileY(BBOX.north, Z));
  const y1 = Math.floor(latToTileY(BBOX.south, Z));
  console.log(`[terrain] tiles x ${x0}..${x1}, y ${y0}..${y1} (${(x1 - x0 + 1) * (y1 - y0 + 1)} tiles)`);

  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const tiles = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      tiles.push(await fetchTile(tx, ty));
    }
  }
  console.log("[terrain] tiles downloaded, stitching");

  const stitchW = cols * 256;
  const stitchH = rows * 256;
  const stitched = new Float32Array(stitchW * stitchH);
  for (let i = 0; i < tiles.length; i++) {
    const png = tiles[i];
    const cx = (i % cols) * 256;
    const cy = Math.floor(i / cols) * 256;
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        stitched[(cy + py) * stitchW + (cx + px)] = decodeElevation(png, px, py);
      }
    }
  }

  // Resample to the regular local grid with bilinear filtering.
  const { width: W, height: H, cellSize, minX, minZ } = GRID;
  const out = new Float32Array(W * H);
  const scale = 2 ** Z;
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      const [lon, lat] = localToLonLat(minX + gx * cellSize, minZ + gy * cellSize);
      const fx = (lonToTileX(lon, Z) - x0) * 256;
      const fy = (latToTileY(lat, Z) - y0) * 256;
      const ix = Math.max(0, Math.min(stitchW - 2, Math.floor(fx)));
      const iy = Math.max(0, Math.min(stitchH - 2, Math.floor(fy)));
      const ax = Math.min(1, Math.max(0, fx - ix));
      const ay = Math.min(1, Math.max(0, fy - iy));
      const h00 = stitched[iy * stitchW + ix];
      const h10 = stitched[iy * stitchW + ix + 1];
      const h01 = stitched[(iy + 1) * stitchW + ix];
      const h11 = stitched[(iy + 1) * stitchW + ix + 1];
      out[gy * W + gx] = (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
    }
  }
  void scale;

  let min = Infinity;
  let max = -Infinity;
  for (const v of out) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  await writeFile(new URL("heightmap-raw.bin", OUT_DIR), Buffer.from(out.buffer));
  await writeFile(
    new URL("heightmap-meta.json", OUT_DIR),
    JSON.stringify({ ...GRID, zoom: Z, elevationMin: min, elevationMax: max }, null, 2)
  );
  console.log(`[terrain] wrote ${W}x${H} grid, elevation ${min.toFixed(1)}..${max.toFixed(1)}m`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
