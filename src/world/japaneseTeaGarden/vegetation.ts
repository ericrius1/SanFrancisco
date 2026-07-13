import * as THREE from "three/webgpu";
import {
  createBladeClusterGeometry,
  createGrassMaterial,
  createGrassMesh,
  writeGrassMesh,
  type GrassEntry
} from "../groundcover/bladeGrass";
import {
  createAuthoredShrubPatch,
  type AuthoredShrubPalette,
  type AuthoredShrubPlacement
} from "../vegetation/authoredShrubs";
import {
  createAuthoredTreePatch,
  type AuthoredTreeArchetype
} from "../vegetation/authoredTrees";
import {
  TEA_GARDEN_BOUNDS,
  distanceToTeaGardenPaths,
  inJapaneseTeaGarden,
  inTeaGardenBuilding,
  inTeaGardenWater,
  type TeaGardenTerrain
} from "./layout";
import {
  collectTeaGardenPlanting,
  type TeaGardenShrubPalette
} from "./planting";

export type TeaGardenVegetation = {
  group: THREE.Group;
  grassGroup: THREE.Group;
  ready: Promise<void>;
  setVisible(visible: boolean): void;
  update(focus: { x: number; z: number }): void;
  dispose(): void;
  stats: { trees: number; shrubs: number; grassClusters: number; rocks: number };
};

