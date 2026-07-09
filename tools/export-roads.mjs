#!/usr/bin/env node
/**
 * Build-time road exporter for the AI-cars system.
 *
 * Reads data/raw/roads.json (OSM cache with tags) and emits a slim
 * public/data/roads.json that the browser RoadGraph fetches at runtime.
 *
 * We drop bridge segments (bridge === true) — AI cars stay on the street grid,
 * not the spans — and footpaths (w < 6). Coordinates are quantised to 0.1 m
 * ints (world metres ×10) to keep the file small; RoadGraph divides back by 10.
 *
 * Output shape (v2):
 *   { v: 2, segs: [
 *       { p: [x1,z1, x2,z2, ...] (×10 ints), w, l: lanes, d: onewayDir, k: class }
 *   ] }
 *
 * Run:  node tools/export-roads.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lonLatToLocal } from "./geo.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "data/raw/roads.json");
const OUT = resolve(ROOT, "public/data/roads.json");

const MIN_WIDTH = 6; // drop footpaths narrower than this (metres)
const ROAD_WIDTH = {
  motorway: 19,
  trunk: 16,
  primary: 14,
  secondary: 11,
  tertiary: 9,
  residential: 7.5,
  unclassified: 7,
  living_street: 6,
  pedestrian: 4.5,
  motorway_link: 9,
  trunk_link: 8,
  primary_link: 8,
  secondary_link: 7,
  tertiary_link: 7
};

const ROAD_CLASS = {
  living_street: 0,
  pedestrian: 0,
  residential: 1,
  unclassified: 1,
  tertiary: 2,
  tertiary_link: 2,
  secondary: 3,
  secondary_link: 3,
  primary: 4,
  primary_link: 4,
  trunk: 4,
  trunk_link: 4,
  motorway: 5,
  motorway_link: 5
};

function lanes(tags) {
  const raw = Number.parseInt(String(tags.lanes ?? ""), 10);
  if (Number.isFinite(raw) && raw > 0) return Math.max(1, Math.min(8, raw));
  const fwd = Number.parseInt(String(tags["lanes:forward"] ?? ""), 10);
  const back = Number.parseInt(String(tags["lanes:backward"] ?? ""), 10);
  if (Number.isFinite(fwd) || Number.isFinite(back)) return Math.max(1, Math.min(8, (fwd || 0) + (back || 0)));
  return tags.oneway === "yes" || tags.oneway === "1" || tags.oneway === "true" ? 1 : 2;
}

function oneWayDir(tags) {
  const one = String(tags.oneway ?? "").toLowerCase();
  if (one === "-1" || one === "reverse") return -1;
  if (one === "yes" || one === "1" || one === "true") return 1;
  if (tags.junction === "roundabout" || tags.junction === "circular") return 1;
  return 0;
}

function main() {
  const raw = JSON.parse(readFileSync(SRC, "utf8"));
  const segs = [];
  let dropBridge = 0;
  let dropNarrow = 0;
  let dropShort = 0;
  let ptCount = 0;

  for (const el of raw.elements ?? []) {
    if (el.type !== "way" || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    if (tags.bridge === "yes" || tags.bridge === "viaduct") {
      dropBridge++;
      continue;
    }
    const w = ROAD_WIDTH[tags.highway] ?? 0;
    if (w < MIN_WIDTH) {
      dropNarrow++;
      continue;
    }
    const p = [];
    let lastX = NaN;
    let lastZ = NaN;
    for (const pt of el.geometry) {
      const [lx, lz] = lonLatToLocal(pt.lon, pt.lat);
      const x = Math.round(lx * 10);
      const z = Math.round(lz * 10);
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
    segs.push({
      p,
      w: Math.round(w),
      l: lanes(tags),
      d: oneWayDir(tags),
      k: ROAD_CLASS[tags.highway] ?? 1
    });
  }

  const out = { v: 2, segs };
  mkdirSync(dirname(OUT), { recursive: true });
  const json = JSON.stringify(out);
  writeFileSync(OUT, json);

  console.log(`roads.json written: ${OUT}`);
  console.log(`  segments: ${segs.length}, points: ${ptCount}`);
  console.log(`  dropped: bridge=${dropBridge} narrow(<${MIN_WIDTH}m)=${dropNarrow} short=${dropShort}`);
  console.log(`  size: ${(json.length / 1024 / 1024).toFixed(2)} MB (uncompressed)`);
}

main();
