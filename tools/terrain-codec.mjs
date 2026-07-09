// Terrain binary codec — int16 heightmap + sparse groundTop-delta format.
//
// int16 heightmap: meters = heightBase + int16 * heightQuant
//   HEIGHT_QUANT = 0.02 m/step → covers −60…+341 m with margin using int16 range ±32767
//
// groundtop-delta (SFGD): sparse delta over the heightmap — only cells whose
//   groundTop differs from the base terrain by more than 0.0005 m are stored.
//   Format (little-endian):
//     [0..3]  magic "SFGD"
//     [4..5]  uint16 version = 1
//     [6..9]  uint32 count
//     count × 6 bytes: uint32 cellIndex, uint16 deltaMm  (deltaMm = round(delta*1000))

export const HEIGHT_QUANT = 0.02; // metres per int16 step

/**
 * Encode a Float32Array heightmap to int16.
 * @returns { int16: Int16Array, heightBase: number, heightQuant: number }
 */
export function encodeHeightmap(float32Array) {
  const quant = HEIGHT_QUANT;
  let min = Infinity;
  for (let i = 0; i < float32Array.length; i++) {
    if (float32Array[i] < min) min = float32Array[i];
  }
  const heightBase = Math.floor(min / quant) * quant;
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    int16[i] = Math.round((float32Array[i] - heightBase) / quant);
  }
  return { int16, heightBase, heightQuant: quant };
}

/**
 * Decode an int16 heightmap back to float32.
 */
export function decodeHeightmap(int16Array, heightBase, heightQuant) {
  const out = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    out[i] = heightBase + int16Array[i] * heightQuant;
  }
  return out;
}

/**
 * Encode sparse groundTop delta over a height Float32Array.
 * Only cells with delta > threshold (default 0.012 m) are stored.
 * The threshold is chosen to skip int16 quantization noise (max ±0.01 m per step)
 * while capturing all real park deltas (PARK_LIFT = 0.15 m).
 * @param {Float32Array} height  base terrain heights (decoded from int16 or original)
 * @param {Float32Array} groundTop  top-ground surface (groundtop-lib result)
 * @param {number} [threshold=0.012]  min abs delta to store (metres)
 * @returns {Buffer}
 */
export function encodeGroundTopDelta(height, groundTop, threshold = 0.012) {
  // first pass: collect deltas
  const indices = [];
  const deltas = [];
  for (let i = 0; i < height.length; i++) {
    const delta = groundTop[i] - height[i];
    if (delta > threshold) {
      indices.push(i);
      // clamp mm delta to uint16 range (0–65535); realistic max lift is ~1 m = 1000 mm
      deltas.push(Math.max(0, Math.min(65535, Math.round(delta * 1000))));
    }
  }
  const count = indices.length;
  // 4 magic + 2 version + 4 count + count * 6
  const buf = Buffer.allocUnsafe(10 + count * 6);
  buf.write("SFGD", 0, "ascii");
  buf.writeUInt16LE(1, 4);
  buf.writeUInt32LE(count, 6);
  for (let k = 0; k < count; k++) {
    const off = 10 + k * 6;
    buf.writeUInt32LE(indices[k], off);
    buf.writeUInt16LE(deltas[k], off + 4);
  }
  return buf;
}

/**
 * Decode a groundtop-delta buffer back into a full groundTop Float32Array.
 * @param {ArrayBuffer|Buffer} buffer  SFGD encoded delta
 * @param {Float32Array} heights  base terrain heights (copied + patched)
 * @returns {Float32Array}
 */
export function decodeGroundTopDelta(buffer, heights) {
  const view = new DataView(buffer instanceof Buffer ? buffer.buffer : buffer,
    buffer instanceof Buffer ? buffer.byteOffset : 0);
  const top = new Float32Array(heights); // copy base
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "SFGD") throw new Error(`terrain-codec: bad SFGD magic "${magic}"`);
  // version = view.getUint16(4, true) — currently only version 1
  const count = view.getUint32(6, true);
  for (let k = 0; k < count; k++) {
    const off = 10 + k * 6;
    const cellIndex = view.getUint32(off, true);
    const deltaMm = view.getUint16(off + 4, true);
    top[cellIndex] = heights[cellIndex] + deltaMm / 1000;
  }
  return top;
}

/**
 * True if a binary blob is likely an int16 heightmap for cellCount cells.
 */
export function isInt16Heightmap(byteLength, cellCount) {
  return byteLength === cellCount * 2;
}

/**
 * Decode a heightmap ArrayBuffer, honouring the meta.terrain field if present.
 * Falls back to legacy float32 if meta.terrain is absent or encoding is unknown.
 * @param {ArrayBuffer} arrayBuffer
 * @param {object} meta  the parsed meta.json (may have .terrain)
 * @returns {Float32Array}
 */
export function decodeHeightmapBuffer(arrayBuffer, meta) {
  const terrain = meta?.terrain;
  if (terrain?.heightEncoding === "int16") {
    const int16 = new Int16Array(arrayBuffer);
    return decodeHeightmap(int16, terrain.heightBase, terrain.heightQuant);
  }
  return new Float32Array(arrayBuffer);
}
