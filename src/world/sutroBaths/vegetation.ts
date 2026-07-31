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

/**
 * PLANTING ENVELOPE — why these positions and not prettier-sounding ones.
 *
 * The hall is a glass barrel over a working bath house, and much of its floor
 * already has something over it. The ocean-window seating gallery fills x
 * -38.5..-31.2 with only 1.6 m of clear air, and the inland side used to carry
 * the tiered spectator gallery across x 28.2..34.5 with its underside 5.6 m up.
 * The previous planting ignored both: its east avenue stood at x 29.6 under 5.6 m
 * of headroom carrying 7.2 m trees, so every crown on that side grew through the
 * seating tiers, and the west row at x -37.6 was simply inside the ocean
 * gallery's structure.
 *
 * The tiers are gone now (tools/rebuild-sutro-inland-gallery.py retired them in
 * favour of the timber picture gallery on the wall itself), so the inland lane is
 * no longer capped by them — but the lane below stays where it is on purpose:
 * pulled back to x 23 it keeps a clear view of the hung art from the deck
 * instead of standing a row of crowns in front of it.
 *
 * So each lane below is placed against a measured headroom map of the deck
 * (regenerate it with the helper in the site's survey notes) and every crown is
 * kept under the lowest thing above it:
 *
 *   central spine   x  -8      14.7 m to the pendant lamps
 *   east avenue     x  23      20.4 m — clear of the seating tiers at x 28.2
 *   north bank      z -62      clear to the roof
 *   south promenade z  62      clear to the roof, and west of the spiral at x 10.4
 *   west deck       x -25      clear, and only where the great plunge is not
 *
 * The grand spiral (site-local axis 24.6, 58.2, radius 9.0..14.2, sweeping
 * 20.66 deg to 270 deg) also owns floor now, which is why the east avenue stops
 * at z 30 and the south promenade stays west of x 9.
 */
const TREE_ARCHETYPES: readonly AuthoredTreeArchetype[] = [
  /**
   * The conservatory canopy. Magnolia carries the planting because it is the one
   * recipe here with a real tree's structure — three branch levels, up to a
   * hundred and sixty branches, foliage hung off the twigs — so it reads as a
   * tree from any angle. The palm recipe has no branch levels at all: it is a
   * trunk with at most a handful of frond rosettes, which from underneath is a
   * flat starburst and nothing like a plant.
   *
   * Magnolia + oak for the avenues, plus flowering cherry on the pavilion bank
   * under the clock. Three species is the compile budget the arrival can stand;
   * a fourth would put another KTX2 pack on the transition's critical path.
   */
  {
    id: "gallery-magnolia",
    design: {
      species: "magnolia",
      seed: 18962,
      controls: {
        // Shorter and markedly denser than before. The old 7.2 m / 1.8-density
        // magnolia read as a leggy houseplant — a bare stem with a few leaf
        // sprays — because the crown was stretched over too much trunk.
        // crownDensity clamps at 1.8 inside createNativeTreeArchetype.
        height: 6.4,
        crownDensity: 1.8,
        crownWidth: 1.18,
        // Warmer and a shade lighter than the wild recipe: these live under
        // glass and candlelight, not on a fog-grey headland, and a saturated
        // cold green goes to pure black once the pocket twilight settles.
        foliageColor: 0x6a8f52,
        foliageTint: 0xc4d47a,
        windResponse: 0.22
      },
      sink: 0.1
    }
  },
  {
    /**
     * Low wide crowns for the pavilion bank and west deck. Kept deliberately
     * short so the clock wall reads foliage mass instead of a stick silhouette.
     */
    id: "gallery-magnolia-low",
    design: {
      species: "magnolia",
      seed: 18965,
      controls: {
        height: 4.8,
        crownDensity: 1.8,
        crownWidth: 1.4,
        foliageColor: 0x739656,
        foliageTint: 0xd0e085,
        windResponse: 0.2
      },
      sink: 0.12
    }
  },
  {
    /** Blossoms under the clock — the period conservatory's living colour. */
    id: "pavilion-cherry",
    design: {
      species: "flowering-cherry",
      seed: 18969,
      controls: {
        height: 4.8,
        crownDensity: 1.8,
        crownWidth: 1.28,
        foliageColor: 0xc47a8c,
        foliageTint: 0xf5c4d2,
        leafColorVariant: "blossom",
        windResponse: 0.28
      },
      sink: 0.12
    }
  },
  {
    /**
     * Spreading oak on the south promenade. Palms were the obvious choice for a
     * bath house, but that recipe has no branch levels at all — a trunk with
     * three frond rosettes, which reads as a flat asterisk at every height.
     */
    id: "conservatory-specimen",
    design: {
      species: "coast-live-oak",
      seed: 18966,
      controls: {
        height: 7.2,
        crownDensity: 1.8,
        crownWidth: 1.28,
        foliageColor: 0x6b9154,
        foliageTint: 0xc6d67e,
        windResponse: 0.24
      },
      sink: 0.1
    }
  }
] as const;

