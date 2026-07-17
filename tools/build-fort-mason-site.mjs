#!/usr/bin/env node
// Rebuild the source-level Fort Mason Blender scene, then publish it through
// the same lazy authored-region pipeline as the other bespoke world sites.

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const blender = process.env.BLENDER_BIN ?? "/Applications/Blender.app/Contents/MacOS/Blender";
const sourcePath = path.join(ROOT, "assets-src", "world", "sites", "fort-mason.blend");

rmSync(sourcePath, { force: true });

const source = spawnSync(blender, [
  "--background",
  "--factory-startup",
  "--python",
  path.join(ROOT, "tools", "create-fort-mason-site.py"),
  "--",
  "--repo",
  ROOT
], { stdio: "inherit" });
if (source.status !== 0 || !existsSync(sourcePath)) process.exit(source.status || 1);

const publish = spawnSync(process.execPath, [
  path.join(ROOT, "tools", "bake-authored-site.mjs"),
  "--site",
  "fort-mason"
], { stdio: "inherit", env: process.env });
if (publish.status !== 0) process.exit(publish.status ?? 1);
