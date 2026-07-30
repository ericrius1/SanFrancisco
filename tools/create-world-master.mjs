#!/usr/bin/env node
// Build the human-facing San Francisco master Blender composition from scratch:
// terrain from the committed heightmap, every shipped city tile, and then the
// standard compose-authored-world pass that live-links the authored sites.
//
// The published tiles are meshopt-compressed, which Blender's glTF importer
// cannot read, so this decompresses them into .data/master-tiles/ first.
//
//   node tools/create-world-master.mjs        (SF_BLENDER_MASTER overrides the
//                                              default master path)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dequantize, prune } from "@gltf-transform/functions";
import { MeshoptDecoder } from "meshoptimizer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = process.env.SF_BLENDER_MASTER ??
  "/Users/eric/EricAssetLibrary/world-building/sanfrancisco.blend";
const TILES_IN = path.join(ROOT, "public", "tiles");
const TILES_OUT = path.join(ROOT, ".data", "master-tiles");
const blender = process.env.BLENDER_BIN ?? "/Applications/Blender.app/Contents/MacOS/Blender";

mkdirSync(path.dirname(MASTER), { recursive: true });
mkdirSync(TILES_OUT, { recursive: true });

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });

const tiles = readdirSync(TILES_IN).filter((f) => f.endsWith(".glb")).sort();
console.log(`[world-master] decompressing ${tiles.length} city tiles`);
for (const tile of tiles) {
  const out = path.join(TILES_OUT, tile);
  const document = await io.read(path.join(TILES_IN, tile));
  // Blender's importer reads neither meshopt streams nor quantized attributes,
  // and chokes on the empty buffer stub the meshopt decode leaves behind.
  await document.transform(dequantize(), prune());
  for (const extension of document.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === "EXT_meshopt_compression") extension.dispose();
  }
  await io.write(out, document);
}

console.log(`[world-master] assembling ${MASTER}`);
const assemble = spawnSync(blender, [
  "--background", "--factory-startup",
  "--python", path.join(ROOT, "tools", "create-world-master.py"),
  "--", "--repo", ROOT, "--master", MASTER, "--tiles", TILES_OUT
], { stdio: "inherit" });
if (assemble.status !== 0 || !existsSync(MASTER)) process.exit(assemble.status || 1);

console.log("[world-master] composing authored regions into the master");
const compose = spawnSync(blender, [
  "--background", MASTER,
  "--python", path.join(ROOT, "tools", "compose-authored-world.py"),
  "--", "--repo", ROOT, "--master", MASTER
], { stdio: "inherit" });
if (compose.status !== 0) process.exit(compose.status ?? 1);
console.log(`[world-master] done: ${MASTER}`);
