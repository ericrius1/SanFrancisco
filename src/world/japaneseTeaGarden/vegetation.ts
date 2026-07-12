import * as THREE from "three/webgpu";
import {
  createBladeClusterGeometry,
  createGrassMaterial,
  createGrassMesh,
  writeGrassMesh,
  type GrassEntry
} from "../groundcover/bladeGrass";
import { compileTree, GARDEN_TREE_PRESETS } from "../garden/proceduralTrees";
import {
  GUIDE_HOME,
  TEA_GARDEN_BOUNDS,
  TEA_GARDEN_TOUR_STOPS,
  TEA_GARDEN_TREES,
  distanceToTeaGardenPaths,
  inJapaneseTeaGarden,
  inTeaGardenBuilding,
  inTeaGardenWater,
  type TeaGardenTerrain,
  type TeaGardenTreeKind,
  type TeaGardenTreePlacement
} from "./layout";

export type TeaGardenVegetation = {
  group: THREE.Group;
  grassGroup: THREE.Group;
  setVisible(visible: boolean): void;
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

function treePreset(kind: TeaGardenTreeKind): number {
  if (kind === "pine") return 2;
  if (kind === "maple") return 5;
  return 1;
}

function clearsGuideSightline(x: number, z: number, homeRadius = 14, stopRadius = 3.4): boolean {
  if (Math.hypot(x - GUIDE_HOME.x, z - GUIDE_HOME.z) < homeRadius) return false;
  return !TEA_GARDEN_TOUR_STOPS.some((stop) =>
    Math.hypot(x - stop.guideX, z - stop.guideZ) < stopRadius
  );
}

function createTreeMeshes(map: TeaGardenTerrain): { group: THREE.Group; count: number } {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_specimen_trees";

  // Seven mature Japanese black pines define the redesigned 2024 Pagoda Plaza.
  const plazaPines: TeaGardenTreePlacement[] = [
    { x: -2330.5, z: 2190.4, kind: "pine", scale: 0.5, yaw: 0.4 },
    { x: -2323.8, z: 2187.2, kind: "pine", scale: 0.47, yaw: 1.6 },
    { x: -2316.6, z: 2189.5, kind: "pine", scale: 0.52, yaw: 2.7 },
    { x: -2307.5, z: 2202.5, kind: "pine", scale: 0.46, yaw: 3.9 },
    { x: -2313.1, z: 2206, kind: "pine", scale: 0.5, yaw: 5.1 },
    { x: -2320.3, z: 2209.2, kind: "pine", scale: 0.48, yaw: 0.9 },
    { x: -2330.7, z: 2206.5, kind: "pine", scale: 0.52, yaw: 2.2 }
  ];
  const mappedPlacements = TEA_GARDEN_TREES.filter((tree) =>
    inJapaneseTeaGarden(tree.x, tree.z) && clearsGuideSightline(tree.x, tree.z)
  );
  const placements = [...mappedPlacements, ...plazaPines];
  const byKind = new Map<TeaGardenTreeKind, TeaGardenTreePlacement[]>();
  for (const placement of placements) {
    const list = byKind.get(placement.kind) ?? [];
    list.push(placement);
    byKind.set(placement.kind, list);
  }

  const dummy = new THREE.Object3D();
  for (const [kind, trees] of byKind) {
    const compiled = compileTree(GARDEN_TREE_PRESETS[treePreset(kind)]);
    const branchMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, metalness: 0 });
    const leafMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.86,
      metalness: 0,
      side: THREE.DoubleSide,
      alphaTest: 0.08
    });
    const branches = new THREE.InstancedMesh(compiled.branchGeometry, branchMat, trees.length);
    branches.name = `tea_garden_${kind}_branches`;
    const leaves = new THREE.InstancedMesh(compiled.leafGeometry, leafMat, trees.length);
    leaves.name = `tea_garden_${kind}_foliage`;

    trees.forEach((tree, index) => {
      const y = map.groundTop(tree.x, tree.z) - 0.12;
      dummy.position.set(tree.x, y, tree.z);
      dummy.rotation.set(0, tree.yaw, kind === "pine" ? (hash(index, 0, 51) - 0.5) * 0.12 : 0);
      // Tea-garden pines are deliberately pruned and layered, not forest-scale
      // cones. The narrower profile keeps gates, roofs and tour sightlines legible.
      const wide = kind === "pine" ? 0.88 : 1;
      const height = kind === "pine" ? 0.7 : kind === "cherry" ? 0.84 : 0.92;
      dummy.scale.set(tree.scale * wide, tree.scale * height, tree.scale * wide);
      dummy.updateMatrix();
      branches.setMatrixAt(index, dummy.matrix);
      leaves.setMatrixAt(index, dummy.matrix);
    });
    branches.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    branches.computeBoundingSphere();
    leaves.computeBoundingSphere();
    branches.castShadow = true;
    branches.receiveShadow = true;
    leaves.castShadow = true;
    leaves.receiveShadow = true;
    group.add(branches, leaves);
  }
  return { group, count: placements.length };
}

