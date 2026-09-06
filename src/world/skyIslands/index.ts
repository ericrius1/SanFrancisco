import * as THREE from "three/webgpu";
import {
  SKY_ISLANDS,
  getSkyIsland,
  type SkyIslandId,
  type SkyIslandMetadata,
  type SkyPoint
} from "./metadata";

type Mote = { x: number; y: number; z: number; phase: number; radius: number; speed: number };

export type SkyIslandVisual = {
  id: SkyIslandId;
  group: THREE.Group;
  update(elapsed: number, awakened: boolean): void;
  dispose(): void;
};

export type SkyIslandRuntimeOptions = {
  loadDistance?: number;
  unloadDistance?: number;
};

export type SkyIslandsRuntime = {
  /** Alias used by world composition; `group` is kept for patch conventions. */
  root: THREE.Group;
  group: THREE.Group;
  update(focus: SkyPoint, elapsed?: number): void;
  setAwakened(awakened: boolean): void;
  isAwakened(): boolean;
  dispose(): void;
  debugSnapshot(): readonly { id: SkyIslandId; resident: boolean; distance: number }[];
};

function hash(index: number, salt: number): number {
  const value = Math.sin(index * 91.713 + salt * 37.119) * 43758.5453;
  return value - Math.floor(value);
}

function standard(color: number, roughness: number, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function glow(color: number, opacity = 1): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 0.98
  });
  material.toneMapped = false;
  return material;
}

function track<T extends THREE.BufferGeometry>(items: T[], geometry: T): T {
  items.push(geometry);
  return geometry;
}

