import * as THREE from "three/webgpu";
import {
  createAuthoredShrubPatch,
  type AuthoredShrubPalette,
  type AuthoredShrubPlacement
} from "../vegetation/authoredShrubs";
import {
  createAuthoredTreePatch,
  type AuthoredTreeArchetype,
  type AuthoredTreePlacement
} from "../vegetation/authoredTrees";
import {
  createAuthoredFlowerPatch,
  type AuthoredFlowerPlacement,
  type AuthoredFlowerSpecies
} from "../vegetation/authoredFlowers";
import { SUTRO_BATHS, sutroLocalToWorld } from "./layout";

export type SutroBathsVegetation = {
  group: THREE.Group;
  ready: Promise<void>;
  update(focus: { x: number; z: number }, force?: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
  stats: { trees: number; shrubs: number; planters: number; flowers: number };
};

const TREE_ARCHETYPES: readonly AuthoredTreeArchetype[] = [
  /**
   * The conservatory canopy. Magnolia carries the planting because it is the one
   * recipe here with a real tree's structure — three branch levels, up to a
   * hundred and sixty branches, foliage hung off the twigs — so it reads as a
   * tree from any angle. The palm recipe has no branch levels at all: it is a
   * trunk with at most a handful of frond rosettes, which from underneath is a
   * flat starburst and nothing like a plant.
   */
  {
    id: "gallery-magnolia",
    design: {
      species: "magnolia",
      seed: 18962,
      controls: {
        height: 7.2,
        crownDensity: 1.8,
        crownWidth: 1.0,
        // Warmer and a shade lighter than the wild recipe: these live under
        // glass and candlelight, not on a fog-grey headland, and a saturated
        // cold green goes to pure black once the pocket twilight settles.
        foliageColor: 0x53744a,
        foliageTint: 0xa3b06c,
        windResponse: 0.22
      },
      sink: 0.1
    }
  },
  {
    id: "gallery-magnolia-low",
    design: {
      species: "magnolia",
      seed: 18965,
      controls: {
        height: 5.1,
        crownDensity: 1.8,
        crownWidth: 1.18,
        foliageColor: 0x4d7047,
        foliageTint: 0x9aa966,
        windResponse: 0.2
      },
      sink: 0.12
    }
  },
  {
    /**
     * The big specimens: a spreading oak crown at the north bank and either side
     * of the grand stair. Palms were the obvious choice for a bath house, but
     * that recipe has no branch levels at all — a trunk with three frond
     * rosettes, which reads as a flat asterisk at every height and distance. Two
     * dense broadleaf recipes make a far better conservatory, and cost four
     * fewer pipeline signatures than keeping the palm as a third species.
     */
    id: "conservatory-specimen",
    design: {
      species: "coast-live-oak",
      seed: 18966,
      controls: {
        height: 9.4,
        crownDensity: 1.7,
        crownWidth: 1.2,
        foliageColor: 0x56784a,
        foliageTint: 0xa6b26e,
        windResponse: 0.24
      },
      sink: 0.1
    }
  }
] as const;

const TREE_LAYOUT = [
  // North conservatory bank: the big specimen crowns, read against the north
  // glass.
  { x: -18, z: -66, scale: 0.92, archetype: "conservatory-specimen" },
  { x: 2, z: -67, scale: 1, archetype: "conservatory-specimen" },
  { x: 21, z: -66, scale: 0.88, archetype: "conservatory-specimen" },
  { x: -28, z: -65, scale: 0.9, archetype: "gallery-magnolia" },
  { x: -8, z: -66.5, scale: 0.95, archetype: "gallery-magnolia" },
  { x: 30, z: -64, scale: 0.85, archetype: "gallery-magnolia" },
  // East gallery avenue, one between each pair of tea tables
  { x: 29.6, z: -48, scale: 0.9, archetype: "gallery-magnolia" },
  { x: 29.6, z: -22, scale: 1, archetype: "gallery-magnolia" },
  { x: 29.6, z: 4, scale: 0.92, archetype: "gallery-magnolia-low" },
  { x: 29.6, z: 30, scale: 0.96, archetype: "gallery-magnolia" },
  { x: 30.5, z: 38, scale: 0.86, archetype: "gallery-magnolia-low" },
  { x: 29.6, z: 52, scale: 0.9, archetype: "gallery-magnolia" },
  // West ocean gallery — deliberately low so nothing blocks the sunset windows
  { x: -37.6, z: -52, scale: 0.82, archetype: "gallery-magnolia-low" },
  { x: -37.6, z: -12, scale: 0.86, archetype: "gallery-magnolia-low" },
  { x: -37.6, z: 28, scale: 0.82, archetype: "gallery-magnolia-low" },
  { x: -37.6, z: 56, scale: 0.8, archetype: "gallery-magnolia-low" },
  // South promenade, framing the grand stair
  { x: -20, z: 58, scale: 0.95, archetype: "conservatory-specimen" },
  { x: 8, z: 58, scale: 1, archetype: "conservatory-specimen" }
] as const;

const TREE_PLACEMENTS: readonly AuthoredTreePlacement[] = TREE_LAYOUT.map((tree, index) => {
  const world = sutroLocalToWorld(tree.x, tree.z);
  return {
    x: world.x,
    y: SUTRO_BATHS.deckY + 0.82,
    z: world.z,
    yaw: index * 1.71 + 0.35,
    scale: tree.scale,
    archetype: tree.archetype,
    nearDetail: true
  };
});

const SHRUB_PALETTES: readonly AuthoredShrubPalette[] = [
  { foliageA: 0x315d3a, foliageB: 0x5d8150 },
  { foliageA: 0x315a3d, foliageB: 0x78935b, blooms: [0xcda17b, 0xe0b89a], bloomChance: 0.28 },
  { foliageA: 0x294d34, foliageB: 0x527452 }
] as const;

const SHRUB_LAYOUT = [
  // Ferny north conservatory bank beneath the period palms.
  [-24, -66, 1.2, 0, "fern"],
  [-13, -67, 1.08, 2, "fern"],
  [1, -66, 1.15, 0, "fern"],
  [15, -66, 1.08, 2, "fern"],
  [26, -65.5, 1.1, 0, "fern"],
  // Potted foliage along the east gallery and its landing.
  [30.2, -47, 0.82, 0, "natural"],
  [30.2, -35, 0.88, 1, "fern"],
  [30.2, -23, 0.8, 0, "natural"],
  [30.2, -11, 0.92, 2, "fern"],
  [30.2, 1, 0.86, 0, "natural"],
  [30.2, 13, 0.9, 1, "fern"],
  [30.2, 25, 0.84, 0, "natural"],
  [30.2, 49, 0.92, 2, "fern"],
  // Ferns bank the ocean-window seating gallery without blocking the view.
  [-32, -55, 0.72, 0, "fern"],
  [-32, -34, 0.8, 2, "fern"],
  [-32, -8, 0.76, 2, "fern"],
  [-32, 18, 0.82, 1, "fern"],
  [-32, 40, 0.74, 0, "fern"],
  [-32, 55, 0.72, 0, "fern"],
  [-37.8, -30, 0.7, 1, "fern"],
  [-37.8, 8, 0.74, 0, "fern"],
  [-37.8, 44, 0.7, 2, "fern"],
  // Low planting along the central deck spine, between the pool ends.
  [-7.6, -58, 0.8, 1, "natural"],
  [-7.6, -34, 0.86, 0, "fern"],
  [-7.6, -10, 0.82, 2, "natural"],
  [-7.6, 18, 0.88, 1, "fern"],
  [-7.6, 42, 0.8, 0, "natural"],
  // South promenade beds either side of the grand stair.
  [-24, 55, 0.9, 1, "fern"],
  [-16, 57, 0.84, 2, "natural"],
  [2, 57, 0.86, 0, "fern"],
  [10, 55, 0.9, 1, "natural"]
] as const;

const SHRUB_PLACEMENTS: readonly AuthoredShrubPlacement[] = SHRUB_LAYOUT.map((entry, index) => {
  const [x, z, scale, palette, profile] = entry;
  const world = sutroLocalToWorld(x as number, z as number);
  return {
    x: world.x,
    y: SUTRO_BATHS.deckY + 0.68,
    z: world.z,
    yaw: index * 2.399963,
    scale: scale as number,
    palette: palette as number,
    profile: profile as "fern" | "natural",
    tint: ((index * 37) % 101) / 100,
    wind: profile === "fern" ? 0.46 : 0.28
  };
});

/**
 * Blooms spilling out of the shrub planters. A period conservatory was a
 * flower house as much as a bath house, and at dusk the pale species are what
 * still read once the lamps take over.
 */
// Two species, not four: the flower patch builds one instanced mesh per species,
// so every extra species is another pipeline to compile at the arrival.
const FLOWER_SPECIES: readonly AuthoredFlowerSpecies[] = ["yarrow", "poppy"];

const FLOWER_PLACEMENTS: readonly AuthoredFlowerPlacement[] = SHRUB_LAYOUT.flatMap((entry, index) => {
  const [x, z, scale] = entry as unknown as [number, number, number];
  const out: AuthoredFlowerPlacement[] = [];
  for (let i = 0; i < 5; i++) {
    const angle = index * 1.7 + i * 1.2566;
    const radius = 0.42 + (i % 3) * 0.16;
    const world = sutroLocalToWorld(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
    out.push({
      x: world.x,
      y: SUTRO_BATHS.deckY + 0.9,
      z: world.z,
      yaw: angle,
      scale: 0.5 + (scale as number) * 0.24,
      species: FLOWER_SPECIES[(index + i) % FLOWER_SPECIES.length],
      tint: ((index * 7 + i * 23) % 100) / 100
    });
  }
  return out;
});

function createPlanters(): {
  mesh: THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  geometry: THREE.CylinderGeometry;
  material: THREE.MeshStandardMaterial;
} {
  const roots = [
    ...TREE_LAYOUT.map((entry) => ({ x: entry.x, z: entry.z, scale: entry.scale * 1.08 })),
    ...SHRUB_LAYOUT.map((entry) => ({ x: entry[0] as number, z: entry[1] as number, scale: (entry[2] as number) * 0.72 }))
  ];
  const geometry = new THREE.CylinderGeometry(0.78, 0.62, 1.15, 12, 1, false);
  const material = new THREE.MeshStandardMaterial({
    color: 0x9d5c42,
    roughness: 0.9,
    metalness: 0,
    flatShading: true
  });
  const mesh = new THREE.InstancedMesh(geometry, material, roots.length);
  mesh.name = "sutro_baths_period_terracotta_planters";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  roots.forEach((root, index) => {
    const world = sutroLocalToWorld(root.x, root.z);
    dummy.position.set(world.x, SUTRO_BATHS.deckY + 0.52, world.z);
    dummy.rotation.y = index * 0.71;
    dummy.scale.set(root.scale, 0.9 + (index % 3) * 0.05, root.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
    tint.setHex(index % 3 === 0 ? 0xb06a4a : index % 3 === 1 ? 0x91513d : 0xa45c43);
    mesh.setColorAt(index, tint);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return { mesh, geometry, material };
}

/** Reuses the unified worker-compiled native tree and authored leaf-spray paths. */
export function createSutroBathsVegetation(): SutroBathsVegetation {
  const group = new THREE.Group();
  group.name = "sutro_baths_unified_foliage";

  const trees = createAuthoredTreePatch(TREE_ARCHETYPES, TREE_PLACEMENTS, {
    name: "sutro_baths_conservatory_trees",
    chunkSize: 24,
    visibleDistance: 540,
    nearRadius: 82,
    nearExitRadius: 104,
    nearMax: 16
  });
  const shrubs = createAuthoredShrubPatch(SHRUB_PLACEMENTS, {
    name: "sutro_baths_gallery_shrubs",
    palettes: SHRUB_PALETTES
  });
  const planters = createPlanters();
  const flowers = createAuthoredFlowerPatch(FLOWER_PLACEMENTS, {
    name: "sutro_baths_planter_blooms"
  });
  group.add(trees.group, shrubs.group, planters.mesh, flowers.group);

  let visible = true;
  let disposed = false;
  return {
    group,
    ready: trees.ready,
    update(focus, force = false) {
      if (!disposed && visible) trees.update(focus, force);
    },
    setVisible(next) {
      visible = next;
      group.visible = next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      trees.dispose();
      shrubs.dispose();
      flowers.dispose();
      planters.geometry.dispose();
      planters.material.dispose();
      group.removeFromParent();
    },
    stats: {
      trees: TREE_PLACEMENTS.length,
      shrubs: SHRUB_PLACEMENTS.length,
      planters: TREE_PLACEMENTS.length + SHRUB_PLACEMENTS.length,
      flowers: FLOWER_PLACEMENTS.length
    }
  };
}