type ShrubPlacement = { x: number; y: number; z: number; scale: number; yaw: number; palette: number };

function collectShrubs(map: TeaGardenTerrain): ShrubPlacement[] {
  const shrubs: ShrubPlacement[] = [];
  const cell = 3.15;
  let gx = 0;
  for (let x = TEA_GARDEN_BOUNDS.minX; x <= TEA_GARDEN_BOUNDS.maxX; x += cell, gx++) {
    let gz = 0;
    for (let z = TEA_GARDEN_BOUNDS.minZ; z <= TEA_GARDEN_BOUNDS.maxZ; z += cell, gz++) {
      const px = x + (hash(gx, gz, 101) - 0.5) * cell * 0.88;
      const pz = z + (hash(gx, gz, 103) - 0.5) * cell * 0.88;
      if (!inJapaneseTeaGarden(px, pz, -0.2)) continue;
      if (inTeaGardenWater(px, pz, 1.6) || inTeaGardenBuilding(px, pz, 1.2)) continue;
      if (!clearsGuideSightline(px, pz, 5, 2.5)) continue;
      const pathDistance = distanceToTeaGardenPaths(px, pz);
      if (pathDistance < 1.1 || pathDistance > 6.2) continue;
      const edgeBand = 1 - Math.min(1, Math.abs(pathDistance - 2.3) / 3.9);
      if (hash(gx, gz, 107) > 0.16 + edgeBand * 0.34) continue;
      shrubs.push({
        x: px,
        y: map.groundTop(px, pz) + 0.18,
        z: pz,
        scale: 0.62 + hash(gx, gz, 109) * 0.82,
        yaw: hash(gx, gz, 113) * Math.PI * 2,
        palette: Math.floor(hash(gx, gz, 127) * 3)
      });
    }
  }
  return shrubs;
}

