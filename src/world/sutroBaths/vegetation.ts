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
import { SUTRO_BATHS, sutroLocalToWorld } from "./layout";

export type SutroBathsVegetation = {
  group: THREE.Group;
  ready: Promise<void>;
  update(focus: { x: number; z: number }): void;
  setVisible(visible: boolean): void;
  dispose(): void;
  stats: { trees: number; shrubs: number; planters: number };
};

const TREE_ARCHETYPES: readonly AuthoredTreeArchetype[] = [
  {
    id: "conservatory-palm",
    design: {
      species: "chilean-palm",
      seed: 18961,
      controls: {
        height: 8.4,
        crownDensity: 1.05,
        crownWidth: 0.76,
        foliageColor: 0x477650,
        foliageTint: 0x79a064,
        windResponse: 0.34
      },
      sink: 0.08
    }
  },
  {
    id: "gallery-magnolia",
    design: {
      species: "magnolia",
      seed: 18962,
      controls: {
        height: 6.2,
        crownDensity: 1.12,
        crownWidth: 0.7,
        foliageColor: 0x365f3e,
        foliageTint: 0x628452,
        windResponse: 0.24
      },
      sink: 0.1
    }
  }
] as const;

const TREE_LAYOUT = [
  { x: -18, z: -66, scale: 0.84, archetype: "conservatory-palm" },
  { x: -5.5, z: -67, scale: 0.9, archetype: "conservatory-palm" },
  { x: 9, z: -67, scale: 0.82, archetype: "conservatory-palm" },
  { x: 21, z: -66, scale: 0.78, archetype: "gallery-magnolia" },
  { x: 30.5, z: 38, scale: 0.72, archetype: "gallery-magnolia" }
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
  // A few low leaves soften the ocean-window seating gallery.
  [-32, -55, 0.72, 0, "fern"],
  [-32, 1, 0.76, 2, "fern"],
  [-32, 55, 0.72, 0, "fern"]
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
    nearMax: 5
  });
  const shrubs = createAuthoredShrubPatch(SHRUB_PLACEMENTS, {
    name: "sutro_baths_gallery_shrubs",
    palettes: SHRUB_PALETTES
  });
  const planters = createPlanters();
  group.add(trees.group, shrubs.group, planters.mesh);

  let visible = true;
  let disposed = false;
  return {
    group,
    ready: trees.ready,
    update(focus) {
      if (!disposed && visible) trees.update(focus);
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
      planters.geometry.dispose();
      planters.material.dispose();
      group.removeFromParent();
    },
    stats: {
      trees: TREE_PLACEMENTS.length,
      shrubs: SHRUB_PLACEMENTS.length,
      planters: TREE_PLACEMENTS.length + SHRUB_PLACEMENTS.length
    }
  };
}
