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
  GARDEN_SPECIES,
  type GardenCollider,
  type GardenFlora,
  type GardenShrub,
  type GardenTerrain,
  type GardenTree
} from "./layout";
import { buildBotanicalGrass, type BotanicalGrassController } from "./botanicalGrass";
import { compileTree, GARDEN_TREE_PRESETS } from "./proceduralTrees";
import { buildSeedTreeGarden, SEED_TREE_DESIGNS } from "./seedTreeGarden";

export type GardenVegetation = {
  group: THREE.Group;
  /** Resolves once the asynchronous SeedThree tree group has been attached. */
  ready: Promise<void>;
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
const FLORA_PALETTES: { a: number; b: number; blooms: number[]; bloomChance: number }[] = [
  { a: 0x3a622a, b: 0x567a33, blooms: [], bloomChance: 0 },
  { a: 0x2c5a28, b: 0x477a38, blooms: [], bloomChance: 0 },
  { a: 0x4f7a2e, b: 0x6a8a3a, blooms: [0xe8863a, 0xf0a04a], bloomChance: 0.45 },
  { a: 0x4a7a35, b: 0x5f8a3f, blooms: [0xe38ba8, 0xece4d4, 0xd4707e, 0xe4b45e, 0xb49ad8], bloomChance: 0.45 }
];

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

// Procedural fallback meshes — now only for species without a SeedThree design
// (tree fern). Everything else renders through seedTreeGarden.ts.
function createTreeMeshes(trees: GardenTree[]): { group: THREE.Group; drawCalls: number } {
  const group = new THREE.Group();
  group.name = "sf_botanical_garden_trees";

  const barkMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const leafMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide
  });

  const bySpecies: GardenTree[][] = GARDEN_SPECIES.map(() => []);
  for (const t of trees) bySpecies[t.species]?.push(t);

  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  let drawCalls = 0;
  bySpecies.forEach((list, species) => {
    if (list.length === 0) return;
    const preset = GARDEN_TREE_PRESETS[species];
    if (!preset) return;
    const compiled = compileTree(preset);
    const branches = new THREE.InstancedMesh(compiled.branchGeometry, barkMaterial, list.length);
    const leaves = new THREE.InstancedMesh(compiled.leafGeometry, leafMaterial, list.length);
    branches.name = `sfbg_${GARDEN_SPECIES[species].name}_branches`;
    leaves.name = `sfbg_${GARDEN_SPECIES[species].name}_leaves`;
    list.forEach((t, i) => {
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.set(0, t.yaw, 0);
      dummy.scale.setScalar(t.scale);
      dummy.updateMatrix();
      branches.setMatrixAt(i, dummy.matrix);
      leaves.setMatrixAt(i, dummy.matrix);
      // subtle per-instance tint breaks the shared-geometry uniformity: hash the
      // position so it's stable, lean the crown warmer or cooler
      const h = (Math.sin(t.x * 12.9898 + t.z * 78.233) * 43758.5453) % 1;
      const warm = 0.92 + Math.abs(h) * 0.16;
      tint.setRGB(warm, 0.94 + Math.abs(h) * 0.1, 0.9 + (1 - Math.abs(h)) * 0.14);
      leaves.setColorAt(i, tint);
    });
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    for (const mesh of [branches, leaves]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // instance matrices span the garden; local geometry bounds would cull wrong
      mesh.frustumCulled = false;
      group.add(mesh);
      drawCalls++;
    }
  });
  return { group, drawCalls };
}

// Zone-paletted understory: one squashed icosahedron shared by all shrubs,
// per-instance colour from the deterministic palette + tint hash.
function createShrubMesh(shrubs: GardenShrub[]): THREE.InstancedMesh {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  geometry.scale(1, 0.68, 1);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geometry, material, shrubs.length);
  mesh.name = "sfbg_shrubs";

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const fA = new THREE.Color();
  const fB = new THREE.Color();
  shrubs.forEach((s, i) => {
    const p = SHRUB_PALETTES[s.palette] ?? SHRUB_PALETTES[0];
    const bloom = p.blooms.length > 0 && s.tint > 1 - p.bloomChance;
    // flowering shrubs stay small; a big solid-colour ball reads as plastic
    const r = 0.9 * s.scale * (bloom ? 0.72 : 1);
    dummy.position.set(s.x, s.y + r * 0.45, s.z);
    dummy.rotation.set(0, s.yaw, 0);
    dummy.scale.setScalar(r);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    fA.setHex(p.foliageA);
    fB.setHex(p.foliageB);
    if (bloom) {
      // bloom colour tempered toward foliage → flowering bush, not candy
      color.setHex(p.blooms[Math.floor(s.tint * 25.7) % p.blooms.length]);
      color.lerp(fB, 0.35);
    } else {
      color.lerpColors(fA, fB, s.tint / Math.max(0.001, 1 - p.bloomChance));
    }
    mesh.setColorAt(i, color);
  });
  mesh.instanceColor!.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