function colorizeRock(geometry: THREE.BufferGeometry, island: SkyIslandMetadata): void {
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  const rock = new THREE.Color(island.palette.rock);
  const stratum = new THREE.Color(island.palette.stratum);
  const soil = new THREE.Color(island.palette.soil);
  const fracture = new THREE.Color(island.palette.accent).multiplyScalar(0.34);
  const sample = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const yn = y / island.bodyRadius;
    const latitude = Math.sin((yn + 1) * 31 + Math.sin(x * 0.12) * 1.7);
    const mineral = Math.sin(x * 0.19 + z * 0.13 + Math.sin(y * 0.17) * 2.1);
    const crack = Math.abs(Math.sin(x * 0.071 - z * 0.113 + y * 0.163));
    sample.copy(rock).lerp(stratum, Math.max(0, latitude) * 0.24 + Math.max(0, mineral) * 0.12);
    if (yn > 0.62) sample.lerp(soil, Math.min(0.82, (yn - 0.62) * 1.9));
    if (crack > 0.974) sample.lerp(fracture, 0.48);
    sample.multiplyScalar(0.88 + hash(i, island.story.order * 19) * 0.2);
    sample.toArray(colors, i * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function colorizeGardenCap(geometry: THREE.BufferGeometry, island: SkyIslandMetadata): void {
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  const soil = new THREE.Color(island.palette.soil);
  const moss = new THREE.Color(island.palette.rock).lerp(new THREE.Color(island.palette.glow), 0.18);
  const inlay = new THREE.Color(island.palette.accent).multiplyScalar(0.84);
  const sample = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const radius = Math.hypot(x, z);
    const angle = Math.atan2(z, x);
    const path = Math.abs(Math.sin(angle * 2.5 + radius * 0.29 + island.story.order * 0.8));
    const orbit = Math.abs(Math.sin(radius * 0.56 - island.story.order * 0.7));
    const star = Math.abs(Math.sin(angle * 7 + island.story.order) * Math.cos(radius * 0.24));
    sample.copy(soil).lerp(moss, 0.18 + hash(i, 99) * 0.18);
    if (path < 0.12 || orbit < 0.055) sample.lerp(inlay, 0.72);
    if (star > 0.985) sample.lerp(new THREE.Color(island.palette.glow), 0.65);
    sample.toArray(colors, i * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function vertexSurfaceMaterial(color: number, roughness: number, emissiveGain: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness,
    metalness: 0.02,
    emissive: color,
    emissiveIntensity: emissiveGain
  });
}

function addSurfaceMosaic(
  island: SkyIslandMetadata,
  root: THREE.Group,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[]
): void {
  const geometry = track(geometries, new THREE.CylinderGeometry(0.9, 0.9, 0.11, 6, 1));
  const material = glow(island.palette.accent, 0.76);
  materials.push(material);
  const count = 30;
  const stones = new THREE.InstancedMesh(geometry, material, count);
  stones.name = `sky_island_${island.id}_star_path`;
  stones.castShadow = false;
  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const capRadius = island.bodyRadius * 0.52;
  for (let i = 0; i < count; i++) {
    const u = i / (count - 1);
    const radius = 6 + u * (capRadius - 8);
    const angle = u * Math.PI * 4.35 + island.story.order * 0.91;
    const dx = Math.cos(angle) * radius;
    const dz = Math.sin(angle) * radius;
    normal.set(dx, Math.sqrt(Math.max(0, island.bodyRadius ** 2 - radius ** 2)), dz).normalize();
    position.copy(normal).multiplyScalar(island.bodyRadius + 0.19);
    quaternion.setFromUnitVectors(up, normal);
    scale.set(0.65 + hash(i, 111) * 0.42, 1, 1.15 + hash(i, 114) * 0.85);
    matrix.compose(position, quaternion, scale);
    stones.setMatrixAt(i, matrix);
  }
  stones.instanceMatrix.needsUpdate = true;
  root.add(stones);
}

function addEdgeCrystals(
  island: SkyIslandMetadata,
  root: THREE.Group,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[]
): void {
  const geometry = track(geometries, new THREE.ConeGeometry(0.8, 4.8, 5, 1));
  const material = new THREE.MeshStandardMaterial({
    color: island.palette.accent,
    emissive: island.palette.glow,
    emissiveIntensity: 0.18,
    roughness: 0.28,
    metalness: 0.28
  });
  materials.push(material);
  const count = 18;
  const crystals = new THREE.InstancedMesh(geometry, material, count);
  crystals.name = `sky_island_${island.id}_rim_crystals`;
  crystals.castShadow = false;
  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + hash(i, 121) * 0.24;
    const yn = 0.18 + hash(i, 124) * 0.34;
    const ringRadius = Math.sqrt(1 - yn * yn);
    normal.set(Math.cos(angle) * ringRadius, yn, Math.sin(angle) * ringRadius);
    const heightScale = 0.62 + hash(i, 127) * 1.05;
    position.copy(normal).multiplyScalar(island.bodyRadius + heightScale * 1.7);
    quaternion.setFromUnitVectors(up, normal);
    scale.set(0.7 + hash(i, 130) * 0.8, heightScale, 0.7 + hash(i, 133) * 0.6);
    matrix.compose(position, quaternion, scale);
    crystals.setMatrixAt(i, matrix);
  }
  crystals.instanceMatrix.needsUpdate = true;
  root.add(crystals);
}

function makeStrata(
  island: SkyIslandMetadata,
  root: THREE.Group,
  geometries: THREE.BufferGeometry[],
  material: THREE.Material
): void {
  const bands = island.id === "moonwell" ? 6 : island.id === "opal-memory" ? 5 : 4;
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1);
    const localY = -island.bodyRadius * 0.48 + t * island.bodyRadius * 0.77;
    const crossRadius = Math.sqrt(Math.max(1, island.bodyRadius ** 2 - localY ** 2));
    const geometry = track(
      geometries,
      new THREE.TorusGeometry(crossRadius + 0.18, 0.42 + hash(i, island.story.order) * 0.48, 5, 48)
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `sky_island_${island.id}_stratum_${i}`;
    mesh.rotation.x = Math.PI / 2;
    mesh.rotation.z = (hash(i, 13 + island.story.order) - 0.5) * 0.08;
    mesh.position.y = localY;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}

function makeUnderslungCrags(
  island: SkyIslandMetadata,
  root: THREE.Group,
  geometries: THREE.BufferGeometry[],
  materials: readonly THREE.Material[]
): void {
  const count = 11 + island.story.order;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + hash(i, 28) * 0.5;
    const spread = island.bodyRadius * (0.16 + hash(i, 31) * 0.49);
    const depth = island.bodyRadius * (0.38 + hash(i, 34) * 0.62);
    const width = island.bodyRadius * (0.08 + hash(i, 37) * 0.11);
    const geometry = track(geometries, new THREE.ConeGeometry(width, depth, 5 + (i % 3), 2));
    geometry.rotateZ(Math.PI);
    const mesh = new THREE.Mesh(geometry, materials[i % materials.length]);
    mesh.name = `sky_island_${island.id}_underslung_crag_${i}`;
    mesh.position.set(
      Math.cos(angle) * spread,
      -island.bodyRadius * (0.72 + hash(i, 40) * 0.12) - depth * 0.32,
      Math.sin(angle) * spread
    );
    mesh.rotation.y = angle + hash(i, 43) * 0.7;
    mesh.rotation.x = (hash(i, 46) - 0.5) * 0.18;
    mesh.scale.set(0.75 + hash(i, 49) * 0.5, 1, 0.72 + hash(i, 52) * 0.48);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}

function addFirstBreathArtifact(
  island: SkyIslandMetadata,
  root: THREE.Group,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
  animated: THREE.Group[]
): void {
  const archMaterial = glow(island.palette.glow, 0.82);
  materials.push(archMaterial);
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + 0.35;
    const radius = 18 + (i % 2) * 2.5;
    const dx = Math.cos(angle) * radius;
    const dz = Math.sin(angle) * radius;
    const surfaceY = Math.sqrt(Math.max(0, island.bodyRadius ** 2 - dx * dx - dz * dz));
    const pivot = new THREE.Group();
    pivot.position.set(dx, surfaceY + 2.2, dz);
    const arc = new THREE.Mesh(
      track(geometries, new THREE.TorusGeometry(2.4 + (i % 2) * 0.45, 0.12, 5, 24, Math.PI * 1.28)),
      archMaterial
    );
    arc.rotation.y = angle + Math.PI / 2;
    arc.rotation.z = -Math.PI * 0.64;
    pivot.add(arc);
    root.add(pivot);
    animated.push(pivot);
  }
}

