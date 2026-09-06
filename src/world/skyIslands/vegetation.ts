/**
 * Botanical intent for the sky archipelago. Geometry, instancing, wind, LOD,
 * and culling all remain owned by the shared vegetation runtime.
 */

import * as THREE from "three/webgpu";
import {
  createAuthoredFlowerPatch,
  type AuthoredFlowerForm,
  type AuthoredFlowerPlacement,
  type AuthoredFlowerSpecies
} from "../vegetation/authoredFlowers";
import {
  createAuthoredShrubPatch,
  type AuthoredShrubPlacement,
  type AuthoredShrubProfile
} from "../vegetation/authoredShrubs";
import {
  createAuthoredTreePatch,
  type AuthoredTreeArchetype,
  type AuthoredTreePlacement
} from "../vegetation/authoredTrees";
import { installSkyAlienFlowerForms } from "../vegetation/alienFlowerForms";
import { getSkyIsland, type SkyIslandId, type SkyIslandMetadata } from "./metadata";

export type SkyIslandVegetation = {
  group: THREE.Group;
  ready: Promise<void>;
  update(focus: { x: number; z: number }, force?: boolean): void;
  dispose(): void;
  stats: { trees: number; shrubs: number; flowerClumps: number; flowerHeads: number };
};

type FloraTheme = {
  baseSpecies: AuthoredFlowerSpecies;
  form: AuthoredFlowerForm;
  secondaryForm: AuthoredFlowerForm;
  flowerA: number;
  flowerB: number;
  leafA: number;
  leafB: number;
  shrubBloom: number;
  shrubProfile: AuthoredShrubProfile;
  treeSpecies: AuthoredTreeArchetype["design"]["species"];
  treeFoliage: number;
  treeBark: number;
  flowerCount: number;
  shrubCount: number;
  treeCount: number;
};

const THEMES: Record<SkyIslandId, FloraTheme> = {
  "first-breath": {
    baseSpecies: "lupine",
    form: "starbell",
    secondaryForm: "moon-cup",
    flowerA: 0x7fffe9,
    flowerB: 0xf9e6a6,
    leafA: 0x224f49,
    leafB: 0x4b8f7b,
    shrubBloom: 0x91ffec,
    shrubProfile: "fern",
    treeSpecies: "ginkgo",
    treeFoliage: 0x65b99c,
    treeBark: 0x594f43,
    flowerCount: 124,
    shrubCount: 20,
    treeCount: 4
  },
  "opal-memory": {
    baseSpecies: "poppy",
    form: "prism-orchid",
    secondaryForm: "starbell",
    flowerA: 0xff72dc,
    flowerB: 0x77dcff,
    leafA: 0x2d466b,
    leafB: 0x6673a2,
    shrubBloom: 0xf09bff,
    shrubProfile: "natural",
    treeSpecies: "magnolia",
    treeFoliage: 0x8064a2,
    treeBark: 0x5e526a,
    flowerCount: 148,
    shrubCount: 24,
    treeCount: 5
  },
  "broken-orrery": {
    baseSpecies: "goldfield",
    form: "starbell",
    secondaryForm: "prism-orchid",
    flowerA: 0xffc84a,
    flowerB: 0x679fff,
    leafA: 0x51462d,
    leafB: 0x82723d,
    shrubBloom: 0xffdc68,
    shrubProfile: "coastal-scrub",
    treeSpecies: "japanese-black-pine",
    treeFoliage: 0x626b42,
    treeBark: 0x59432e,
    flowerCount: 102,
    shrubCount: 14,
    treeCount: 3
  },
  moonwell: {
    baseSpecies: "yarrow",
    form: "moon-cup",
    secondaryForm: "starbell",
    flowerA: 0xe8f1ff,
    flowerB: 0xa8c8ff,
    leafA: 0x30415b,
    leafB: 0x627b8c,
    shrubBloom: 0xc7e6ff,
    shrubProfile: "fern",
    treeSpecies: "japanese-maple",
    treeFoliage: 0x8ca0bc,
    treeBark: 0x57566a,
    flowerCount: 156,
    shrubCount: 26,
    treeCount: 6
  },
  "last-seed": {
    baseSpecies: "poppy",
    form: "prism-orchid",
    secondaryForm: "moon-cup",
    flowerA: 0xff8eb9,
    flowerB: 0xffe089,
    leafA: 0x42365f,
    leafB: 0x765c83,
    shrubBloom: 0xffa2cf,
    shrubProfile: "azalea",
    treeSpecies: "flowering-cherry",
    treeFoliage: 0xb97199,
    treeBark: 0x664655,
    flowerCount: 138,
    shrubCount: 22,
    treeCount: 5
  }
};

function hash(index: number, salt: number): number {
  const v = Math.sin(index * 91.713 + salt * 37.119) * 43758.5453;
  return v - Math.floor(v);
}

/** Exact analytic sphere height, used for every upright top-cap planting. */
function topSurfaceY(island: SkyIslandMetadata, dx: number, dz: number): number {
  return island.center.y + Math.sqrt(Math.max(0, island.bodyRadius ** 2 - dx * dx - dz * dz));
}