function createShrubMeshes(map: TeaGardenTerrain): { group: THREE.Group; count: number } {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_azaleas";
  const placements = collectShrubs(map);
  const palettes = [
    [0x315e33, 0x5e853c],
    [0x405c31, 0xbf5b71],
    [0x3a6738, 0xd88a9c]
  ] as const;
  const dummy = new THREE.Object3D();
  const geometry = new THREE.IcosahedronGeometry(0.62, 1);
  geometry.scale(1.25, 0.72, 1.05);
  for (let palette = 0; palette < palettes.length; palette++) {
    const list = placements.filter((entry) => entry.palette === palette);
    const mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: palettes[palette][0], roughness: 0.96, metalness: 0, vertexColors: true }),
      list.length
    );
    mesh.name = `tea_garden_azalea_palette_${palette}`;
    list.forEach((entry, index) => {
      dummy.position.set(entry.x, entry.y, entry.z);
      dummy.rotation.set(0, entry.yaw, 0);
      dummy.scale.set(entry.scale, entry.scale, entry.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      const bloom = index % 4 === 0 || palette > 0;
      mesh.setColorAt(index, new THREE.Color(bloom ? palettes[palette][1] : palettes[palette][0]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, count: placements.length };
}

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

function createMtFujiHedge(map: TeaGardenTerrain): THREE.Group {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_mt_fuji_hedge";
  const geometry = new THREE.IcosahedronGeometry(0.8, 1);
  const green = new THREE.MeshStandardMaterial({ color: 0x315f39, roughness: 0.98 });
  for (let row = 0; row < 5; row++) {
    const count = 9 - row * 2;
    for (let i = 0; i < count; i++) {
      const x = -2236 + (i - (count - 1) / 2) * 1.25;
      const z = 2216.5 + row * 0.62;
      const mound = new THREE.Mesh(geometry, green);
      mound.name = "mt_fuji_clipped_hedge_mound";
      mound.scale.set(1.1, 0.7, 0.85);
      mound.position.set(x, map.groundTop(x, z) + 0.5 + row * 0.47, z);
      mound.castShadow = true;
      group.add(mound);
    }
  }
  return group;
}

/** Two young trees descended from ginkgoes that survived Hiroshima, planted in 2019. */
function createSurvivorGinkgoes(map: TeaGardenTerrain): THREE.Group {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_hiroshima_descendant_ginkgoes";
  const bark = new THREE.MeshStandardMaterial({ color: 0x75664f, roughness: 0.98 });
  const leaf = new THREE.MeshStandardMaterial({ color: 0xa2ad54, roughness: 0.9 });
  const anchors = [
    [-2308.6, 2209.2],
    [-2312.8, 2206.9]
  ] as const;
  anchors.forEach(([x, z], treeIndex) => {
    const y = map.groundTop(x, z);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.27, 4.7, 8), bark);
    trunk.name = "survivor_ginkgo_trunk";
    trunk.position.set(x, y + 2.35, z);
    trunk.castShadow = true;
    group.add(trunk);
    for (let i = 0; i < 9; i++) {
      const angle = (i / 9) * Math.PI * 2 + treeIndex * 0.7;
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.72 + (i % 3) * 0.12, 1), leaf);
      crown.name = "survivor_ginkgo_fan_crown";
      crown.position.set(
        x + Math.cos(angle) * (0.62 + (i % 2) * 0.42),
        y + 4.1 + (i % 3) * 0.5,
        z + Math.sin(angle) * (0.62 + (i % 2) * 0.42)
      );
      crown.scale.set(1.25, 0.72, 1.08);
      crown.castShadow = true;
      crown.receiveShadow = true;
      group.add(crown);
    }
  });
  return group;
}

export function createTeaGardenVegetation(map: TeaGardenTerrain): TeaGardenVegetation {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_vegetation";
  const plants = new THREE.Group();
  plants.name = "japanese_tea_garden_live_plants";
  const landmarks = new THREE.Group();
  landmarks.name = "japanese_tea_garden_persistent_landmarks";
  const trees = createTreeMeshes(map);
  const shrubs = createShrubMeshes(map);
  const grass = createGrass(map);
  const rocks = createRocks(map);
  plants.add(trees.group, shrubs.group, grass.group, createMtFujiHedge(map), createSurvivorGinkgoes(map));
  landmarks.add(rocks.group, createDryLandscape(map), createBuddha(map));
  group.add(plants, landmarks);

  return {
    group,
    grassGroup: grass.group,
    setVisible(visible: boolean) {
      plants.visible = visible;
    },
    dispose() {
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      group.traverse((object) => {
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
    stats: { trees: trees.count + 2, shrubs: shrubs.count, grassClusters: grass.count, rocks: rocks.count }
  };
}
