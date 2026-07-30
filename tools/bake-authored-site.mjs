#!/usr/bin/env node
// Worktree-safe headless Blender bake for any manifest-registered authored region.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordBake } from "./asset-ledger.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const site = args[args.indexOf("--site") + 1];
if (!site || site.startsWith("--")) {
  throw new Error("Usage: bake-authored-site.mjs --site <authored-region-id>");
}
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "authored-regions.json"), "utf8"));
if (manifest.schema !== 1 || !Array.isArray(manifest.regions)) {
  throw new Error("data/authored-regions.json has an unsupported schema");
}
const region = manifest.regions.find((candidate) => candidate.id === site);
if (!region) throw new Error(`Unknown authored region: ${site}`);

const source = path.join(ROOT, region.source);
const blender = process.env.BLENDER_BIN ?? "/Applications/Blender.app/Contents/MacOS/Blender";
const runBlender = (script, extra = []) => {
  const run = spawnSync(blender, [
    "--background", source,
    "--python", path.join(ROOT, "tools", script),
    "--", "--repo", ROOT, "--site", site, ...extra
  ], { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
};

// Seed the generic authoring collections once. Existing Blender transforms are
// deliberately preserved thereafter: the .blend file is the authority.
//
// The ARRIVAL empty is the one pose that gets retuned from the repo side too
// (it is a spawn point, not geometry), and because the seed above never touches
// an empty that already exists, a .blend older than the manifest still holds
// the previous pose. The export refuses to publish that silently — pass
// --allow-arrival-move when the Blender move is the intentional one, then copy
// the printed pose into data/authored-regions.json in the same commit.
runBlender("sync-authored-region.py");
runBlender("export-authored-site.py", args.includes("--allow-arrival-move") ? ["--allow-arrival-move"] : []);

const publish = spawnSync(process.execPath, [
  path.join(ROOT, "tools", "inject-authored-site.mjs"), "--site", site
], { stdio: "inherit" });
if (publish.status !== 0) process.exit(publish.status ?? 1);

// Record the bake. Both the .blend and everything published from it are tracked,
// so they travel together through a worktree merge — but only if they are
// committed together. This ledger entry is what makes a mismatch loud: commit a
// site source without re-baking and `npm run build` names the site, the file and
// this exact command on every machine, instead of shipping a model that does not
// match its authoring file.
recordBake({
  id: `region-${site}`,
  label: `${region.label} (Blender site bake)`,
  bake: `npm run bake:region -- --site ${site}`,
  tracked: true,
  inputs: [
    region.source,
    "data/authored-regions.json",
    "tools/sync-authored-region.py",
    "tools/export-authored-site.py",
    "tools/inject-authored-site.mjs"
  ],
  outputs: [
    `public${region.asset}`,
    `public/tiles/tile_${region.tile}.glb`,
    `public/data/colliders/tile_${region.tile}.json`,
    `data/authored-sites/${site}.json`,
    "public/data/authored-regions.json"
  ]
});

// Refresh the human-facing Blender world composition as part of the same
// authoritative bake. Override the master path in other environments.
const master = process.env.SF_BLENDER_MASTER ??
  "/Users/eric/EricAssetLibrary/world-building/sanfrancisco.blend";
if (fs.existsSync(master) && process.env.SF_SKIP_BLENDER_COMPOSE !== "1") {
  const compose = spawnSync(blender, [
    "--background", master,
    "--python", path.join(ROOT, "tools", "compose-authored-world.py"),
    "--", "--repo", ROOT, "--master", master
  ], { stdio: "inherit" });
  if (compose.status !== 0) process.exit(compose.status ?? 1);
}