function addOpalArtifact(
  island: SkyIslandMetadata,
  root: THREE.Group,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
  animated: THREE.Group[]
): void {
  const crystalMaterial = standard(island.palette.accent, 0.2, 0.35);
  const coreMaterial = glow(island.palette.glow, 0.7);
  materials.push(crystalMaterial, coreMaterial);
  const reef = new THREE.Group();
  reef.position.y = island.bodyRadius - 0.2;
  for (let i = 0; i < 13; i++) {
    const angle = i * 2.399;
    const radius = 4 + Math.sqrt(i / 13) * 14;
    const height = 3.5 + hash(i, 61) * 8;
    const crystal = new THREE.Mesh(
      track(geometries, new THREE.ConeGeometry(0.7 + hash(i, 64), height, 5, 1)),
      i % 4 === 0 ? coreMaterial : crystalMaterial
    );
    crystal.position.set(Math.cos(angle) * radius, height * 0.5, Math.sin(angle) * radius);
    crystal.rotation.z = (hash(i, 67) - 0.5) * 0.26;
    reef.add(crystal);
  }
  root.add(reef);
  animated.push(reef);
}

function addOrreryArtifact(
  island: SkyIslandMetadata,
  root: THREE.Group,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
  animated: THREE.Group[]
): void {
  const ringMaterial = standard(island.palette.accent, 0.26, 0.72);
  const starMaterial = glow(island.palette.glow);
  materials.push(ringMaterial, starMaterial);
  const orrery = new THREE.Group();
  orrery.position.y = island.bodyRadius + 8;
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      track(
        geometries,
        new THREE.TorusGeometry(8 + i * 4.2, 0.22 + i * 0.04, 5, 48, i === 1 ? Math.PI * 1.66 : Math.PI * 2)
      ),
      ringMaterial
    );
    ring.rotation.set(0.35 + i * 0.46, i * 0.63, 0.28 - i * 0.24);
    orrery.add(ring);
  }
  const heart = new THREE.Mesh(track(geometries, new THREE.IcosahedronGeometry(1.8, 1)), starMaterial);
  orrery.add(heart);
  root.add(orrery);
  animated.push(orrery);
}

