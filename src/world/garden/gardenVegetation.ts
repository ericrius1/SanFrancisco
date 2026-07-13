// Browser-side rendering for the San Francisco Botanical Garden. Layout math
// (tree/shrub/flora placement, zones, meadow, paths, colliders) is
// deterministic and lives in src/sim/botanicalGarden.ts so the headless
// trainer reconstructs identical obstacles; this module only turns those lists
// into instanced meshes. Performance-first: one compiled geometry per species
// shared by every instance, vertex colours + per-instance tint instead of
// textures, ~20 draw calls for the whole garden.

import * as THREE from "three/webgpu";
import {
  buildGardenProxyBuffers,
  buildGardenTreeColliders,
  collectGardenFlora,
  collectGardenShrubs,
  collectGardenTrees,
  type GardenCollider,
  type GardenFlora,
  type GardenShrub,
  type GardenTerrain,
  type GardenTree
} from "./layout";
import { buildBotanicalGrass, type BotanicalGrassController } from "./botanicalGrass";
import { NATIVE_TREE_DESIGNS } from "./treeDesigns";
import { setLocalFarShadowOnly } from "../shadows/shadowLayers";
import {
  createAuthoredFlowerPatch,
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

export type GardenVegetation = {
  group: THREE.Group;
  /** Resolves once the asynchronous shared tree patch is ready. */
  ready: Promise<void>;
  update(focus: { x: number; z: number }): void;
  /** hidden trunk+canopy proxy mesh for the surface raycaster (BVH) */
  proxy: THREE.Mesh;
  grass: BotanicalGrassController;
  colliders: GardenCollider[];
  stats: { trees: number; shrubs: number; flora: number; drawCalls: number };
};

// Shrub palettes, indexed by GardenShrub.palette (zone-driven):
// 0 rhododendron  1 fern understory  2 camellia  3 protea  4 lavender  5 manzanita
const SHRUB_PALETTES: { foliageA: number; foliageB: number; blooms: number[]; bloomChance: number }[] = [
  { foliageA: 0x2f5c2e, foliageB: 0x477a38, blooms: [0xc25a8a, 0xd88bb4, 0xb44a55, 0xe8dbe0], bloomChance: 0.34 },
  { foliageA: 0x27502a, foliageB: 0x3f7a33, blooms: [0x5c9440], bloomChance: 0.12 },
  { foliageA: 0x24461f, foliageB: 0x3a6b2e, blooms: [0xe8e4da, 0xc94b5e, 0xe3a8c8], bloomChance: 0.3 },
  { foliageA: 0x4f5f3c, foliageB: 0x6d7a4a, blooms: [0xd97a2e, 0xe0a832, 0xc4523a], bloomChance: 0.32 },
  { foliageA: 0x5d6b58, foliageB: 0x77836b, blooms: [0x8a6bbf, 0x9a7fd1, 0x7458a8], bloomChance: 0.4 },
  { foliageA: 0x33512c, foliageB: 0x4a3826, blooms: [0x8a4a3a, 0x6d3b2e], bloomChance: 0.22 }
];

// Flora palettes, indexed by GardenFlora.palette:
// 0 grass tufts  1 fern floor  2 poppies  3 flower beds
const FLOWER_BED_SPECIES: readonly AuthoredFlowerSpecies[] = ["lupine", "yarrow", "goldfield"];

function buildProxyGeometry(trees: GardenTree[]): THREE.BufferGeometry {
  const buf = buildGardenProxyBuffers(trees);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(buf.positions, 3));
  geometry.setIndex(buf.indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function shrubProfile(shrub: GardenShrub): AuthoredShrubProfile {
  if (shrub.palette === 1) return "fern";
  if (shrub.palette === 0 || shrub.palette === 2) return "azalea";
  return "natural";
}

function authoredShrub(shrub: GardenShrub): AuthoredShrubPlacement {
  return {
    x: shrub.x,
    y: shrub.y,
    z: shrub.z,
    yaw: shrub.yaw,
    scale: shrub.scale,
    palette: shrub.palette,
    profile: shrubProfile(shrub),
    tint: shrub.tint
  };
}

function authoredTreeFern(tree: GardenTree): AuthoredShrubPlacement {
  return {
    x: tree.x,
    y: tree.y,
    z: tree.z,
    yaw: tree.yaw,
    // The shared fern is authored at understory scale. Garden tree ferns keep
    // their existing specimen-sized footprint through this calibrated scale.
    scale: tree.scale * 1.8,
    palette: 1,
    profile: "fern",
    tint: Math.abs(Math.sin(tree.x * 12.9898 + tree.z * 78.233) * 43758.5453) % 1,
    wind: 0.82
  };
}

function authoredFlower(flora: GardenFlora): AuthoredFlowerPlacement {
  const species = flora.palette === 2
    ? "poppy"
    : FLOWER_BED_SPECIES[Math.min(FLOWER_BED_SPECIES.length - 1, Math.floor(flora.tint * FLOWER_BED_SPECIES.length))];
  return {
    x: flora.x,
    y: flora.y,
    z: flora.z,
    yaw: flora.yaw,
    scale: flora.scale * 1.35,
    species,
    tint: flora.tint
  };
}

export function createGardenVegetation(map: GardenTerrain): GardenVegetation {
  const trees = collectGardenTrees(map);
  const shrubs = collectGardenShrubs(map);
  const flora = collectGardenFlora(map);

  const group = new THREE.Group();
  group.name = "sf_botanical_garden";

  const treeArchetypes: AuthoredTreeArchetype[] = [];
  const archetypeBySpecies = new Map<number, string>();
  NATIVE_TREE_DESIGNS.forEach((design, species) => {
    if (!design) return;
    const id = `sfbg-species-${species}`;
    archetypeBySpecies.set(species, id);
    treeArchetypes.push({ id, design });
  });
  const authoredTrees: AuthoredTreePlacement[] = trees.flatMap((tree) => {
    const archetype = archetypeBySpecies.get(tree.species);
    return archetype
      ? [{
        x: tree.x,
        y: tree.y,
        z: tree.z,
        yaw: tree.yaw,
        scale: tree.scale,
        archetype,
        nearDetail: tree.nearDetail
      }]
      : [];
  });
  const treePatch = createAuthoredTreePatch(treeArchetypes, authoredTrees, {
    name: "sf_botanical_garden_trees",
    chunkSize: 128,
    visibleDistance: 1050,
    nearRadius: 58,
    nearExitRadius: 66,
    nearMax: 24,
    horizonDistance: 520
  });
  group.add(treePatch.group);

  // Tree ferns use the same leaf-spray + shared-wind renderer as fern
  // understory, with a trunk authored into the shared fern profile. Their
  // stable low-poly proxy remains the dedicated distant shadow caster.
  const treeFerns = trees.filter((tree) => !NATIVE_TREE_DESIGNS[tree.species]);
  const fernPatch = createAuthoredShrubPatch(treeFerns.map(authoredTreeFern), {
    name: "sfbg_tree_ferns",
    palettes: SHRUB_PALETTES
  });
  group.add(fernPatch.group);
  if (treeFerns.length > 0) {
    const fernShadow = new THREE.Mesh(
      buildProxyGeometry(treeFerns),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    fernShadow.name = "sfbg_fern_shadow_proxy";
    fernShadow.castShadow = true;
    fernShadow.receiveShadow = false;
    setLocalFarShadowOnly(fernShadow);
    group.add(fernShadow);
  }

  // Shared trees stream in asynchronously; colliders/proxy below come from the
  // full deterministic layout and are live immediately. Near LOD self-drives;
  // update() below only advances chunk distance culling.
  const ready = treePatch.ready
    .then(() => {
      console.log(
        `[sfbg] unified trees online: ${treePatch.stats.archetypes} archetypes, ${treePatch.stats.placements} trees, ${treePatch.stats.chunks()} chunks`
      );
    })
    .catch((e) => console.error("[sfbg] shared trees failed — fern and ground planting remain:", e));

  const shrubPatch = createAuthoredShrubPatch(shrubs.map(authoredShrub), {
    name: "sfbg_shrubs",
    palettes: SHRUB_PALETTES
  });
  group.add(shrubPatch.group);

  // Botanical grass owns the plain grass/fern-floor flora palettes. Poppy and
  // path-bed placements now use the same curved, multi-stem, wind-responsive
  // clumps as every other authored flower patch.
  const flowerPatch = createAuthoredFlowerPatch(
    flora.filter((entry) => entry.palette === 2 || entry.palette === 3).map(authoredFlower),
    {
      name: "sfbg_flowers",
      palettes: {
        poppy: { a: 0xe8863a, b: 0xf0a04a },
        lupine: { a: 0x8a6bbf, b: 0xb49ad8 },
        yarrow: { a: 0xece4d4, b: 0xe4b45e },
        goldfield: { a: 0xd4707e, b: 0xe38ba8 }
      }
    }
  );
  group.add(flowerPatch.group);

  const grass = buildBotanicalGrass(map, trees);
  group.add(grass);

  const proxy = new THREE.Mesh(
    buildProxyGeometry(trees),
    new THREE.MeshBasicMaterial({ color: 0x00ffaa, wireframe: true })
  );
  proxy.name = "sf_botanical_garden_bvh_proxy";
  proxy.visible = false;
  group.add(proxy);

  return {
    group,
    ready,
    update(focus) {
      treePatch.update(focus);
    },
    proxy,
    grass,
    colliders: buildGardenTreeColliders(trees),
    stats: {
      trees: trees.length,
      shrubs: shrubs.length,
      flora: flora.length,
      drawCalls: fernPatch.stats.draws + shrubPatch.stats.draws + flowerPatch.stats.draws
    }
  };
}
