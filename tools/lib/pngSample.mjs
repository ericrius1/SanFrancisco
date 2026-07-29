/**
 * Minimal PNG decode + disc sampling, shared by the probes that measure
 * RENDERED pixels rather than trusting a read-back. Both live here because
 * drawImage() of a WebGPU canvas reads back black in headless Chrome, so the
 * only honest source of pixels is a screenshot decoded node-side.
 *
 * Supports exactly what Chrome's screenshots emit: 8-bit, non-interlaced,
 * colour type 2 or 6.
 */
import zlib from "node:zlib";

export function decodePng(buf) {
  let off = 8, w = 0, h = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || (colorType !== 6 && colorType !== 2) || data[12] !== 0)
        throw new Error(`unsupported PNG (depth ${data[8]} color ${colorType} interlace ${data[12]})`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], cc = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, i = x * bpp;
      out[o] = cur[i]; out[o + 1] = cur[i + 1]; out[o + 2] = cur[i + 2];
      out[o + 3] = colorType === 6 ? cur[i + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, data: out };
}

/** Brightest pixel in the disc (≈ the sunlit point) + mean 3×3 at centre. */
export function sampleDisc(png, cx, cy, pr) {
  let maxL = -1, maxPix = [0, 0, 0];
  const sum = [0, 0, 0];
  let cnt = 0;
  const R = Math.ceil(pr);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    if (dx * dx + dy * dy > pr * pr) continue;
    const x = Math.round(cx + dx), y = Math.round(cy + dy);
    if (x < 0 || y < 0 || x >= png.w || y >= png.h) continue;
    const i = (y * png.w + x) * 4;
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (L > maxL) { maxL = L; maxPix = [r, g, b]; }
    if (dx * dx + dy * dy <= 4) { sum[0] += r; sum[1] += g; sum[2] += b; cnt++; }
  }
  return {
    max: maxPix.map((x) => x / 255),
    center: sum.map((x) => x / (cnt || 1) / 255)
  };
}