// Ground flora: a 3-quad star tuft shared by every instance; poppy/bed
// palettes read as flower drifts, grove palettes as fern floor.
function createFloraMesh(flora: GardenFlora[]): THREE.InstancedMesh {
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const quads = 3;
  for (let q = 0; q < quads; q++) {
    const a = (Math.PI * q) / quads;
    const dx = Math.cos(a) * 0.5;
    const dz = Math.sin(a) * 0.5;
    const base = q * 4;
    positions.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 1, -dz);
    const nx = -Math.sin(a);
    const nz = Math.cos(a);
    for (let v = 0; v < 4; v++) normals.push(nx, 0.35, nz);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);

  const material = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0, side: THREE.DoubleSide });
  const mesh = new THREE.InstancedMesh(geometry, material, flora.length);
  mesh.name = "sfbg_flora";

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const cA = new THREE.Color();
  const cB = new THREE.Color();
  flora.forEach((f, i) => {
    const p = FLORA_PALETTES[f.palette] ?? FLORA_PALETTES[0];
    const bloom = p.blooms.length > 0 && f.tint > 1 - p.bloomChance;
    dummy.position.set(f.x, f.y, f.z);
    dummy.rotation.set(0, f.yaw, 0);
    // flowers sit lower than grass tufts so beds read as ground colour drifts
    dummy.scale.set(f.scale, f.scale * (bloom ? 0.45 : 0.7), f.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    if (bloom) {
      color.setHex(p.blooms[Math.floor(f.tint * 31.7) % p.blooms.length]);
    } else {
      cA.setHex(p.a);
      cB.setHex(p.b);
      color.lerpColors(cA, cB, f.tint);
    }
    mesh.setColorAt(i, color);
  });
  mesh.instanceColor!.needsUpdate = true;
  mesh.castShadow = false; // thousands of tufts; shadows would double the cost for no read
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

export function createGardenVegetation(map: GardenTerrain): GardenVegetation {
  const trees = collectGardenTrees(map);
  const shrubs = collectGardenShrubs(map);
  const flora = collectGardenFlora(map);

  const group = new THREE.Group();
  group.name = "sf_botanical_garden";

  // procedural meshes only for species with no SeedThree design (tree fern)
  const proceduralTrees = trees.filter((t) => !SEED_TREE_DESIGNS[t.species]);
  const treeMeshes = createTreeMeshes(proceduralTrees);
  group.add(treeMeshes.group);

  // SeedThree textured trees stream in asynchronously (texture loads + growth);
  // colliders/proxy below come from the full layout list and are live
  // immediately. The near/far LOD rebin self-drives via onBeforeRender inside
  // buildSeedTreeGarden — nothing to tick from here.
  const ready = buildSeedTreeGarden(trees)
    .then((st) => {
      group.add(st.group);
      console.log(
        `[sfbg] SeedThree garden online: ${st.stats.species} species, ${st.stats.instances} trees, ~${(st.stats.farTriangles / 1e6).toFixed(1)}M far-tier tris`
      );
    })
    .catch((e) => console.error("[sfbg] SeedThree garden failed — procedural fern-only visuals remain:", e));

  const shrubMesh = createShrubMesh(shrubs);
  group.add(shrubMesh);

  // Procedural blade grass replaced the old flat flora tufts; keep the beds
  // near paths (flowers) but drop the plain grass/fern palettes as tufts.
  const floraMesh = createFloraMesh(flora.filter((f) => f.palette === 2 || f.palette === 3));
  group.add(floraMesh);

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
    proxy,
    grass,
    colliders: buildGardenTreeColliders(trees),
    stats: {
      trees: trees.length,
      shrubs: shrubs.length,
      flora: flora.length,
      drawCalls: treeMeshes.drawCalls + 2
    }
  };
}