function hash(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const TREE_ARCHETYPES: readonly AuthoredTreeArchetype[] = [
  {
    id: "black-pine",
    design: {
      species: "japanese-black-pine",
      seed: 4101,
      controls: {
        height: 9.5,
        crownDensity: 1.25,
        crownWidth: 0.78,
        foliageColor: 0x385d34
      },
      sink: 0.2
    }
  },
  {
    id: "japanese-maple",
    design: {
      species: "japanese-maple",
      seed: 4102,
      controls: {
        height: 7.2,
        crownDensity: 1.2,
        crownWidth: 0.72,
        foliageColor: 0x8a513e,
        foliageTint: 0xc17054,
        leafColorVariant: "autumn"
      },
      sink: 0.16
    }
  },
  {
    id: "flowering-cherry",
    design: {
      species: "flowering-cherry",
      seed: 4103,
      controls: {
        height: 7.8,
        crownDensity: 1.25,
        crownWidth: 0.72,
        foliageColor: 0xb66f7f,
        foliageTint: 0xf0b4c3,
        leafColorVariant: "blossom"
      },
      sink: 0.16
    }
  },
  {
    id: "survivor-ginkgo",
    design: {
      species: "ginkgo",
      seed: 4104,
      controls: {
        height: 9,
        crownDensity: 1.15,
        crownWidth: 0.78,
        foliageColor: 0x9ba850,
        foliageTint: 0xd0bd58,
        leafColorVariant: "autumn"
      },
      sink: 0.12
    }
  }
] as const;

const SHRUB_PALETTES: readonly AuthoredShrubPalette[] = [
  { foliageA: 0x2d5730, foliageB: 0x547a3a },
  { foliageA: 0x315b33, foliageB: 0x61813d, blooms: [0xb94e6f, 0xd97591, 0xe8a0b3], bloomChance: 0.7 },
  { foliageA: 0x356037, foliageB: 0x668640, blooms: [0xd97798, 0xe79bb5, 0xf0becd], bloomChance: 0.78 },
  { foliageA: 0x294f30, foliageB: 0x476f3b }
] as const;

const SHRUB_PALETTE_INDEX: Record<TeaGardenShrubPalette, number> = {
  "azalea-evergreen": 0,
  "azalea-rose": 1,
  "azalea-pink": 2,
  "clipped-hedge": 3
};

function collectGrass(map: TeaGardenTerrain): GrassEntry[] {
  const entries: GrassEntry[] = [];
  const cell = 2.15;
  let gx = 0;
  for (let x = TEA_GARDEN_BOUNDS.minX; x <= TEA_GARDEN_BOUNDS.maxX; x += cell, gx++) {
    let gz = 0;
    for (let z = TEA_GARDEN_BOUNDS.minZ; z <= TEA_GARDEN_BOUNDS.maxZ; z += cell, gz++) {
      const px = x + (hash(gx, gz, 211) - 0.5) * cell * 0.92;
      const pz = z + (hash(gx, gz, 223) - 0.5) * cell * 0.92;
      if (!inJapaneseTeaGarden(px, pz, -0.6)) continue;
      if (inTeaGardenWater(px, pz, 0.75) || inTeaGardenBuilding(px, pz, 0.85)) continue;
      if (distanceToTeaGardenPaths(px, pz) < 0.82) continue;
      if (map.isWater(px, pz) || hash(gx, gz, 227) > 0.78) continue;
      const mossy = hash(gx, gz, 229);
      const tint = new THREE.Color().setHSL(0.23 + mossy * 0.055, 0.42, 0.46 + mossy * 0.08);
      entries.push({
        x: px,
        y: map.groundTop(px, pz) + 0.025,
        z: pz,
        yaw: hash(gx, gz, 233) * Math.PI * 2,
        height: 0.18 + hash(gx, gz, 239) * 0.2,
        spread: 0.54 + hash(gx, gz, 241) * 0.34,
        color: tint,
        windAmp: 0.1 + hash(gx, gz, 251) * 0.24
      });
    }
  }
  return entries;
}

function createGrass(map: TeaGardenTerrain): { group: THREE.Group; count: number } {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_grass";
  const entries = collectGrass(map);
  const geometry = createBladeClusterGeometry({ blades: 5, segments: 3, width: 0.05, radius: 0.2, curvature: 0.24 });
  const materialState = createGrassMaterial();
  materialState.focus.set(
    (TEA_GARDEN_BOUNDS.minX + TEA_GARDEN_BOUNDS.maxX) * 0.5,
    (TEA_GARDEN_BOUNDS.minZ + TEA_GARDEN_BOUNDS.maxZ) * 0.5
  );
  const mesh = createGrassMesh("tea_garden_moss_grass", entries.length, geometry, materialState.material);
  // createGrassMesh clones the primitive so the mesh owns its copy.
  geometry.dispose();
  writeGrassMesh(mesh, entries, 420);
  group.add(mesh);
  return { group, count: entries.length };
}

function createRocks(map: TeaGardenTerrain): { group: THREE.Group; count: number } {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_mossy_rocks";
  const placements: { x: number; z: number; scale: number; yaw: number; moss: boolean }[] = [];
  for (let i = 0; i < 64; i++) {
    const angle = (i / 64) * Math.PI * 2;
    const rx = 20.5 + (hash(i, 0, 301) - 0.5) * 3.4;
    const rz = 21.5 + (hash(i, 0, 307) - 0.5) * 3.4;
    placements.push({
      x: -2290 + Math.cos(angle) * rx,
      z: 2218.5 + Math.sin(angle) * rz,
      scale: 0.48 + hash(i, 0, 311) * 0.76,
      yaw: hash(i, 0, 313) * Math.PI * 2,
      moss: hash(i, 0, 317) > 0.42
    });
  }
  for (let i = 0; i < 28; i++) {
    const angle = (i / 28) * Math.PI * 2;
    placements.push({
      x: -2267.5 + Math.cos(angle) * (14.8 + hash(i, 2, 321) * 1.8),
      z: 2180.5 + Math.sin(angle) * (10.8 + hash(i, 2, 323) * 1.5),
      scale: 0.38 + hash(i, 2, 331) * 0.58,
      yaw: hash(i, 2, 337) * Math.PI * 2,
      moss: true
    });
  }
  const geometry = new THREE.DodecahedronGeometry(0.72, 0);
  geometry.scale(1.25, 0.75, 1.05);
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x696c62, roughness: 1, metalness: 0, vertexColors: true }),
    placements.length
  );
  const dummy = new THREE.Object3D();
  placements.forEach((entry, index) => {
    dummy.position.set(entry.x, map.groundTop(entry.x, entry.z) + entry.scale * 0.22, entry.z);
    dummy.rotation.set(hash(index, 4, 341) * 0.45, entry.yaw, hash(index, 5, 347) * 0.32);
    dummy.scale.setScalar(entry.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
    mesh.setColorAt(index, new THREE.Color(entry.moss ? 0x66755a : 0x777970));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return { group, count: placements.length };
}

function createDryLandscape(map: TeaGardenTerrain): THREE.Group {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_dry_landscape";
  const x = -2344;
  const z = 2166.5;
  const y = map.groundTop(x, z) + 0.1;
  const gravel = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshStandardMaterial({ color: 0xc6bfae, roughness: 1, metalness: 0 })
  );
  gravel.name = "dry_garden_gravel";
  gravel.rotation.x = -Math.PI / 2;
  gravel.scale.set(10.8, 6.4, 1);
  gravel.position.set(x, y, z);
  gravel.receiveShadow = true;
  group.add(gravel);

  const lineMat = new THREE.MeshStandardMaterial({ color: 0x918b7d, roughness: 1 });
  for (let ring = 0; ring < 6; ring++) {
    const points: THREE.Vector3[] = [];
    const radius = 2.8 + ring * 1.08;
    for (let i = 0; i <= 48; i++) {
      const angle = (i / 48) * Math.PI * 2;
      points.push(new THREE.Vector3(x + Math.cos(angle) * radius * 1.45, y + 0.025, z + Math.sin(angle) * radius * 0.78));
    }
    const line = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, true), 72, 0.025, 4, true), lineMat);
    line.name = "dry_garden_rake_line";
    group.add(line);
  }
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x66665e, roughness: 1 });
  for (const [rx, rz, scale] of [
    [-2346.8, 2165.3, 1.3], [-2342.4, 2168.1, 0.95], [-2341.2, 2164.4, 0.72]
  ] as const) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(scale, 0), rockMat);
    rock.name = "dry_garden_stone";
    rock.scale.set(1.25, 0.82, 1);
    rock.position.set(rx, map.groundTop(rx, rz) + scale * 0.45, rz);
    rock.rotation.y = scale * 1.7;
    rock.castShadow = true;
    group.add(rock);
  }
  return group;
}