function addMoonwellArtifact(
  island: SkyIslandMetadata,
  root: THREE.Group,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
  animated: THREE.Group[]
): void {
  const dark = glow(0x07101f, 0.94);
  const rim = glow(island.palette.glow, 0.78);
  materials.push(dark, rim);
  const well = new THREE.Group();
  well.position.y = island.bodyRadius + 0.16;
  const water = new THREE.Mesh(track(geometries, new THREE.CircleGeometry(6.2, 40)), dark);
  water.rotation.x = -Math.PI / 2;
  const lip = new THREE.Mesh(track(geometries, new THREE.TorusGeometry(6.25, 0.34, 6, 48)), rim);
  lip.rotation.x = Math.PI / 2;
  well.add(water, lip);
  root.add(well);
  animated.push(well);
}

function addLastSeedArtifact(
  island: SkyIslandMetadata,
  root: THREE.Group,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
  animated: THREE.Group[]
): void {
  const shellMaterial = standard(island.palette.accent, 0.32, 0.2);
  const heartMaterial = glow(island.palette.glow);
  materials.push(shellMaterial, heartMaterial);
  const seed = new THREE.Group();
  seed.name = "sky_island_last_seed_awakening";
  seed.position.y = island.bodyRadius + 4.4;
  for (let i = 0; i < 7; i++) {
    const petalPivot = new THREE.Group();
    petalPivot.rotation.y = (i / 7) * Math.PI * 2;
    petalPivot.userData.seedPetal = i;
    const petal = new THREE.Mesh(track(geometries, new THREE.SphereGeometry(1.35, 10, 7)), shellMaterial);
    petal.scale.set(0.52, 2.7, 0.34);
    petal.position.y = 2.25;
    petal.rotation.z = -0.2;
    petalPivot.add(petal);
    seed.add(petalPivot);
  }
  const heart = new THREE.Mesh(track(geometries, new THREE.IcosahedronGeometry(1.3, 2)), heartMaterial);
  heart.name = "sky_island_last_seed_heart";
  heart.position.y = 1.1;
  seed.add(heart);
  root.add(seed);
  animated.push(seed);
}

function addIslandArtifact(
  island: SkyIslandMetadata,
  root: THREE.Group,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
  animated: THREE.Group[]
): void {
  if (island.id === "first-breath") addFirstBreathArtifact(island, root, geometries, materials, animated);
  else if (island.id === "opal-memory") addOpalArtifact(island, root, geometries, materials, animated);
  else if (island.id === "broken-orrery") addOrreryArtifact(island, root, geometries, materials, animated);
  else if (island.id === "moonwell") addMoonwellArtifact(island, root, geometries, materials, animated);
  else addLastSeedArtifact(island, root, geometries, materials, animated);
}

function createMotes(
  island: SkyIslandMetadata,
  root: THREE.Group,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[]
): { mesh: THREE.InstancedMesh; motes: Mote[] } {
  const count = 28 + island.story.order * 4;
  const geometry = track(geometries, new THREE.SphereGeometry(0.16, 5, 4));
  const material = glow(island.palette.glow, 0.72);
  materials.push(material);
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = `sky_island_${island.id}_memory_motes`;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  const motes: Mote[] = [];
  for (let i = 0; i < count; i++) {
    const angle = hash(i, 72) * Math.PI * 2;
    const radius = island.bodyRadius * (0.45 + hash(i, 75) * 0.78);
    motes.push({
      x: Math.cos(angle) * radius,
      y: (hash(i, 78) - 0.15) * island.bodyRadius * 1.25,
      z: Math.sin(angle) * radius,
      phase: hash(i, 81) * Math.PI * 2,
      radius: 0.55 + hash(i, 84) * 0.8,
      speed: 0.2 + hash(i, 87) * 0.32
    });
  }
  root.add(mesh);
  return { mesh, motes };
}

