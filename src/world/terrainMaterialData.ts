export type TerrainByteMip = {
  data: Uint8Array;
  width: number;
  height: number;
};

export type TerrainByteMipChain = {
  mipmaps: TerrainByteMip[];
  bytes: number;
};

const clampIndex = (value: number, limit: number): number => Math.max(0, Math.min(limit - 1, value));

function downsampleHeights(
  source: Float32Array,
  width: number,
  height: number
): { data: Float32Array; width: number; height: number } {
  const nextWidth = Math.max(1, Math.floor(width / 2));
  const nextHeight = Math.max(1, Math.floor(height / 2));
  const next = new Float32Array(nextWidth * nextHeight);
  for (let y = 0; y < nextHeight; y++) {
    const y0 = y * 2;
    const y1 = Math.min(height - 1, y0 + 1);
    for (let x = 0; x < nextWidth; x++) {
      const x0 = x * 2;
      const x1 = Math.min(width - 1, x0 + 1);
      next[y * nextWidth + x] = (
        source[y0 * width + x0] +
        source[y0 * width + x1] +
        source[y1 * width + x0] +
        source[y1 * width + x1]
      ) * 0.25;
    }
  }
  return { data: next, width: nextWidth, height: nextHeight };
}

function encodeNormalMip(
  heights: Float32Array,
  width: number,
  height: number,
  cellSize: number
): Uint8Array {
  const data = new Uint8Array(width * height * 2);
  for (let y = 0; y < height; y++) {
    const y0 = clampIndex(y - 1, height);
    const y1 = y;
    const y2 = clampIndex(y + 1, height);
    for (let x = 0; x < width; x++) {
      const x0 = clampIndex(x - 1, width);
      const x1 = x;
      const x2 = clampIndex(x + 1, width);
      // A separable [1 2 1] derivative smooths across the 8 m source lattice
      // before differentiating. Encoding only X/Z lets the shader reconstruct
      // a normalized +Y normal after bilinear/trilinear filtering.
      const left = heights[y0 * width + x0] + 2 * heights[y1 * width + x0] + heights[y2 * width + x0];
      const right = heights[y0 * width + x2] + 2 * heights[y1 * width + x2] + heights[y2 * width + x2];
      const down = heights[y0 * width + x0] + 2 * heights[y0 * width + x1] + heights[y0 * width + x2];
      const up = heights[y2 * width + x0] + 2 * heights[y2 * width + x1] + heights[y2 * width + x2];
      let nx = left - right;
      let ny = cellSize * 8;
      let nz = down - up;
      const inverseLength = 1 / Math.max(1e-6, Math.hypot(nx, ny, nz));
      nx *= inverseLength;
      ny *= inverseLength;
      nz *= inverseLength;
      const offset = (y * width + x) * 2;
      data[offset] = Math.round((Math.max(-1, Math.min(1, nx)) * 0.5 + 0.5) * 255);
      data[offset + 1] = Math.round((Math.max(-1, Math.min(1, nz)) * 0.5 + 0.5) * 255);
    }
  }
  return data;
}

/** LOD-stable, filterable world-space terrain normals derived once at boot. */
export function createTerrainNormalMipData(
  sourceHeights: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  sourceCellSize: number,
  levels: number
): TerrainByteMipChain {
  const mipmaps: TerrainByteMip[] = [];
  let heights = sourceHeights;
  let width = sourceWidth;
  let height = sourceHeight;
  let cellSize = sourceCellSize;
  let bytes = 0;
  for (let level = 0; level < levels; level++) {
    const data = encodeNormalMip(heights, width, height, cellSize);
    mipmaps.push({ data, width, height });
    bytes += data.byteLength;
    if (width === 1 && height === 1) break;
    const next = downsampleHeights(heights, width, height);
    heights = next.data;
    width = next.width;
    height = next.height;
    cellSize *= 2;
  }
  return { mipmaps, bytes };
}

function downsampleWeights(source: Uint8Array, width: number, height: number): TerrainByteMip {
  const nextWidth = Math.max(1, Math.floor(width / 2));
  const nextHeight = Math.max(1, Math.floor(height / 2));
  const next = new Uint8Array(nextWidth * nextHeight * 4);
  for (let y = 0; y < nextHeight; y++) {
    const y0 = y * 2;
    const y1 = Math.min(height - 1, y0 + 1);
    for (let x = 0; x < nextWidth; x++) {
      const x0 = x * 2;
      const x1 = Math.min(width - 1, x0 + 1);
      for (let channel = 0; channel < 4; channel++) {
        next[(y * nextWidth + x) * 4 + channel] = Math.round((
          source[(y0 * width + x0) * 4 + channel] +
          source[(y0 * width + x1) * 4 + channel] +
          source[(y1 * width + x0) * 4 + channel] +
          source[(y1 * width + x1) * 4 + channel]
        ) * 0.25);
      }
    }
  }
  return { data: next, width: nextWidth, height: nextHeight };
}

