type PaintRequest = {
  width: number;
  height: number;
  cellSize: number;
  minX: number;
  minZ: number;
  heights: Float32Array;
  surface: Uint8Array;
};

const LAGOON = { x: -300, z: -1426, radiusX: 88, radiusZ: 112 } as const;

function smooth01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lagoonMask(x: number, z: number): number {
  const dx = (x - LAGOON.x) / LAGOON.radiusX;
  const dz = (z - LAGOON.z) / LAGOON.radiusZ;
  return 1 - smooth01(0.78, 1, dx * dx + dz * dz);
}

self.onmessage = (event: MessageEvent<PaintRequest>) => {
  const { width, height, cellSize, minX, minZ, heights, surface } = event.data;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      const s = surface[i];
      const h = heights[i];
      const isWater = s === 3 || lagoonMask(minX + x * cellSize, minZ + y * cellSize) > 0.08;
      let r: number;
      let g: number;
      let b: number;
      if (isWater) {
        const t = Math.min(1, Math.max(0, s === 3 ? -h / 16 : 0.18));
        r = 96 + (1 - t) * 30;
        g = 132 + (1 - t) * 33;
        b = 139 + (1 - t) * 27;
      } else {
        if (s === 1) {
          r = 117; g = 128; b = 89;
        } else if (s === 2) {
          r = 187; g = 157; b = 105;
        } else if (s === 4) {
          r = 203; g = 188; b = 154;
        } else {
          r = 190; g = 174; b = 142;
        }
        const hx = heights[i + (x < width - 1 ? 1 : 0)] - h;
        const hy = heights[i + (y < height - 1 ? width : 0)] - h;
        const shade = Math.min(1.25, Math.max(0.62, 1 - (hx + hy) * 0.02));
        const lift = 1 + Math.min(0.35, Math.max(0, h) * 0.0016);
        r *= shade * lift;
        g *= shade * lift;
        b *= shade * lift;
      }
      pixels[o] = r;
      pixels[o + 1] = g;
      pixels[o + 2] = b;
      pixels[o + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Minimap worker 2D canvas unavailable");
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  const bitmap = canvas.transferToImageBitmap();
  (self as unknown as Worker).postMessage({ bitmap }, [bitmap]);
};
