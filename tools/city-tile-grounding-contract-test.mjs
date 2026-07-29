// Contract test: every generated city building is drawn where its collider says
// it stands.
//
// The bug this exists to prevent shipped for four commits. tile_1_12's building
// mesh was translated +16.5 m above its own colliders, so the Sutro Heights /
// Point Lobos blocks hung in the air whenever you looked north from Ocean Beach.
// It was invisible to every existing check because nothing compared the DRAWN
// geometry against the collider payload baked from the same source, and it only
// "resolved" in play once the citygen ring woke up and mesh-suppressed the
// shells — so it read as a streaming stutter rather than a broken asset.
//
// It also grew silently: tools/inject-authored-site.mjs re-quantized the tile on
// every site bake, and each pass rewrote the building node's transform by
// +2.748 m. The tolerance here is well under one such notch, so a single
// recurrence fails the build.
//
//   node tools/city-tile-grounding-contract-test.mjs          verify, exit non-zero on drift
//   node tools/city-tile-grounding-contract-test.mjs --fix    re-ground the tiles that drifted
//
// MEASUREMENT — per building, not per tile. Buildings carry a `_BID` vertex
// attribute matching the `i` field of their collider boxes, and the city baker
// decomposes one building into ~2.6 STACKED boxes, so a whole-tile min/max
// comparison reads an arbitrary mid-building floor and invents a bogus gap.
// Grouping by `_BID` and reducing each group by `min` is what makes the signal
// clean: a real translation error shows up as ~250 buildings all off by the same
// constant (sd ~0.03 m), which no amount of per-building terrain variation can
// imitate. Authored-site colliders (`sfSite`) are excluded — they belong to a
// Blender region that owns its own floor and sits at beach level, and letting
// them into the comparison is what previously made the error look like 26.5 m.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fix = process.argv.includes("--fix");

// Quantized positions land on a ~1.2 cm grid (16 bits over 800 m) and the
// measured spread across healthy tiles is ±0.11 m. One re-quantization notch is
// 2.748 m, so this catches a single recurrence with two orders of margin.
const TOLERANCE_M = 0.25;

// A whole-mesh transform error moves every building by the same amount: healthy
// tiles measure sd ~0.03 m and tile_1_12's 16.5 m error measured sd 0.026 m.
// Above this, the tile's buildings disagree with their colliders INDIVIDUALLY,
// which no single translation can fix — tile_10_8 is the standing example
// (28 buildings, median -2.3 m, sd 3.4 m, two thirds of them >1 m off that
// median). That is a different defect with a different cause, so it is reported
// and left alone rather than "corrected" by shifting 28 correct buildings.
const RIGID_SD_M = 0.5;

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });

/** Collider stack bottom per generated building id. */
function colliderBottoms(tile) {
  const file = path.join(ROOT, "public/data/colliders", `tile_${tile}.json`);
  if (!existsSync(file)) return null;
  const bottoms = new Map();
  for (const c of JSON.parse(readFileSync(file, "utf8"))) {
    if (c.sfSite) continue; // authored region, owns its own floor
    const bottom = c.y - c.hy;
    if (!bottoms.has(c.i) || bottom < bottoms.get(c.i)) bottoms.set(c.i, bottom);
  }
  return bottoms;
}

/** World-space bottom of each `_BID` group in the tile's building mesh. */
function meshBottoms(doc) {
  const node = doc.getRoot().listNodes()
    .find((n) => (n.getName() || n.getMesh()?.getName() || "").startsWith("bld_"));
  if (!node) return null;
  const translationY = node.getTranslation()[1];
  const scaleY = node.getScale()[1];
  const bottoms = new Map();
  for (const prim of node.getMesh().listPrimitives()) {
    const position = prim.getAttribute("POSITION");
    const bid = prim.getAttribute("_BID") ?? prim.getAttribute("_bid");
    if (!position || !bid) continue;
    const array = position.getArray();
    const normalized = position.getNormalized();
    const componentMax = position.getComponentType() === 5123 ? 65535 : 32767;
    for (let vertex = 0; vertex < position.getCount(); vertex++) {
      const raw = array[vertex * 3 + 1];
      const world = (normalized ? raw / componentMax : raw) * scaleY + translationY;
      const id = Math.round(bid.getScalar(vertex));
      if (!bottoms.has(id) || world < bottoms.get(id)) bottoms.set(id, world);
    }
  }
  return bottoms.size ? { name: node.getName(), translationY, bottoms } : null;
}

