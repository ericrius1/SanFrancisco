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
 * Convert discrete source classes into a one-cell Gaussian feather before mip
 * generation. Roads (class 4) retain their developed-ground terrain underlay.
 */
export function createTerrainSurfaceMipData(
  sourceClasses: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  levels: number
): TerrainByteMipChain {
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