const TREE_LAYOUT = [
  // North pavilion bank under the clock. Short dense magnolias frame the wall;
  // flowering cherries sit on the clock axis so the dial reads over blossom
  // instead of bare twigs. Clear to the roof.
  { x: -24, z: -62, scale: 0.96, archetype: "gallery-magnolia-low" },
  { x: -14, z: -63, scale: 1, archetype: "pavilion-cherry" },
  { x: -4, z: -64, scale: 1.02, archetype: "pavilion-cherry" },
  { x: 6, z: -63, scale: 0.98, archetype: "pavilion-cherry" },
  { x: 16, z: -62, scale: 0.94, archetype: "gallery-magnolia-low" },
  { x: 26, z: -61, scale: 0.9, archetype: "gallery-magnolia-low" },
  // East avenue on the walkway between the graduated baths and the seating
  // tiers: 20.4 m of headroom, and 5.2 m of lateral room before the tiers.
  // Threaded BETWEEN the east tea tables (parlour.ts TABLES, local x 25.4 at
  // z -34, -6 and 20) rather than level with them — a planter opposite a table
  // put its pulled-up chair 1.55 m from the pot, inside the clearance the
  // placement probe enforces.
  { x: 23.5, z: -58, scale: 0.9, archetype: "gallery-magnolia" },
  { x: 23.5, z: -46, scale: 1, archetype: "gallery-magnolia" },
  { x: 23.5, z: -20, scale: 0.92, archetype: "gallery-magnolia-low" },
  { x: 23.5, z: 6, scale: 0.96, archetype: "gallery-magnolia" },
  { x: 23.5, z: 32, scale: 0.9, archetype: "gallery-magnolia-low" },
  { x: 23.5, z: 40, scale: 0.94, archetype: "gallery-magnolia" },
  // West deck, only where the great plunge is not: low crowns so the sunset
  // still comes through the ocean windows unblocked. The plunge's south court
  // took the old x -25 pair at z 34 and 42, so they moved out onto the west
  // promenade, which stays dry the whole length of the hall.
  { x: -25, z: -60, scale: 0.86, archetype: "gallery-magnolia-low" },
  { x: -34.5, z: 44, scale: 0.84, archetype: "gallery-magnolia-low" },
  { x: -34.5, z: 52, scale: 0.82, archetype: "gallery-magnolia-low" },
  // South promenade, framing the foot of the spiral from the west side.
  { x: -20, z: 62, scale: 0.95, archetype: "conservatory-specimen" },
  { x: -6, z: 63, scale: 1, archetype: "conservatory-specimen" },
  { x: 6, z: 62, scale: 0.9, archetype: "gallery-magnolia" }
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
  // Ferny north pavilion bank beneath the clock-wall crowns.
  [-26, -66, 1.22, 0, "fern"],
  [-18, -67, 1.12, 1, "fern"],
  [-10, -67.5, 1.18, 2, "fern"],
  [-2, -68, 1.14, 1, "fern"],
  [6, -67.5, 1.16, 0, "fern"],
  [14, -66.5, 1.1, 2, "fern"],
  [24, -65.5, 1.12, 0, "fern"],
  // Potted foliage under the seating tiers along the east walkway. Shrubs are
  // waist-high, so the 5.6 m tier soffit that ruled out trees here is ample.
  [30.2, -47, 0.82, 0, "natural"],
  [30.2, -35, 0.88, 1, "fern"],
  [30.2, -23, 0.8, 0, "natural"],
  [30.2, -11, 0.92, 2, "fern"],
  [30.2, 1, 0.86, 0, "natural"],
  [30.2, 13, 0.9, 1, "fern"],
  [30.2, 25, 0.84, 0, "natural"],
  [30.2, 37, 0.92, 2, "fern"],
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
  // Keep z ≤ 18: the south court (z 22–44, maxX 19) swallowed the old spine
  // planter at (-7.6, 42) and left it floating in the plunge.
  [-7.6, -58, 0.8, 1, "natural"],
  [-7.6, -34, 0.86, 0, "fern"],
  [-7.6, -10, 0.82, 2, "natural"],
  [-7.6, 18, 0.88, 1, "fern"],
  // South promenade beds, kept west of the spiral's inner edge at local x 10.4.
  [-24, 55, 0.9, 1, "fern"],
  [-16, 57, 0.84, 2, "natural"],
  [2, 57, 0.86, 0, "fern"],
  [7, 68, 0.9, 1, "natural"]
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
    nearRadius: 96,
    nearExitRadius: 118,
    // Every tree in the hall plus headroom while the cherry/magnolia near
    // packs finish decoding — a saturated pool was forcing the pavilion bank
    // onto leafless-looking horizon cards against the clock wall.
    nearMax: 36
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
