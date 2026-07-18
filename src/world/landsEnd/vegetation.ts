// Lazy Lands End adapter for the shared vegetation runtime. This module is
// imported only on first approach to the headland, keeping tree templates and
// their optional texture packs out of a clean boot.
//
// The region owns botanical intent only (a wind-bent cypress ring on the
// plateau around the labyrinth). The shared NativeTreeForest owns compilation,
// instanced geometry, wind-shaded foliage, LOD grades, chunk culling and
// shadow proxies — the same path every other park and landmark plants through.

import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import {
  createAuthoredTreePatch,
  type AuthoredTreeArchetype,
  type AuthoredTreePlacement
} from "../vegetation/authoredTrees";
import { LABYRINTH } from "./layout";

export type LandsEndFoliage = {
  group: THREE.Group;
  ready: Promise<void>;
  update(focus: { x: number; z: number }, force?: boolean): void;
  dispose(): void;
  stats: { trees: number };
};

function hash(n: number): number {
  const s = Math.sin(n * 91.17 + 12.3) * 43758.5453;
  return s - Math.floor(s);
}

// Two windswept individuals so neighbouring trees never read as clones: a
// taller sea-dark elder and a squatter, paler shelf. Colors sit slightly
// grey-green of the Buena Vista stands — salt-pruned coastal foliage.
const TREE_ARCHETYPES: readonly AuthoredTreeArchetype[] = [
  {
    id: "headland-cypress-elder",
    design: {
      species: "windswept-monterey-cypress",
      seed: 7741,
      controls: {
        height: 13.5,
        crownDensity: 1.0,
        crownWidth: 1.06,
        foliageColor: 0x345238,
        windResponse: 0.5
      },
      sink: 0.3
    }
  },
  {
    id: "headland-cypress-shelf",
    design: {
      species: "windswept-monterey-cypress",
      seed: 7742,
      controls: {
        height: 10.5,
        crownDensity: 0.92,
        crownWidth: 1.14,
        foliageColor: 0x3d5c40,
        windResponse: 0.56
      },
      sink: 0.3
    }
  }
] as const;

/** Same grove intent as the old hand-built ring: cypress on the plateau shelf
 *  around the labyrinth, clear of the stones, never down the sea cliff. */
function collectPlacements(map: WorldMap): AuthoredTreePlacement[] {
  const placements: AuthoredTreePlacement[] = [];
  const count = 14;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + hash(i) * 0.5;
    const rad = LABYRINTH.radius + 8 + hash(i + 20) * 16; // 20..36 m out
    const x = LABYRINTH.x + Math.cos(ang) * rad;
    const z = LABYRINTH.z + Math.sin(ang) * rad;
    const gy = map.groundTop(x, z);
    // stay on the plateau shelf — skip the sea cliff / water so nothing floats
    if (map.isWater(x, z) || gy < 55) continue;
    placements.push({
      x,
      y: gy,
      z,
      // Narrow yaw band keeps the recipe's built-in lean coherent across the
      // grove — one prevailing sea wind, not fourteen random ones.
      yaw: 0.9 + hash(i + 100) * 0.7,
      scale: 0.78 + hash(i + 5) * 0.34,
      archetype: i % 3 === 2 ? "headland-cypress-shelf" : "headland-cypress-elder",
      nearDetail: true
    });
  }
  return placements;
}

export function createLandsEndFoliage(map: WorldMap): LandsEndFoliage {
  const placements = collectPlacements(map);
  const group = new THREE.Group();
  group.name = "landsEnd.unified_foliage";

  const trees = createAuthoredTreePatch(TREE_ARCHETYPES, placements, {
    name: "lands_end_cypress",
    chunkSize: 48,
    // Landscape range: the grove reads from the far shore and survives the
    // gameplay site unloading behind the player (site-foliage streamer radii).
    visibleDistance: 1300,
    nearRadius: 96,
    nearExitRadius: 120,
    nearMax: 8
  });
  group.add(trees.group);

  let disposed = false;
  return {
    group,
    ready: trees.ready,
    update(focus, force = false) {
      if (!disposed) trees.update(focus, force);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      trees.dispose();
      group.removeFromParent();
    },
    stats: { trees: placements.length }
  };
}