function createBuddha(map: TeaGardenTerrain): THREE.Group {
  const x = -2289.7;
  const z = 2177.3;
  const y = map.groundTop(x, z);
  const bronze = new THREE.MeshStandardMaterial({ color: 0x72613e, roughness: 0.58, metalness: 0.45 });
  const stone = new THREE.MeshStandardMaterial({ color: 0x73736a, roughness: 1 });
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_buddha";
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.65, 2.1), stone);
  plinth.position.set(x, y + 0.33, z);
  plinth.castShadow = true;
  group.add(plinth);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.78, 16, 10), bronze);
  body.name = "buddha_robes";
  body.scale.set(1.1, 1.05, 0.82);
  body.position.set(x, y + 1.42, z);
  body.castShadow = true;
  group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 10), bronze);
  head.name = "buddha_head";
  head.position.set(x, y + 2.45, z);
  head.castShadow = true;
  group.add(head);
  const lap = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.27, 8, 20, Math.PI), bronze);
  lap.name = "buddha_lotus_pose";
  lap.rotation.set(Math.PI / 2, 0, Math.PI);
  lap.position.set(x, y + 1.05, z + 0.25);
  group.add(lap);
  return group;
}

export function createTeaGardenVegetation(map: TeaGardenTerrain): TeaGardenVegetation {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_vegetation";
  const plants = new THREE.Group();
  plants.name = "japanese_tea_garden_live_plants";
  const landmarks = new THREE.Group();
  landmarks.name = "japanese_tea_garden_persistent_landmarks";
  const planting = collectTeaGardenPlanting(map);
  const trees = createAuthoredTreePatch(TREE_ARCHETYPES, planting.trees, {
    name: "japanese_tea_garden_trees",
    chunkSize: 64,
    visibleDistance: 920,
    nearRadius: 58,
    nearExitRadius: 68,
    nearMax: 24
  });
  const shrubPlacements: AuthoredShrubPlacement[] = planting.shrubs.map((shrub, index) => ({
    x: shrub.x,
    y: shrub.y,
    z: shrub.z,
    yaw: shrub.yaw,
    scale: shrub.scale,
    palette: SHRUB_PALETTE_INDEX[shrub.palette],
    profile: shrub.profile === "clipped" ? "hedge" : "azalea",
    tint: hash(Math.round(shrub.x * 10), Math.round(shrub.z * 10), 1301 + index)
  }));
  const shrubs = createAuthoredShrubPatch(shrubPlacements, {
    name: "japanese_tea_garden_shrubs",
    palettes: SHRUB_PALETTES
  });
  const grass = createGrass(map);
  const rocks = createRocks(map);
  plants.add(trees.group, shrubs.group, grass.group);
  landmarks.add(rocks.group, createDryLandscape(map), createBuddha(map));
  group.add(plants, landmarks);

  return {
    group,
    grassGroup: grass.group,
    ready: trees.ready,
    setVisible(visible: boolean) {
      plants.visible = visible;
    },
    update(focus) {
      trees.update(focus);
    },
    dispose() {
      trees.dispose();
      shrubs.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      for (const owned of [grass.group, landmarks]) owned.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        geometries.add(mesh.geometry);
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const entry of list) materials.add(entry);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const entry of materials) entry.dispose();
      group.removeFromParent();
    },
    stats: {
      trees: planting.trees.length,
      shrubs: planting.shrubs.length,
      grassClusters: grass.count,
      rocks: rocks.count
    }
  };
}