/**
 * Narrow urban cells embedded in park interiors are footpaths in the OSM
 * raster. While parks were covered by opaque lawn drapes these never rendered;
 * on the clipmap they read as isolated grey blobs, so for the VISUAL weight
 * texture a park-majority urban cell becomes park. The raw class array is
 * untouched — gameplay gating (groundcover placement, surfaceType) still sees
 * real paths. Roads (class 4) keep their developed underlay by design.
 */
function reclassifyParkPaths(
  sourceClasses: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  // Up to three erosion passes: pass one clears single-cell paths, later
  // passes finish two-cell-wide segments the first pass turned park-majority.
  // Wide plazas keep their interiors (never park-majority) and stay urban.
  let source = sourceClasses;
  for (let pass = 0; pass < 3; pass++) {
    const cleaned = Uint8Array.from(source);
    let changed = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        if (source[y * width + x] !== 0) continue;
        let parkNeighbors = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            if (kx === 0 && ky === 0) continue;
            if (source[(y + ky) * width + (x + kx)] === 1) parkNeighbors++;
          }
        }
        if (parkNeighbors >= 5) {
          cleaned[y * width + x] = 1;
          changed++;
        }
      }
    }
    source = cleaned;
    if (changed === 0) break;
  }
  return source;
}

/**
 * Convert discrete source classes into a one-cell Gaussian feather before mip
 * generation. Roads (class 4) retain their developed-ground terrain underlay.
 */
export function createTerrainSurfaceMipData(
  sourceClasses: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  levels: number
): TerrainByteMipChain {
  sourceClasses = reclassifyParkPaths(sourceClasses, sourceWidth, sourceHeight);
  const kernel = [1, 2, 1] as const;
  let data: Uint8Array = new Uint8Array(sourceWidth * sourceHeight * 4);
  for (let y = 0; y < sourceHeight; y++) {
    for (let x = 0; x < sourceWidth; x++) {
      const weights = [0, 0, 0, 0];
      for (let ky = -1; ky <= 1; ky++) {
        const sy = clampIndex(y + ky, sourceHeight);
        for (let kx = -1; kx <= 1; kx++) {
          const sx = clampIndex(x + kx, sourceWidth);
          const sourceClass = sourceClasses[sy * sourceWidth + sx];
          const surface = sourceClass === 4 ? 0 : Math.max(0, Math.min(3, sourceClass));
          weights[surface] += kernel[ky + 1] * kernel[kx + 1];
        }
      }
      const offset = (y * sourceWidth + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        data[offset + channel] = Math.round(weights[channel] * (255 / 16));
      }
    }
  }

  const mipmaps: TerrainByteMip[] = [];
  let width = sourceWidth;
  let height = sourceHeight;
  let bytes = 0;
  for (let level = 0; level < levels; level++) {
    mipmaps.push({ data, width, height });
    bytes += data.byteLength;
    if (width === 1 && height === 1) break;
    const next = downsampleWeights(data, width, height);
    data = next.data;
    width = next.width;
    height = next.height;
  }
  return { mipmaps, bytes };
}

/**
 * M14 sub-rect twin of the surface base-mip build above: recompute the
 * feathered RGBA weights for an inclusive cell rect from the CURRENT class
 * lattice (mixed overview + streamed tiles — the source of truth). The park
 * path erosion (3 passes, 1-cell neighborhood each) plus the 1-cell Gaussian
 * feather need a 4-cell margin for exact values inside the rect; the margin
 * shrinks by one ring per erosion pass (onion) so every read sees a value of
 * the correct pass. Global-border cells never erode, matching the full build's
 * `y in [1, H-2]` loops. Returns tightly packed RGBA rows for the rect.
 */
