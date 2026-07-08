// Wildlands grass — the SAME grass as the botanical garden, in the open nature
// regions. It reuses the shared ground-cover blade primitive (garden blades +
// SSS material + wind sway + trample) verbatim; this module only owns the
// SAMPLING: a dense patch that FOLLOWS the player and re-scatters as they move,
// so the cost is fixed regardless of region size and it's free outside the
// regions. Its own group → toggle independently of the garden grass + flowers.

import * as THREE from "three/webgpu";
import {
  createBladeClusterGeometry,
  createGrassMaterial,
  createGrassMesh,
  writeGrassMesh,
  GRASS_DENSITY_FOCUS,
  WIND_DIR,
  type GrassEntry
} from "../groundcover/bladeGrass";
import { inBotanicalGarden, type GardenTerrain } from "../garden/layout";
import { wildRegionAt } from "./layout";

const RING_RADIUS = 52; // dense grass within this of the player; fades at the rim
const RESAMPLE_STEP = 8; // re-scatter after the focus moves this far (m)
const SPACING = 0.95;

function hash2(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function valueNoise(x: number, z: number, cell: number, salt: number): number {
  const fx = x / cell, fz = z / cell;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const ax = fx - ix, az = fz - iz;
  const sx = ax * ax * (3 - 2 * ax), sz = az * az * (3 - 2 * az);
  const n00 = hash2(ix, iz, salt), n10 = hash2(ix + 1, iz, salt);
  const n01 = hash2(ix, iz + 1, salt), n11 = hash2(ix + 1, iz + 1, salt);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sz) + (n01 * (1 - sx) + n11 * sx) * sz;
}

export type WildGrass = {
  group: THREE.Group;
  update(focus: { x: number; z: number }): void;
  stats: { count: number };
};

export function createWildGrass(map: GardenTerrain): WildGrass {
  const group = new THREE.Group();
  group.name = "wildlands_grass";
  const material = createGrassMaterial(); // SHARED garden SSS material
  // same near-tier blade clusters the garden uses up close
  const lowGeo = createBladeClusterGeometry({ blades: 6, segments: 3, width: 0.085, radius: 0.37, curvature: 0.24 });
  const tallGeo = createBladeClusterGeometry({ blades: 8, segments: 4, width: 0.095, radius: 0.48, curvature: 0.4 });

  const cellsAcross = (RING_RADIUS * 2) / SPACING;
  const cap = Math.ceil(cellsAcross * cellsAcross * 0.7) + 256;
  const lowMesh = createGrassMesh("wildlands_grass_low", cap, lowGeo, material, false);
  const tallMesh = createGrassMesh("wildlands_grass_tall", Math.ceil(cap * 0.5), tallGeo, material, false);
  group.add(lowMesh, tallMesh);

  const last = { x: 1e9, z: 1e9 };
  const low: GrassEntry[] = [];
  const tall: GrassEntry[] = [];
  let count = 0;

  function plantable(x: number, z: number): boolean {
    const r = wildRegionAt(x, z);
    if (!r) return false;
    if (inBotanicalGarden(x, z, 6)) return false; // the garden grows its own grass
    if (map.isWater(x, z)) return false;
    return r.plantClasses.includes(map.surfaceType(x, z));
  }

  function resample(fx: number, fz: number) {
    low.length = 0;
    tall.length = 0;
    const r2 = RING_RADIUS * RING_RADIUS;
    const gx0 = Math.floor((fx - RING_RADIUS) / SPACING);
    const gx1 = Math.ceil((fx + RING_RADIUS) / SPACING);
    const gz0 = Math.floor((fz - RING_RADIUS) / SPACING);
    const gz1 = Math.ceil((fz + RING_RADIUS) / SPACING);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const px = gx * SPACING + (hash2(gx, gz, 11) - 0.5) * SPACING * 0.9;
        const pz = gz * SPACING + (hash2(gx, gz, 17) - 0.5) * SPACING * 0.9;
        const dx = px - fx, dz = pz - fz;
        if (dx * dx + dz * dz > r2) continue;
        // density noise → clumps + clearings, not an even carpet
        const patch = valueNoise(px, pz, 26, 701);
        if (hash2(gx, gz, 23) > 0.5 + patch * 0.5) continue;
        if (!plantable(px, pz)) continue;
        const y = map.groundHeight(px, pz) - 0.04;

        const isTall = hash2(gx, gz, 31) < 0.26 * (0.7 + patch * 0.6);
        const heightBase = isTall ? 0.9 + hash2(gx, gz, 37) * 0.7 : 0.46 + hash2(gx, gz, 41) * 0.4;
        const spread = (isTall ? 1.05 : 0.82) * (0.82 + hash2(gx, gz, 43) * 0.36);
        const yaw = hash2(gx, gz, 47) * Math.PI * 2;
        const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
        const windAmp = (0.74 + heightBase * 0.34) * (isTall ? 1.08 : 1);
        const brightness = 0.86 + hash2(gx, gz, 29) * 0.26;
        const dry = (1 - patch) * 0.2;
        const entry: GrassEntry = {
          x: px,
          y,
          z: pz,
          yaw,
          height: heightBase,
          spread,
          color: new THREE.Color(
            brightness * (0.6 + dry * 0.28),
            brightness * (0.92 - dry * 0.14),
            brightness * (0.4 - dry * 0.06)
          ),
          windX: ((cosY * WIND_DIR.x - sinY * WIND_DIR.z) / spread) * windAmp,
          windZ: ((sinY * WIND_DIR.x + cosY * WIND_DIR.z) / spread) * windAmp
        };
        (isTall ? tall : low).push(entry);
      }
    }
    writeGrassMesh(lowMesh, low, RING_RADIUS);
    writeGrassMesh(tallMesh, tall, RING_RADIUS);
    count = low.length + tall.length;
  }

  return {
    group,
    update(focus) {
      const dx = focus.x - last.x, dz = focus.z - last.z;
      if (dx * dx + dz * dz < RESAMPLE_STEP * RESAMPLE_STEP) return;
      last.x = focus.x;
      last.z = focus.z;
      // shared fade focus → blades collapse toward the ring rim (hides the pop)
      GRASS_DENSITY_FOCUS.value.set(focus.x, focus.z);
      resample(focus.x, focus.z);
    },
    get stats() {
      return { count };
    }
  };
}