export function createSkyIsland(id: SkyIslandId): SkyIslandVisual {
  const island = getSkyIsland(id);
  const group = new THREE.Group();
  group.name = `sky_island_${id}`;
  group.position.set(island.center.x, island.center.y, island.center.z);
  group.userData.skyIslandId = id;
  group.userData.story = island.story;
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const animated: THREE.Group[] = [];

  const rock = vertexSurfaceMaterial(island.palette.rock, 0.9, 0.11);
  const stratum = standard(island.palette.stratum, 0.78, 0.05);
  const soil = vertexSurfaceMaterial(island.palette.soil, 0.93, 0.08);
  const cragRock = standard(island.palette.rock, 0.94);
  cragRock.emissive.setHex(island.palette.rock);
  cragRock.emissiveIntensity = 0.08;
  materials.push(rock, stratum, soil, cragRock);

  // This mesh is the exact analytic collision sphere exported in metadata.
  const bodyGeometry = track(geometries, new THREE.SphereGeometry(island.bodyRadius, 48, 32));
  colorizeRock(bodyGeometry, island);
  const body = new THREE.Mesh(bodyGeometry, rock);
  body.name = `sky_island_${id}_analytic_body`;
  body.receiveShadow = true;
  body.castShadow = false;
  group.add(body);

  // A thin top-cap tint follows the same sphere; it never changes collision.
  const capGeometry = track(
    geometries,
    new THREE.SphereGeometry(island.bodyRadius + 0.08, 64, 18, 0, Math.PI * 2, 0, Math.PI * 0.31)
  );
  colorizeGardenCap(capGeometry, island);
  const cap = new THREE.Mesh(capGeometry, soil);
  cap.name = `sky_island_${id}_garden_cap`;
  cap.castShadow = false;
  cap.receiveShadow = true;
  group.add(cap);

  makeStrata(island, group, geometries, stratum);
  makeUnderslungCrags(island, group, geometries, [cragRock, stratum]);
  addSurfaceMosaic(island, group, geometries, materials);
  addEdgeCrystals(island, group, geometries, materials);
  addIslandArtifact(island, group, geometries, materials, animated);
  const moteField = createMotes(island, group, geometries, materials);

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  let seedOpen = 0;
  let disposed = false;

  return {
    id,
    group,
    update(elapsed, awakened) {
      if (disposed) return;
      for (let i = 0; i < animated.length; i++) {
        const item = animated[i];
        if (id === "broken-orrery") item.rotation.y = elapsed * 0.09;
        else if (id === "opal-memory") item.rotation.y = Math.sin(elapsed * 0.18) * 0.05;
        else if (id === "first-breath") item.rotation.y = Math.sin(elapsed * 0.3 + i) * 0.08;
        else if (id === "moonwell") item.scale.setScalar(1 + Math.sin(elapsed * 0.55) * 0.012);
      }

      if (id === "last-seed") {
        seedOpen += ((awakened ? 1 : 0) - seedOpen) * 0.035;
        const seed = animated[0];
        if (seed) {
          seed.rotation.y = elapsed * (0.05 + seedOpen * 0.12);
          for (const child of seed.children) {
            const petal = child.userData.seedPetal as number | undefined;
            if (petal === undefined) continue;
            child.rotation.z = seedOpen * (0.7 + (petal % 2) * 0.09);
          }
        }
      }

      const moteBoost = awakened ? 1.28 : 1;
      for (let i = 0; i < moteField.motes.length; i++) {
        const mote = moteField.motes[i];
        const phase = elapsed * mote.speed + mote.phase;
        position.set(
          mote.x + Math.cos(phase * 1.3) * 1.4,
          mote.y + Math.sin(phase) * 2.1,
          mote.z + Math.sin(phase * 1.1) * 1.4
        );
        scale.setScalar(mote.radius * moteBoost * (0.78 + Math.sin(phase * 2.2) * 0.22));
        matrix.compose(position, quaternion, scale);
        moteField.mesh.setMatrixAt(i, matrix);
      }
      moteField.mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      group.clear();
      for (const geometry of new Set(geometries)) geometry.dispose();
      for (const material of new Set(materials)) material.dispose();
    }
  };
}

