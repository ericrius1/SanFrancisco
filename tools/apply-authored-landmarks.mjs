#!/usr/bin/env node
// Destructively make the committed world data match the authored Blender scene.
// This is an offline bake step, not a runtime suppression layer: the Palace OSM
// buildings cease to exist in CityGen and collider payloads, and the authored
// column/piers become the only physical representation.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PALACE_BIDS = new Set([570, 571, 572, 573, 574]);
const PALACE_LM_INDEX = 100007;
const G = 2.76327908039093;

const round = (n, places = 1) => {
  const p = 10 ** places;
  return Math.round(n * p) / p;
};

function palaceColliders() {
  const out = [];
  const box = (x, z, y, hy, hx, hz, yaw = 0) => out.push({
    lm: "palace",
    x: round(x), z: round(z), y: round(y), hy: round(hy),
    hx: round(hx), hz: round(hz), yaw: round(yaw, 3)
  });

  // Walkable plinth plus the eight rotunda pier masses between the open arches.
  box(-388, -1426, G - 0.18, 1.65, 13, 13);
  const step = (Math.PI * 2) / 8;
  for (let k = 0; k < 8; k++) {
    const a = k * step + step / 2;
    box(-388 + Math.cos(a) * 14.5, -1426 - Math.sin(a) * 14.5, G + 11.8, 10.65, 2.5, 2.0, a);
  }

  // Detached north/south peristyles. Regular bays use one shaft; each end and
  // midpoint pavilion uses the authored four-column cluster plus a landable cap.
  const spans = [
    [112 * Math.PI / 180, 165 * Math.PI / 180, 17],
    [195 * Math.PI / 180, 238 * Math.PI / 180, 14]
  ];
  for (const [a0, a1, count] of spans) {
    const mid = Math.floor((count - 1) / 2);
    for (let k = 0; k < count; k++) {
      const a = a0 + (a1 - a0) * k / (count - 1);
      const x = -300 + Math.cos(a) * 112;
      const z = -1426 + Math.sin(a) * 112;
      if (k === 0 || k === mid || k === count - 1) {
        const tx = -Math.sin(a), tz = Math.cos(a);
        const rx = Math.cos(a), rz = Math.sin(a);
        for (const tangent of [-1.75, 1.75]) for (const radial of [-1.5, 1.5]) {
          box(x + tx * tangent + rx * radial, z + tz * tangent + rz * radial,
            G + 7.3, 7.75, 1.35, 1.35);
        }
        box(x, z, G + 19.25, 2.15, 5.1, 3.55, a + Math.PI / 2);
      } else {
        box(x, z, G + 7.3, 7.75, 1.25, 1.25);
      }
    }
  }
  return out;
}

async function readJson(rel) {
  return JSON.parse(await readFile(path.join(ROOT, rel), "utf8"));
}

async function writeJson(rel, data) {
  await writeFile(path.join(ROOT, rel), JSON.stringify(data));
}

const authored = palaceColliders();

const citygen = await readJson("public/citygen/buildings.json");
const oldCitygen = citygen.cells["8_9"] ?? [];
citygen.cells["8_9"] = oldCitygen.filter((building) => !PALACE_BIDS.has(building.i));
await writeJson("public/citygen/buildings.json", citygen);

const landmarkColliders = await readJson("data/landmark-colliders.json");
const firstPalace = landmarkColliders.findIndex((collider) => collider.lm === "palace");
const withoutPalace = landmarkColliders.filter((collider) => collider.lm !== "palace");
withoutPalace.splice(firstPalace < 0 ? withoutPalace.length : firstPalace, 0, ...authored);
await writeJson("data/landmark-colliders.json", withoutPalace);

const tileColliders = await readJson("public/data/colliders/tile_8_9.json");
const keptTile = tileColliders.filter((collider) =>
  !PALACE_BIDS.has(collider.i) && collider.i !== PALACE_LM_INDEX
);
keptTile.push(...authored.map(({ lm: _lm, ...collider }) => ({
  i: PALACE_LM_INDEX,
  p: 7,
  ...collider,
  vol: 1_000_000_000
})));
await writeJson("public/data/colliders/tile_8_9.json", keptTile);

console.log(JSON.stringify({
  citygenRemoved: oldCitygen.length - citygen.cells["8_9"].length,
  palaceColliders: authored.length,
  tileColliderCount: keptTile.length
}, null, 2));
