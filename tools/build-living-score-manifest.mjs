#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "public/audio/music");
const REQUIRED_PROFILES = new Set([
  "golden-gate-canopy",
  "tea-garden-stillness",
  "pacific-tide",
  "sutro-memory",
  "presidio-fog",
  "marin-sky",
  "afterlight-cosmos",
  "mission-sun",
  "downtown-neon",
  "bay-lights",
  "city-rain",
  "california-gold"
]);
const sets = [];
const ids = new Set();
for (const entry of readdirSync(root).sort()) {
  const setPath = join(root, entry, "set.json");
  if (!existsSync(setPath)) continue;
  const set = JSON.parse(readFileSync(setPath, "utf8"));
  if (!set.id || ids.has(set.id)) throw new Error(`duplicate or missing living-score id ${set.id}`);
  if (!REQUIRED_PROFILES.has(set.profile)) throw new Error(`unknown living-score profile ${set.profile}`);
  if (!Number.isFinite(set.durationSeconds) || set.durationSeconds <= 0) {
    throw new Error(`invalid living-score duration for ${set.id}`);
  }
  ids.add(set.id);
  for (const stem of set.stems) {
    const asset = join(root, stem.url.replace(/^\/audio\/music\//, ""));
    if (!existsSync(asset) || statSync(asset).size === 0) {
      throw new Error(`missing living-score asset ${stem.url}`);
    }
  }
  sets.push(set);
}
if (!sets.length) throw new Error(`no living-score set.json files under ${root}`);
const installedProfiles = new Set(sets.map((set) => set.profile));
const missingProfiles = [...REQUIRED_PROFILES].filter((profile) => !installedProfiles.has(profile));
if (missingProfiles.length) {
  throw new Error(`missing living-score profiles: ${missingProfiles.join(", ")}`);
}
const totalStemSeconds = sets.reduce(
  (total, set) => total + set.durationSeconds * set.stems.length,
  0
);
if (totalStemSeconds < 10_800) {
  throw new Error(`living-score library is ${(totalStemSeconds / 3600).toFixed(2)}h; 3.00h required`);
}
const manifest = {
  schema: 1,
  generatedWith: "Suno v5.5 + Suno Studio multitrack stems",
  totalStemSeconds: Number(totalStemSeconds.toFixed(3)),
  sets
};
writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[living-score] ${sets.length} sets, ${(totalStemSeconds / 3600).toFixed(2)} stem-hours`);