function collectFlowers(island: SkyIslandMetadata, theme: FloraTheme): AuthoredFlowerPlacement[] {
  const placements: AuthoredFlowerPlacement[] = [];
  const spiralTurns = island.id === "broken-orrery" ? 4.2 : 3.1;
  const capRadius = island.bodyRadius * 0.52;
  for (let i = 0; i < theme.flowerCount; i++) {
    const u = (i + 0.5) / theme.flowerCount;
    const angle = u * Math.PI * 2 * spiralTurns + hash(i, 4) * 0.45;
    const radius = 4.5 + Math.sqrt(u) * (capRadius - 7) + (hash(i, 7) - 0.5) * 3;
    const dx = Math.cos(angle) * radius;
    const dz = Math.sin(angle) * radius;
    placements.push({
      x: island.center.x + dx,
      y: topSurfaceY(island, dx, dz) + 0.06,
      z: island.center.z + dz,
      yaw: angle + hash(i, 10) * Math.PI,
      scale: 1.15 + hash(i, 13) * 1.05,
      species: theme.baseSpecies,
      form: i % 3 === 0 ? theme.secondaryForm : theme.form,
      tint: hash(i, 16)
    });
  }
  return placements;
}

function collectShrubs(island: SkyIslandMetadata, theme: FloraTheme): AuthoredShrubPlacement[] {
  const placements: AuthoredShrubPlacement[] = [];
  const capRadius = island.bodyRadius * 0.52;
  for (let i = 0; i < theme.shrubCount; i++) {
    const angle = (i / theme.shrubCount) * Math.PI * 2 + hash(i, 21) * 0.7;
    const radius = capRadius * (0.58 + hash(i, 24) * 0.27);
    const dx = Math.cos(angle) * radius;
    const dz = Math.sin(angle) * radius;
    placements.push({
      x: island.center.x + dx,
      y: topSurfaceY(island, dx, dz),
      z: island.center.z + dz,
      yaw: angle + Math.PI,
      scale: 0.72 + hash(i, 27) * 0.62,
      palette: 0,
      profile: theme.shrubProfile,
      tint: hash(i, 30),
      wind: 0.78 + hash(i, 33) * 0.22
    });
  }
  return placements;
}

function collectTrees(island: SkyIslandMetadata, theme: FloraTheme): AuthoredTreePlacement[] {
  const placements: AuthoredTreePlacement[] = [];
  const capRadius = island.bodyRadius * 0.52;
  for (let i = 0; i < theme.treeCount; i++) {
    const angle = (i / theme.treeCount) * Math.PI * 2 + 0.55 + hash(i, 37) * 0.5;
    const radius = capRadius * (0.42 + hash(i, 40) * 0.18);
    const dx = Math.cos(angle) * radius;
    const dz = Math.sin(angle) * radius;
    placements.push({
      x: island.center.x + dx,
      y: topSurfaceY(island, dx, dz),
      z: island.center.z + dz,
      yaw: angle + hash(i, 43) * 0.8,
      scale: 0.48 + hash(i, 46) * 0.24,
      archetype: `${island.id}-tree`,
      nearDetail: true
    });
  }
  return placements;
}

/** Built by one SiteFoliageStreamer registration per island. */
export function createSkyIslandVegetation(id: SkyIslandId): SkyIslandVegetation {
  installSkyAlienFlowerForms();
  const island = getSkyIsland(id);
  const theme = THEMES[id];
  const flowersIntent = collectFlowers(island, theme);
  const shrubsIntent = collectShrubs(island, theme);
  const treesIntent = collectTrees(island, theme);
  const group = new THREE.Group();
  group.name = `sky_island_vegetation_${id}`;

  const flowers = createAuthoredFlowerPatch(flowersIntent, {
    name: `sky_island_${id}_alien_flowers`,
    palettes: {
      [theme.form]: { a: theme.flowerA, b: theme.flowerB },
      [theme.secondaryForm]: { a: theme.flowerB, b: island.palette.glow }
    }
  });
  const shrubs = createAuthoredShrubPatch(shrubsIntent, {
    name: `sky_island_${id}_shrubs`,
    palettes: [{
      foliageA: theme.leafA,
      foliageB: theme.leafB,
      blooms: [theme.shrubBloom, theme.flowerB],
      bloomChance: 0.32
    }]
  });
  const treeArchetypes: readonly AuthoredTreeArchetype[] = [{
    id: `${id}-tree`,
    design: {
      species: theme.treeSpecies,
      seed: 8100 + island.story.order * 97,
      controls: {
        height: 9 + island.story.order * 0.7,
        crownDensity: 0.86,
        crownWidth: 0.94,
        foliageColor: theme.treeFoliage,
        barkColor: theme.treeBark,
        windResponse: 0.72,
        leafColorVariant: null
      },
      sink: 0.22
    }
  }];
  const trees = createAuthoredTreePatch(treeArchetypes, treesIntent, {
    name: `sky_island_${id}_trees`,
    chunkSize: 64,
    visibleDistance: 520,
    nearRadius: 90,
    nearExitRadius: 112,
    nearMax: 12
  });

  group.add(flowers.group, shrubs.group, trees.group);
  group.userData.skyIslandId = id;
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
      shrubs.dispose();
      flowers.dispose();
      group.removeFromParent();
      group.clear();
    },
    stats: {
      trees: treesIntent.length,
      shrubs: shrubsIntent.length,
      flowerClumps: flowers.stats.instances,
      flowerHeads: flowers.stats.heads
    }
  };
}
