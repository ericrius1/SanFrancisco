#!/usr/bin/env node
/**
 * Build-time road exporter for the AI-cars system.
 *
 * Reads data/city/city.json (24 MB, in-repo build data) and emits a slim
 * public/data/roads.json that the browser RoadGraph fetches at runtime.
 *
 * We drop bridge segments (bridge === true) — AI cars stay on the street grid,
 * not the spans — and footpaths (w < 6). Coordinates are quantised to 0.1 m
 * ints (world metres ×10) to keep the file small; RoadGraph divides back by 10.
 *
 * Output shape (v1):
 *   { v: 1, segs: [ { p: [x1,z1, x2,z2, ...] (×10 ints), w: <metres> }, ... ] }
 *
 * Run:  node tools/export-roads.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "data/city/city.json");
const OUT = resolve(ROOT, "public/data/roads.json");

const MIN_WIDTH = 6; // drop footpaths narrower than this (metres)

function main() {
  const raw = JSON.parse(readFileSync(SRC, "utf8"));
  const tiles = raw.tiles ?? raw;

  const segs = [];
  let dropBridge = 0;
  let dropNarrow = 0;
  let dropShort = 0;
  let ptCount = 0;

  for (const key of Object.keys(tiles)) {
    const roads = tiles[key].roads;
    if (!Array.isArray(roads)) continue;
    for (const r of roads) {
      if (r.bridge === true) {
        dropBridge++;
        continue;
      }
      const w = typeof r.w === "number" ? r.w : 0;
      if (w < MIN_WIDTH) {
        dropNarrow++;
        continue;
      }
      const pts = r.pts;
      if (!Array.isArray(pts) || pts.length < 2) {
        dropShort++;
        continue;
      }
      // quantise to 0.1 m ints and drop consecutive duplicates
      const p = [];
      let lastX = NaN;
      let lastZ = NaN;
      for (const pt of pts) {
        const x = Math.round(pt[0] * 10);
        const z = Math.round(pt[1] * 10);
        if (x === lastX && z === lastZ) continue;
        p.push(x, z);
        lastX = x;
        lastZ = z;
      }
      if (p.length < 4) {
        dropShort++;
        continue;
      }
      ptCount += p.length / 2;
      segs.push({ p, w: Math.round(w) });
    }
  }

  const out = { v: 1, segs };
  mkdirSync(dirname(OUT), { recursive: true });
  const json = JSON.stringify(out);
  writeFileSync(OUT, json);

  console.log(`roads.json written: ${OUT}`);
  console.log(`  segments: ${segs.length}, points: ${ptCount}`);
  console.log(`  dropped: bridge=${dropBridge} narrow(<${MIN_WIDTH}m)=${dropNarrow} short=${dropShort}`);
  console.log(`  size: ${(json.length / 1024 / 1024).toFixed(2)} MB (uncompressed)`);
}

main();
