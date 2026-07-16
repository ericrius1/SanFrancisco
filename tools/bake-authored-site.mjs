#!/usr/bin/env node
// Worktree-safe headless Blender bake for any manifest-registered authored region.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
runBlender("sync-authored-region.py");
runBlender("export-authored-site.py");

const publish = spawnSync(process.execPath, [
  path.join(ROOT, "tools", "inject-authored-site.mjs"), "--site", site
], { stdio: "inherit" });
if (publish.status !== 0) process.exit(publish.status ?? 1);

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
