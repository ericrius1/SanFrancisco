#!/usr/bin/env node
// Publish one Blender-authored region as its own lazy GLB, remove superseded
// generated city faces, and publish its colliders into the local physics tile.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, join, meshopt, prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const site = args[args.indexOf("--site") + 1];
if (!site || site.startsWith("--")) throw new Error("Usage: inject-authored-site.mjs --site <id>");

const metadataPath = path.join(ROOT, "data", "authored-sites", `${site}.json`);
const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
if (metadata.schema !== 2 || metadata.id !== site) throw new Error(`Invalid ${metadataPath}`);
const sourceManifestPath = path.join(ROOT, "data", "authored-regions.json");
const sourceManifest = JSON.parse(await fs.readFile(sourceManifestPath, "utf8"));
const sourceDefinition = sourceManifest.regions?.find((entry) => entry.id === site);
if (sourceManifest.schema !== 1 || !sourceDefinition) throw new Error(`Invalid ${sourceManifestPath}`);

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });

const countVertices = (document) => document.getRoot().listMeshes().reduce((total, mesh) =>
  total + mesh.listPrimitives().reduce((sum, primitive) =>
    sum + (primitive.getAttribute("POSITION")?.getCount() ?? 0), 0), 0);

// The authored visual is independently addressable, so landmark arrival never
// waits behind a generic 800 m city tile parse.
const sourceRegionPath = path.join(ROOT, ".data", "authored-sites", `${site}.glb`);
const regionDoc = await io.readBinary(await fs.readFile(sourceRegionPath));
const regionVerticesBefore = countVertices(regionDoc);
// Grace Cathedral is one cohesive, distance-gated architectural owner. Its
// editable Blender source intentionally preserves hundreds of semantic pieces,
// while the browser delivery batches compatible siblings by material so those
// artist-friendly objects do not become hundreds of WebGPU draw submissions.
if (sourceDefinition.optimize === "static-batch") {
  await regionDoc.transform(dedup(), flatten(), join({ keepNamed: false }));
}
await regionDoc.transform(meshopt({ encoder: MeshoptEncoder, level: "high", quantizePosition: 16 }));
const regionOutput = await io.writeBinary(regionDoc);
const verifiedRegion = await io.readBinary(regionOutput);
const regionVerticesAfter = countVertices(verifiedRegion);
if (regionVerticesBefore <= 0 || regionVerticesAfter !== regionVerticesBefore) {
  throw new Error(`Unexpected region vertex count: ${regionVerticesBefore} -> ${regionVerticesAfter}`);
}
const publicRegionPath = path.join(ROOT, "public", metadata.asset.replace(/^\//, ""));
await fs.mkdir(path.dirname(publicRegionPath), { recursive: true });
await fs.writeFile(publicRegionPath, regionOutput);

// Remove any older in-tile authored injection, and permanently remove only the
// generated triangles whose ownership the Blender region declares.
const tilePath = path.join(ROOT, "public", "tiles", `tile_${metadata.tile}.glb`);
const baseDoc = await io.readBinary(await fs.readFile(tilePath));
let removedNodes = 0;
for (const node of baseDoc.getRoot().listNodes()) {
  if (node.getExtras()?.sf_site !== site) continue;
  node.dispose();
  removedNodes++;
}
if (removedNodes) await baseDoc.transform(prune());

let removedTriangles = 0;
for (const replacement of metadata.replaces ?? []) {
  if (replacement.tile !== metadata.tile) continue;
  for (const mesh of baseDoc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const bid = primitive.getAttribute("_BID") ?? primitive.getAttribute("_bid");
      const indices = primitive.getIndices();
      if (!bid || !indices) continue;
      const source = indices.getArray();
      const kept = [];
      for (let offset = 0; offset < source.length; offset += 3) {
        const a = source[offset];
        const b = source[offset + 1];
        const c = source[offset + 2];
        if (Math.round(bid.getScalar(a)) === replacement.index &&
            Math.round(bid.getScalar(b)) === replacement.index &&
            Math.round(bid.getScalar(c)) === replacement.index) {
          removedTriangles++;
          continue;
        }
        kept.push(a, b, c);
      }
      if (kept.length !== source.length) {
        const ArrayType = source instanceof Uint32Array ? Uint32Array : Uint16Array;
        const next = baseDoc.createAccessor(`${mesh.getName()}_authored_indices`)
          .setType("SCALAR")
          .setArray(new ArrayType(kept));
        primitive.setIndices(next);
      }
    }
  }
}
if (removedNodes || removedTriangles) {
  await baseDoc.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: "high", quantizePosition: 16 }));
  await fs.writeFile(tilePath, await io.writeBinary(baseDoc));
}

const colliderPath = path.join(ROOT, "public", "data", "colliders", `tile_${metadata.tile}.json`);
let colliders = JSON.parse(await fs.readFile(colliderPath, "utf8"));
const replacements = new Set((metadata.replaces ?? [])
  .filter((entry) => entry.tile === metadata.tile)
  .map((entry) => entry.index));
colliders = colliders.filter((collider) => collider.sfSite !== site && !replacements.has(collider.i));
colliders.push(...metadata.colliders.map((collider) => ({
  i: collider.i,
  p: 7,
  x: collider.x,
  y: collider.y,
  z: collider.z,
  hx: collider.hx,
  hy: collider.hy,
  hz: collider.hz,
  yaw: collider.yaw,
  vol: 1_000_000_000,
  sfSite: site
})));
await fs.writeFile(colliderPath, JSON.stringify(colliders));

// Runtime receives only spatial/loading data. Blender paths, collection names,
// replacement indices and full collider arrays stay in the authoring tree.
const runtimeRegions = [];
for (const definition of sourceManifest.regions) {
  const builtPath = path.join(ROOT, "data", "authored-sites", `${definition.id}.json`);
  const built = JSON.parse(await fs.readFile(builtPath, "utf8"));
  if (built.schema !== 2 || built.id !== definition.id) {
    throw new Error(`Authored region ${definition.id} must be baked before publishing the manifest`);
  }
  runtimeRegions.push({
    id: built.id,
    label: built.label,
    asset: built.asset,
    tile: built.tile,
    bounds: built.bounds,
    ...(built.arrival ? { arrival: built.arrival } : {}),
    arrivalDistance: built.arrivalDistance,
    loadDistance: built.loadDistance,
    unloadDistance: built.unloadDistance,
    ...(built.terrain ? { terrain: built.terrain } : {})
  });
}
await fs.writeFile(
  path.join(ROOT, "public", "data", "authored-regions.json"),
  JSON.stringify({ schema: 1, regions: runtimeRegions })
);

console.log(
  `[authored-region] ${site}: ${(regionOutput.length / 1024).toFixed(1)} KiB visual, ` +
  `${metadata.colliders.length} colliders, removed ${removedTriangles} generated triangles / ` +
  `${removedNodes} legacy injected roots`
);
