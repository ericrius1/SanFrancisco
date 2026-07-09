// Convert existing float32 heightmap.bin + groundtop.bin in public/data/ to the
// compact formats: int16 heightmap + sparse groundtop-delta.bin. Updates meta.json
// with terrain encoding fields and removes the legacy groundtop.bin.
//
//   node tools/repack-terrain.mjs
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { encodeHeightmap, encodeGroundTopDelta } from "./terrain-codec.mjs";

const PUB = new URL("../public/data/", import.meta.url);
const HEIGHTMAP = new URL("heightmap.bin", PUB);
const GROUNDTOP = new URL("groundtop.bin", PUB);
const GROUNDTOP_DELTA = new URL("groundtop-delta.bin", PUB);
const META = new URL("meta.json", PUB);

const metaRaw = await readFile(META, "utf8");
const meta = JSON.parse(metaRaw);
const { width: W, height: H } = meta.grid;
const cellCount = W * H;

// ---------- heightmap
const hmBuf = await readFile(HEIGHTMAP);
const hmF32 = new Float32Array(hmBuf.buffer, hmBuf.byteOffset, Math.floor(hmBuf.byteLength / 4));
if (hmF32.length !== cellCount) {
  throw new Error(`heightmap cell count ${hmF32.length} != expected ${cellCount}`);
}
const sizeBefore = hmBuf.byteLength;
const { int16: hmI16, heightBase, heightQuant } = encodeHeightmap(hmF32);
const sizeAfter = hmI16.byteLength;
await writeFile(HEIGHTMAP, Buffer.from(hmI16.buffer));
console.log(`[repack] heightmap: ${(sizeBefore / 1e6).toFixed(2)} MB → ${(sizeAfter / 1e6).toFixed(2)} MB (int16, base=${heightBase.toFixed(4)}, quant=${heightQuant})`);

// ---------- groundtop delta
if (!existsSync(GROUNDTOP)) {
  console.log("[repack] no groundtop.bin — skipping delta encode (only heightmap converted)");
} else {
  const gtBuf = await readFile(GROUNDTOP);
  const gtF32 = new Float32Array(gtBuf.buffer, gtBuf.byteOffset, Math.floor(gtBuf.byteLength / 4));
  if (gtF32.length !== cellCount) {
    throw new Error(`groundtop cell count ${gtF32.length} != expected ${cellCount}`);
  }
  const gtSizeBefore = gtBuf.byteLength;

  // need actual float32 heights to compute deltas; decode back from the int16 we just wrote
  const { decodeHeightmap } = await import("./terrain-codec.mjs");
  const hmDecoded = decodeHeightmap(hmI16, heightBase, heightQuant);

  const deltaBuf = encodeGroundTopDelta(hmDecoded, gtF32);
  await writeFile(GROUNDTOP_DELTA, deltaBuf);
  console.log(`[repack] groundtop-delta.bin: ${(gtSizeBefore / 1e6).toFixed(2)} MB → ${(deltaBuf.byteLength / 1e3).toFixed(1)} KB`);

  await unlink(GROUNDTOP);
  console.log("[repack] removed groundtop.bin");
}

// ---------- meta.json update
meta.terrain = {
  formatVersion: 1,
  heightEncoding: "int16",
  heightBase,
  heightQuant
};
await writeFile(META, JSON.stringify(meta, null, 2));
console.log("[repack] meta.json updated with terrain fields");
