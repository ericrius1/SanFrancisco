#!/usr/bin/env node

import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(await fs.readFile(path.join(ROOT, "data", "authored-regions.json"), "utf8"));
const runtime = JSON.parse(await fs.readFile(path.join(ROOT, "public", "data", "authored-regions.json"), "utf8"));
if (source.schema !== 1 || runtime.schema !== 1) throw new Error("Unsupported authored-region schema");
if (!Array.isArray(source.regions) || runtime.regions.length !== source.regions.length) {
  throw new Error("Source/runtime authored-region manifests disagree");
}

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const ids = new Set();
for (const definition of source.regions) {
  if (!definition.id || ids.has(definition.id)) throw new Error(`Duplicate authored region ${definition.id}`);
  ids.add(definition.id);
  const published = runtime.regions.find((entry) => entry.id === definition.id);
  if (!published) throw new Error(`Runtime manifest is missing ${definition.id}`);
  const metadata = JSON.parse(await fs.readFile(
    path.join(ROOT, "data", "authored-sites", `${definition.id}.json`),
    "utf8"
  ));
  if (metadata.schema !== 2 || metadata.source !== definition.source) {
    throw new Error(`Baked metadata for ${definition.id} is stale`);
  }
  const regionDoc = await io.readBinary(await fs.readFile(
    path.join(ROOT, "public", published.asset.replace(/^\//, ""))
  ));
  const regionVertices = regionDoc.getRoot().listMeshes().reduce((total, mesh) =>
    total + mesh.listPrimitives().reduce((sum, primitive) =>
      sum + (primitive.getAttribute("POSITION")?.getCount() ?? 0), 0), 0);
  if (regionVertices <= 0) throw new Error(`${definition.id} published an empty visual`);

  const tileDoc = await io.readBinary(await fs.readFile(
    path.join(ROOT, "public", "tiles", `tile_${definition.tile}.glb`)
  ));
  const embedded = tileDoc.getRoot().listNodes().filter((node) => node.getExtras()?.sf_site === definition.id);
  if (embedded.length > 0) throw new Error(`${definition.id} is still embedded in tile ${definition.tile}`);

  const colliders = JSON.parse(await fs.readFile(
    path.join(ROOT, "public", "data", "colliders", `tile_${definition.tile}.json`),
    "utf8"
  ));
  const ownedColliders = colliders.filter((collider) => collider.sfSite === definition.id);
  if (ownedColliders.length !== metadata.colliders.length) {
    throw new Error(`${definition.id} collider count ${ownedColliders.length} != ${metadata.colliders.length}`);
  }
  if (Boolean(published.terrain) !== Boolean(metadata.terrain)) {
    throw new Error(`${definition.id} terrain ownership is missing from one manifest`);
  }
  if (JSON.stringify(published.arrival ?? null) !== JSON.stringify(metadata.arrival ?? null)) {
    throw new Error(`${definition.id} arrival pose is missing or stale in the runtime manifest`);
  }
  console.log(
    `[authored-region] ${definition.id}: ${regionVertices} vertices, ` +
    `${ownedColliders.length} colliders, standalone visual confirmed`
  );
}

const blender = process.env.BLENDER_BIN ?? "/Applications/Blender.app/Contents/MacOS/Blender";
const master = process.env.SF_BLENDER_MASTER ??
  "/Users/eric/EricAssetLibrary/world-building/sanfrancisco.blend";
const validateMaster = spawnSync(blender, [
  "--background", master,
  "--python", path.join(ROOT, "tools", "validate-authored-world.py"),
  "--", "--repo", ROOT, "--master", master
], { stdio: "inherit" });
if (validateMaster.status !== 0) process.exit(validateMaster.status ?? 1);