/**
 * Rewrite one node's translation.y in place, by GLB JSON-chunk surgery.
 *
 * Deliberately NOT a gltf-transform round-trip: the whole defect being fixed
 * came from re-encoding geometry that was already final. The node transform
 * lives in the JSON chunk, so editing it leaves the BIN chunk — every quantized
 * vertex, every meshopt-compressed byte — bit-for-bit identical.
 */
function rewriteNodeTranslationY(file, nodeName, translationY) {
  const glb = readFileSync(file);
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8"));
  const node = json.nodes.find((candidate) => candidate.name === nodeName);
  if (!node) throw new Error(`${path.basename(file)}: no node named ${nodeName}`);
  node.translation[1] = translationY;

  const bin = glb.subarray(20 + jsonLength);
  let text = Buffer.from(JSON.stringify(json), "utf8");
  if (text.length % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.length + bin.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
  writeFileSync(file, Buffer.concat([header, text, bin]));
}

const tiles = readdirSync(path.join(ROOT, "public/tiles"))
  .filter((name) => /^tile_\d+_\d+\.glb$/.test(name))
  .map((name) => name.slice(5, -4))
  .sort();

const drifted = [];
const scattered = [];
let checked = 0;
let skipped = 0;
for (const tile of tiles) {
  const file = path.join(ROOT, "public/tiles", `tile_${tile}.glb`);
  const mesh = meshBottoms(await io.readBinary(readFileSync(file)));
  const colliders = colliderBottoms(tile);
  if (!mesh || !colliders?.size) { skipped++; continue; }

  const deltas = [];
  for (const [id, bottom] of mesh.bottoms) {
    const collider = colliders.get(id);
    if (collider !== undefined) deltas.push(bottom - collider);
  }
  if (!deltas.length) { skipped++; continue; }
  deltas.sort((a, b) => a - b);
  const median = deltas[deltas.length >> 1];
  checked++;
  if (Math.abs(median) <= TOLERANCE_M) continue;

  const mean = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
  const sd = Math.sqrt(deltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / deltas.length);
  const entry = { tile, file, node: mesh.name, median, sd, count: deltas.length,
    translationY: mesh.translationY };
  (sd <= RIGID_SD_M ? drifted : scattered).push(entry);
}

const describe = (entry) =>
  `tile_${entry.tile} draws ${entry.count} buildings ${Math.abs(entry.median).toFixed(3)} m ` +
  `${entry.median > 0 ? "above" : "below"} their colliders (sd ${entry.sd.toFixed(3)} m)`;

for (const entry of scattered) {
  console.log(`city tile grounding: note — ${describe(entry)}; per-building scatter, not a mesh transform error`);
}

if (!drifted.length) {
  console.log(
    `city tile grounding: ok (${checked} tiles verified, ${skipped} without buildings or colliders` +
    (scattered.length ? `, ${scattered.length} noted above` : "") + ")"
  );
  process.exit(0);
}

for (const entry of drifted) console.error(`city tile grounding: ${describe(entry)}`);

if (!fix) {
  console.error(
    "\nThe drawn tile geometry disagrees with the collider payload baked from the same source.\n" +
    "Re-ground it with:  node tools/city-tile-grounding-contract-test.mjs --fix\n" +
    "If a site bake caused this, check that tools/inject-authored-site.mjs still does not re-quantize."
  );
  process.exit(1);
}

for (const entry of drifted) {
  const grounded = entry.translationY - entry.median;
  rewriteNodeTranslationY(entry.file, entry.node, grounded);
  console.log(
    `city tile grounding: ${entry.node} translation.y ` +
    `${entry.translationY.toFixed(6)} -> ${grounded.toFixed(6)} (${entry.median > 0 ? "-" : "+"}${Math.abs(entry.median).toFixed(3)} m)`
  );
}
console.log("city tile grounding: re-run without --fix to verify");