function createDawnThread(): {
  group: THREE.Group;
  update(elapsed: number): void;
  dispose(): void;
} {
  const group = new THREE.Group();
  group.name = "sky_islands_awakened_dawn_thread";
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < SKY_ISLANDS.length; i++) {
    const island = SKY_ISLANDS[i];
    points.push(new THREE.Vector3(
      island.center.x,
      island.center.y + island.bodyRadius + 11,
      island.center.z
    ));
    if (i < SKY_ISLANDS.length - 1) {
      const next = SKY_ISLANDS[i + 1];
      points.push(new THREE.Vector3(
        (island.center.x + next.center.x) * 0.5,
        Math.max(island.center.y + island.bodyRadius, next.center.y + next.bodyRadius) + 42,
        (island.center.z + next.center.z) * 0.5
      ));
    }
  }
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.4);
  const tubeGeometry = new THREE.TubeGeometry(curve, 160, 0.2, 5, false);
  const threadMaterial = glow(0xffd5a6, 0.68);
  const tube = new THREE.Mesh(tubeGeometry, threadMaterial);
  tube.name = "sky_islands_dawn_thread_ribbon";
  tube.frustumCulled = false;
  group.add(tube);

  const beadCount = 48;
  const beadGeometry = new THREE.SphereGeometry(0.72, 5, 4);
  const beadMaterial = glow(0xfff0bc, 0.9);
  const beads = new THREE.InstancedMesh(beadGeometry, beadMaterial, beadCount);
  beads.name = "sky_islands_dawn_thread_pulses";
  beads.frustumCulled = false;
  group.add(beads);
  group.visible = false;

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  return {
    group,
    update(elapsed) {
      if (!group.visible) return;
      for (let i = 0; i < beadCount; i++) {
        const t = (i / beadCount + elapsed * 0.018) % 1;
        curve.getPointAt(t, position);
        const pulse = 0.45 + 0.55 * Math.pow(Math.max(0, Math.sin(t * Math.PI * 10 - elapsed * 1.8)), 4);
        scale.setScalar(0.45 + pulse * 0.9);
        matrix.compose(position, quaternion, scale);
        beads.setMatrixAt(i, matrix);
      }
      beads.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      tubeGeometry.dispose();
      threadMaterial.dispose();
      beadGeometry.dispose();
      beadMaterial.dispose();
      group.removeFromParent();
      group.clear();
    }
  };
}

export function createSkyIslands(options: SkyIslandRuntimeOptions = {}): SkyIslandsRuntime {
  const loadDistance = options.loadDistance ?? 650;
  const unloadDistance = options.unloadDistance ?? 850;
  if (unloadDistance <= loadDistance) {
    throw new Error("[sky-islands] unloadDistance must exceed loadDistance");
  }
  const group = new THREE.Group();
  group.name = "sky_islands_streamed_geometry";
  const resident = new Map<SkyIslandId, SkyIslandVisual>();
  const dawnThread = createDawnThread();
  group.add(dawnThread.group);
  let awakened = false;
  let disposed = false;
  let lastFocus: SkyPoint = { x: 1e9, y: 1e9, z: 1e9 };

  return {
    root: group,
    group,
    update(focus, elapsed = performance.now() * 0.001) {
      if (disposed) return;
      lastFocus = focus;
      let nearestDormant: { island: SkyIslandMetadata; distance: number } | null = null;
      for (const island of SKY_ISLANDS) {
        const distance = Math.hypot(
          focus.x - island.center.x,
          focus.y - island.center.y,
          focus.z - island.center.z
        );
        const visual = resident.get(island.id);
        if (visual) {
          if (distance >= unloadDistance) {
            visual.dispose();
            resident.delete(island.id);
          } else {
            visual.update(elapsed, awakened);
          }
        } else if (distance <= loadDistance && (!nearestDormant || distance < nearestDormant.distance)) {
          nearestDormant = { island, distance };
        }
      }
      // Admit at most one island per frame so entering the archipelago cannot
      // synchronously compile the whole chain in a single hitch.
      if (nearestDormant) {
        const visual = createSkyIsland(nearestDormant.island.id);
        resident.set(nearestDormant.island.id, visual);
        group.add(visual.group);
        visual.update(elapsed, awakened);
      }
      dawnThread.update(elapsed);
    },
    setAwakened(next) {
      awakened = next;
      dawnThread.group.visible = next;
    },
    isAwakened() {
      return awakened;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const visual of resident.values()) visual.dispose();
      resident.clear();
      dawnThread.dispose();
      group.removeFromParent();
      group.clear();
    },
    debugSnapshot() {
      return SKY_ISLANDS.map((island) => ({
        id: island.id,
        resident: resident.has(island.id),
        distance: Math.round(Math.hypot(
          lastFocus.x - island.center.x,
          lastFocus.y - island.center.y,
          lastFocus.z - island.center.z
        ))
      }));
    }
  };
}
