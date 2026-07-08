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
import { hash2, valueNoise } from "../groundcover/scatter";
import type { GardenTerrain } from "../garden/layout";
import { grassyGround } from "./layout";
import { GRASS_TUNING } from "../../config";

const RING_RADIUS = 52; // dense grass within this of the player; fades at the rim
const RESAMPLE_STEP = 8; // re-scatter after the focus moves this far (m)
const SPACING = 0.95;

export type WildGrass = {
  group: THREE.Group;
  update(focus: { x: number; z: number }): void;
  /** force an immediate re-scatter at the last focus (debug slider release) */
  refresh(): void;
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

  // Grass grows exactly where the shared ground-cover gate allows — the same
  // predicate the flower ring uses, so blooms always sit IN the grass (and both
  // skip water, wrong surfaces, the botanical garden's turf, and steep faces).
  const plantable = (x: number, z: number) => grassyGround(map, x, z);

  function resample(fx: number, fz: number) {
    // live tuning: density scales the count, patchiness blends even↔clumpy.
    // Wind is untouched here — it comes from the global WIND_DIR/sway envelope.
    const density = Math.max(0, GRASS_TUNING.values.density as number);
    const patchiness = Math.min(1, Math.max(0, GRASS_TUNING.values.patchiness as number));
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
        // density noise → clumps + clearings, not an even carpet.
        // keep = density · lerp(evenLawn, patchNoise, patchiness). At the
        // defaults (density 1, patchiness 0.5) this is exactly 0.5 + 0.5·patch,
        // the original look; patchiness 0 = even lawn, 1 = full clumps/clearings.
        const patch = valueNoise(px, pz, 26, 701);
        const keep = Math.min(1, density * ((1 - patchiness) + patchiness * patch));
        if (hash2(gx, gz, 23) > keep) continue;
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
    refresh() {
      if (last.x < 1e8) resample(last.x, last.z);
    },
    get stats() {
      return { count };
    }
  };
}