export function computeSurfaceWeightsRegion(
  sourceClasses: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): Uint8Array {
  const MARGIN = 4;
  const rx0 = Math.max(0, x0 - MARGIN);
  const ry0 = Math.max(0, y0 - MARGIN);
  const rx1 = Math.min(width - 1, x1 + MARGIN);
  const ry1 = Math.min(height - 1, y1 + MARGIN);
  const rw = rx1 - rx0 + 1;
  const rh = ry1 - ry0 + 1;
  let local = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    local.set(sourceClasses.subarray((ry0 + y) * width + rx0, (ry0 + y) * width + rx0 + rw), y * rw);
  }
  // Erosion passes over a shrinking onion. Ring r of the local buffer holds
  // pass-min(r-1, …) values, which is exactly what pass p reads at distance 1.
  for (let pass = 0; pass < 3; pass++) {
    // Ring that can be recomputed exactly this pass. A side whose buffer edge
    // coincides with the global edge has no missing data, so no inset there
    // (the global-border skip below already matches the full build).
    const inset = pass + 1;
    const ix0 = rx0 === 0 ? 0 : inset;
    const ix1 = rx1 === width - 1 ? rw : rw - inset;
    const iy0 = ry0 === 0 ? 0 : inset;
    const iy1 = ry1 === height - 1 ? rh : rh - inset;
    const next = Uint8Array.from(local);
    let changed = 0;
    for (let y = iy0; y < iy1; y++) {
      const gy = ry0 + y;
      if (gy < 1 || gy > height - 2) continue;
      for (let x = ix0; x < ix1; x++) {
        const gx = rx0 + x;
        if (gx < 1 || gx > width - 2) continue;
        if (local[y * rw + x] !== 0) continue;
        let parkNeighbors = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            if (kx === 0 && ky === 0) continue;
            if (local[(y + ky) * rw + (x + kx)] === 1) parkNeighbors++;
          }
        }
        if (parkNeighbors >= 5) {
          next[y * rw + x] = 1;
          changed++;
        }
      }
    }
    local = next;
    if (changed === 0) break;
  }
  // Gaussian feather → RGBA weights for the target rect only.
  const kernel = [1, 2, 1] as const;
  const outW = x1 - x0 + 1;
  const outH = y1 - y0 + 1;
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const ly = y0 + y - ry0;
    for (let x = 0; x < outW; x++) {
      const lx = x0 + x - rx0;
      const weights = [0, 0, 0, 0];
      for (let ky = -1; ky <= 1; ky++) {
        const sy = Math.max(0, Math.min(rh - 1, ly + ky));
        // Local clamp matches the global clampIndex because the buffer edge
        // coincides with the global edge whenever clamping can engage (the
        // 4-cell margin otherwise guarantees in-bounds reads).
        for (let kx = -1; kx <= 1; kx++) {
          const sx = Math.max(0, Math.min(rw - 1, lx + kx));
          const sourceClass = local[sy * rw + sx];
          const surface = sourceClass === 4 ? 0 : Math.max(0, Math.min(3, sourceClass));
          weights[surface] += kernel[ky + 1] * kernel[kx + 1];
        }
      }
      const offset = (y * outW + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        out[offset + channel] = Math.round(weights[channel] * (255 / 16));
      }
    }
  }
  return out;
}

function hashByte(x: number, y: number, salt: number): number {
  let h = Math.imul(x + salt, 0x45d9f3b) ^ Math.imul(y - salt, 0x119de1f3);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) & 255;
}

function blurWrapped(source: Float32Array, size: number, radius: number): Float32Array {
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  const divisor = radius * 2 + 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        sum += source[y * size + (x + dx + size) % size];
      }
      horizontal[y * size + x] = sum / divisor;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        sum += horizontal[((y + dy + size) % size) * size + x];
      }
      output[y * size + x] = sum / divisor;
    }
  }
  return output;
}

/** Two-channel deterministic detail: coherent macro variation plus fine grain. */
export function createTerrainDetailTextureData(size = 256): Uint8Array {
  const random = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) random[y * size + x] = hashByte(x, y, 17) / 255;
  }
  const fine = blurWrapped(blurWrapped(random, size, 2), size, 2);
  const broad = blurWrapped(blurWrapped(random, size, 8), size, 8);
  const combined = new Float32Array(random.length);
  let mean = 0;
  for (let i = 0; i < combined.length; i++) {
    combined[i] = fine[i] * 0.2 + broad[i] * 0.8;
    mean += combined[i];
  }
  mean /= combined.length;
  let variance = 0;
  for (const value of combined) variance += (value - mean) ** 2;
  const scale = 0.15 / Math.max(1e-6, Math.sqrt(variance / combined.length));

  const data = new Uint8Array(size * size * 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      data[i * 2] = Math.round(Math.max(0.03, Math.min(0.97, 0.5 + (combined[i] - mean) * scale)) * 255);
      data[i * 2 + 1] = hashByte(x, y, 83);
    }
  }
  return data;
}
