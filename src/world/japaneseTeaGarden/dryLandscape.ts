import * as THREE from "three/webgpu";
import type { TeaGardenTerrain } from "./layout";

export const DRY_LANDSCAPE_CENTER = { x: -2344, z: 2166.5 } as const;
export const DRY_LANDSCAPE_RADII = { x: 10.8, z: 6.4 } as const;

const SAND_LIFT = 0.12;
const RIM_STONES = 96;
const STATIC_GROOVE_CAPACITY = 720;
const TRAIL_GROOVE_CAPACITY = 2400;
const TRAIL_SPACING = 0.19;
const PICKUP_RANGE = 3.7;
const RETURN_RANGE = 29;
const RAKE_RACK = { x: -2354.45, z: 2169.15 } as const;

const ROCKS = [
  { x: -2341.05, z: 2164.55, scale: 1.42, yaw: 0.36 },
  { x: -2342.35, z: 2164.1, scale: 0.68, yaw: 1.15 },
  { x: -2340.05, z: 2165.35, scale: 0.58, yaw: 2.18 },
  { x: -2347.15, z: 2164.9, scale: 1.03, yaw: 2.45 },
  { x: -2348.08, z: 2165.52, scale: 0.52, yaw: 0.72 },
  { x: -2345.05, z: 2169.1, scale: 0.76, yaw: 1.76 }
] as const;

const GROOVE_DUMMY = new THREE.Object3D();
const GROOVE_DIRECTION = new THREE.Vector3();
const GROOVE_FORWARD = new THREE.Vector3(0, 0, 1);

export type DryLandscapeDebugState = {
  held: boolean;
  raking: boolean;
  insideSand: boolean;
  distanceToRake: number;
  trailSegments: number;
  trailCapacity: number;
};

export type DryLandscape = {
  group: THREE.Group;
  update(dt: number, time: number, player: { x: number; y: number; z: number }, mode: string): void;
  interact(player: { x: number; y: number; z: number }, mode: string): boolean;
  dispose(): void;
  debugState(): DryLandscapeDebugState;
};

export type DryLandscapeOptions = {
  onCarryRake?: (rake: THREE.Group | null) => void;
  onRakingChange?: (raking: boolean) => void;
  notify?: (message: string, seconds?: number) => void;
};

/** Elliptical activity mask shared by the sand, rake, and grass scatter. */
export function inDryLandscape(x: number, z: number, pad = 0): boolean {
  const rx = Math.max(0.1, DRY_LANDSCAPE_RADII.x + pad);
  const rz = Math.max(0.1, DRY_LANDSCAPE_RADII.z + pad);
  const nx = (x - DRY_LANDSCAPE_CENTER.x) / rx;
  const nz = (z - DRY_LANDSCAPE_CENTER.z) / rz;
  return nx * nx + nz * nz <= 1;
}

function hash(index: number, salt: number): number {
  let value = Math.imul(index ^ salt, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function sandTexture(): THREE.DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const fine = hash(x + y * size, 901);
      const wave = Math.sin(x * 0.25 + Math.sin(y * 0.18) * 1.7) * 0.5 + 0.5;
      const value = Math.round(199 + fine * 22 + wave * 9);
      data[i] = value;
      data[i + 1] = Math.round(value * 0.9);
      data[i + 2] = Math.round(value * 0.72);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = "dry_landscape_warm_granite_grain";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5.4, 3.2);
  texture.needsUpdate = true;
  return texture;
}

/** Concentric rings give the surface enough vertices to hug the real slope. */
function sandGeometry(map: TeaGardenTerrain): THREE.BufferGeometry {
  const radialSegments = 12;
  const angularSegments = 96;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const { x: cx, z: cz } = DRY_LANDSCAPE_CENTER;
  positions.push(cx, map.groundTop(cx, cz) + SAND_LIFT, cz);
  uvs.push(0.5, 0.5);
  for (let ring = 1; ring <= radialSegments; ring++) {
    const radius = ring / radialSegments;
    for (let segment = 0; segment < angularSegments; segment++) {
      const angle = (segment / angularSegments) * Math.PI * 2;
      const x = cx + Math.cos(angle) * DRY_LANDSCAPE_RADII.x * radius;
      const z = cz + Math.sin(angle) * DRY_LANDSCAPE_RADII.z * radius;
      positions.push(x, map.groundTop(x, z) + SAND_LIFT, z);
      uvs.push(0.5 + Math.cos(angle) * radius * 0.5, 0.5 + Math.sin(angle) * radius * 0.5);
    }
  }
  for (let segment = 0; segment < angularSegments; segment++) {
    indices.push(0, 1 + segment, 1 + ((segment + 1) % angularSegments));
  }
  for (let ring = 1; ring < radialSegments; ring++) {
    const inner = 1 + (ring - 1) * angularSegments;
    const outer = 1 + ring * angularSegments;
    for (let segment = 0; segment < angularSegments; segment++) {
      const next = (segment + 1) % angularSegments;
      indices.push(inner + segment, outer + segment, outer + next);
      indices.push(inner + segment, outer + next, inner + next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createRim(map: TeaGardenTerrain): THREE.InstancedMesh {
  const geometry = new THREE.DodecahedronGeometry(0.5, 1);
  const material = new THREE.MeshStandardMaterial({
    color: 0xa6a18f,
    roughness: 0.98,
    metalness: 0,
    vertexColors: true
  });
  const mesh = new THREE.InstancedMesh(geometry, material, RIM_STONES);
  mesh.name = "dry_landscape_hand_set_stone_rim";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < RIM_STONES; i++) {
    const angle = (i / RIM_STONES) * Math.PI * 2;
    const stagger = (hash(i, 131) - 0.5) * 0.12;
    const x = DRY_LANDSCAPE_CENTER.x + Math.cos(angle) * (DRY_LANDSCAPE_RADII.x + stagger);
    const z = DRY_LANDSCAPE_CENTER.z + Math.sin(angle) * (DRY_LANDSCAPE_RADII.z + stagger);
    dummy.position.set(x, map.groundTop(x, z) + 0.105, z);
    dummy.rotation.set((hash(i, 137) - 0.5) * 0.14, -angle + (hash(i, 139) - 0.5) * 0.18, (hash(i, 149) - 0.5) * 0.12);
    dummy.scale.set(0.66 + hash(i, 151) * 0.12, 0.18 + hash(i, 157) * 0.055, 0.4 + hash(i, 163) * 0.07);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    color.setHex(i % 13 === 0 ? 0x849074 : i % 5 === 0 ? 0xb0aa97 : 0x9b988a);
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createRockIslands(map: TeaGardenTerrain): THREE.Group {
  const group = new THREE.Group();
  group.name = "dry_landscape_stone_islands";
  const stoneMaterials = [
    new THREE.MeshStandardMaterial({ color: 0x696a64, roughness: 0.96, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x77776f, roughness: 0.98, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x5c605b, roughness: 0.94, flatShading: true })
  ];
  const moss = new THREE.MeshStandardMaterial({ color: 0x758651, roughness: 1, flatShading: true });
  const rockGeometry = new THREE.IcosahedronGeometry(1, 1);
  const capGeometry = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.48);
  ROCKS.forEach((spec, index) => {
    const y = map.groundTop(spec.x, spec.z) + SAND_LIFT;
    const rock = new THREE.Mesh(rockGeometry, stoneMaterials[index % stoneMaterials.length]);
    rock.name = "dry_landscape_weathered_stone";
    rock.position.set(spec.x, y + spec.scale * 0.43, spec.z);
    rock.rotation.set(0.06 * (index % 3), spec.yaw, -0.04 * (index % 2));
    rock.scale.set(spec.scale * 1.15, spec.scale * 0.88, spec.scale);
    rock.castShadow = true;
    rock.receiveShadow = true;
    group.add(rock);
    if (index === 0 || index === 3 || index === 5) {
      const cap = new THREE.Mesh(capGeometry, moss);
      cap.name = "dry_landscape_velvet_moss_cap";
      cap.position.set(spec.x - spec.scale * 0.1, y + spec.scale * 1.14, spec.z + spec.scale * 0.04);
      cap.rotation.y = spec.yaw;
      cap.scale.set(spec.scale * 0.73, spec.scale * 0.18, spec.scale * 0.62);
      cap.receiveShadow = true;
      group.add(cap);
    }
  });
  return group;
}

function cylinderBetween(a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(b, a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.92, direction.length(), 8), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

function createRake(): THREE.Group {
  const group = new THREE.Group();
  group.name = "dry_landscape_little_rake";
  const bamboo = new THREE.MeshStandardMaterial({ color: 0xc18a43, roughness: 0.82 });
  const darkBamboo = new THREE.MeshStandardMaterial({ color: 0x7c512b, roughness: 0.9 });
  const cord = new THREE.MeshStandardMaterial({ color: 0xb5392f, roughness: 0.84 });
  const top = new THREE.Vector3(0, 0, 0);
  const head = new THREE.Vector3(0, -1.52, 0.5);
  const handle = cylinderBetween(top, head, 0.035, bamboo);
  handle.name = "garden_rake_bamboo_handle";
  handle.castShadow = true;
  handle.receiveShadow = true;
  group.add(handle);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.09, 0.1), darkBamboo);
  bar.name = "garden_rake_head_bar";
  bar.position.copy(head);
  bar.castShadow = true;
  bar.receiveShadow = true;
  group.add(bar);
  for (let i = 0; i < 7; i++) {
    const tine = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.25, 0.045), darkBamboo);
    tine.name = "garden_rake_tine";
    tine.position.set(-0.45 + i * 0.15, head.y - 0.13, head.z + 0.04);
    tine.rotation.x = -0.18;
    tine.receiveShadow = true;
    group.add(tine);
  }
  const tie = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 5, 10), cord);
  tie.name = "garden_rake_vermilion_wish_cord";
  tie.rotation.x = Math.PI / 2;
  tie.position.set(0, -0.23, 0.075);
  group.add(tie);
  return group;
}

function createRakeRack(map: TeaGardenTerrain, rake: THREE.Group): THREE.Group {
  const group = new THREE.Group();
  group.name = "dry_landscape_rake_rack";
  const y = map.groundTop(RAKE_RACK.x, RAKE_RACK.z);
  group.position.set(RAKE_RACK.x, y, RAKE_RACK.z);
  group.rotation.y = -0.36;
  const bamboo = new THREE.MeshStandardMaterial({ color: 0x76502d, roughness: 0.92 });
  for (const x of [-0.38, 0.38]) {
    const upright = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 1.28, 7), bamboo);
    upright.position.set(x, 0.64, 0);
    upright.castShadow = true;
    upright.receiveShadow = true;
    group.add(upright);
  }
  const rest = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.94, 7), bamboo);
  rest.rotation.z = Math.PI / 2;
  rest.position.y = 1.05;
  rest.castShadow = true;
  rest.receiveShadow = true;
  group.add(rest);
  group.add(rake);
  rake.position.set(0.1, 1.92, -0.05);
  rake.rotation.set(0.08, 0.08, -0.12);
  return group;
}

function nearRock(x: number, z: number, clearance = 0.25): boolean {
  return ROCKS.some((rock) => Math.hypot(x - rock.x, z - rock.z) < rock.scale * 1.15 + clearance);
}

function addGrooveSegment(
  mesh: THREE.InstancedMesh,
  index: number,
  map: TeaGardenTerrain,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  width: number
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const ay = map.groundTop(ax, az) + SAND_LIFT + 0.018;
  const by = map.groundTop(bx, bz) + SAND_LIFT + 0.018;
  const dy = by - ay;
  const length = Math.hypot(dx, dy, dz);
  if (length < 0.01) return;
  const x = (ax + bx) * 0.5;
  const z = (az + bz) * 0.5;
  GROOVE_DUMMY.position.set(x, (ay + by) * 0.5, z);
  GROOVE_DIRECTION.set(dx, dy, dz).normalize();
  GROOVE_DUMMY.quaternion.setFromUnitVectors(GROOVE_FORWARD, GROOVE_DIRECTION);
  GROOVE_DUMMY.scale.set(width, 0.01, length + 0.07);
  GROOVE_DUMMY.updateMatrix();
  mesh.setMatrixAt(index, GROOVE_DUMMY.matrix);
}

function createGrooveMesh(name: string, capacity: number, color: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 }),
    capacity
  );
  mesh.name = name;
  mesh.count = 0;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function fillQuietPattern(mesh: THREE.InstancedMesh, map: TeaGardenTerrain): number {
  let index = 0;
  const add = (ax: number, az: number, bx: number, bz: number, width = 0.043) => {
    if (index >= STATIC_GROOVE_CAPACITY) return;
    if (!inDryLandscape(ax, az, -0.34) || !inDryLandscape(bx, bz, -0.34)) return;
    if (nearRock((ax + bx) * 0.5, (az + bz) * 0.5, 0.16)) return;
    addGrooveSegment(mesh, index++, map, ax, az, bx, bz, width);
  };
  // Long, gently breathing currents replace the old perfect concentric target.
  for (let row = 0; row < 13; row++) {
    const baseZ = DRY_LANDSCAPE_CENTER.z - 4.85 + row * 0.78;
    let previous: { x: number; z: number } | null = null;
    for (let step = 0; step <= 56; step++) {
      const x = DRY_LANDSCAPE_CENTER.x - 10.2 + (step / 56) * 20.4;
      const z = baseZ + Math.sin((x - DRY_LANDSCAPE_CENTER.x) * 0.34 + row * 0.58) * 0.22;
      if (previous) add(previous.x, previous.z, x, z);
      previous = { x, z };
    }
  }
  // A few close ripples let each stone read as an island in imagined water.
  for (const island of [ROCKS[0], ROCKS[3], ROCKS[5]]) {
    for (let ring = 0; ring < 3; ring++) {
      const rx = island.scale * (1.34 + ring * 0.32);
      const rz = island.scale * (1.05 + ring * 0.28);
      let previous: { x: number; z: number } | null = null;
      for (let step = 0; step <= 38; step++) {
        const angle = (step / 38) * Math.PI * 2;
        const x = island.x + Math.cos(angle) * rx;
        const z = island.z + Math.sin(angle) * rz;
        if (previous) add(previous.x, previous.z, x, z, 0.038);
        previous = { x, z };
      }
    }
  }
  mesh.count = index;
  mesh.instanceMatrix.needsUpdate = true;
  return index;
}

function createLeafScatter(map: TeaGardenTerrain): THREE.InstancedMesh {
  const shape = new THREE.BufferGeometry();
  shape.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, -0.12, -0.075, 0, 0, 0, 0, 0.12, 0.075, 0, 0
  ], 3));
  shape.setIndex([0, 1, 2, 0, 2, 3]);
  shape.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: 0xb35b3e, roughness: 0.94, side: THREE.DoubleSide, vertexColors: true });
  const count = 22;
  const mesh = new THREE.InstancedMesh(shape, material, count);
  mesh.name = "dry_landscape_fallen_maple_leaves";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const angle = hash(i, 401) * Math.PI * 2;
    const radius = 0.74 + hash(i, 409) * 0.2;
    const x = DRY_LANDSCAPE_CENTER.x + Math.cos(angle) * DRY_LANDSCAPE_RADII.x * radius;
    const z = DRY_LANDSCAPE_CENTER.z + Math.sin(angle) * DRY_LANDSCAPE_RADII.z * radius;
    dummy.position.set(x, map.groundTop(x, z) + SAND_LIFT + 0.032, z);
    dummy.rotation.set((hash(i, 419) - 0.5) * 0.2, hash(i, 421) * Math.PI * 2, (hash(i, 431) - 0.5) * 0.16);
    dummy.scale.setScalar(0.72 + hash(i, 433) * 0.48);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    color.setHex(i % 4 === 0 ? 0xd18a42 : i % 3 === 0 ? 0x8f4939 : 0xb35b3e);
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.receiveShadow = true;
  return mesh;
}

export function createDryLandscape(map: TeaGardenTerrain, options: DryLandscapeOptions = {}): DryLandscape {
  const group = new THREE.Group();
  group.name = "japanese_tea_garden_dry_landscape";

  const grain = sandTexture();
  const sand = new THREE.Mesh(
    sandGeometry(map),
    new THREE.MeshStandardMaterial({
      color: 0xfff1d4,
      map: grain,
      roughness: 0.98,
      metalness: 0,
      emissive: 0x2b1d0e,
      emissiveIntensity: 0.055
    })
  );
  sand.name = "dry_garden_terrain_conforming_sand";
  sand.receiveShadow = true;
  group.add(sand, createRim(map), createRockIslands(map), createLeafScatter(map));

  const quietGrooves = createGrooveMesh("dry_garden_quiet_current_grooves", STATIC_GROOVE_CAPACITY, 0x887960);
  fillQuietPattern(quietGrooves, map);
  const trailGrooves = createGrooveMesh("dry_garden_player_rake_trails", TRAIL_GROOVE_CAPACITY, 0x71634f);
  group.add(quietGrooves, trailGrooves);

  const rake = createRake();
  const rack = createRakeRack(map, rake);
  group.add(rack);

  let held = false;
  let raking = false;
  let insideSand = false;
  let distanceToRake = Number.POSITIVE_INFINITY;
  let trailSegments = 0;
  let trailWrite = 0;
  let promptVisible = false;
  let previousPlayer: { x: number; z: number } | null = null;
  let previousTrail: { x: number; z: number; dx: number; dz: number } | null = null;
  let disposed = false;

  const resetRakePose = () => {
    rack.add(rake);
    rake.position.set(0.1, 1.92, -0.05);
    rake.rotation.set(0.08, 0.08, -0.12);
    rake.scale.setScalar(1);
    rake.visible = true;
  };

  const setRaking = (next: boolean) => {
    if (raking === next) return;
    raking = next;
    options.onRakingChange?.(next);
  };

  const setHeld = (next: boolean, message?: string) => {
    if (held === next) return;
    held = next;
    setRaking(false);
    previousTrail = null;
    previousPlayer = null;
    if (next) {
      rake.removeFromParent();
      options.onCarryRake?.(rake);
    } else {
      options.onCarryRake?.(null);
      resetRakePose();
    }
    if (message) options.notify?.(message, 3.3);
  };

  const writeTrail = (from: { x: number; z: number; dx: number; dz: number }, to: { x: number; z: number; dx: number; dz: number }) => {
    const perpAX = -from.dz;
    const perpAZ = from.dx;
    const perpBX = -to.dz;
    const perpBZ = to.dx;
    for (let tine = -2; tine <= 2; tine++) {
      const offset = tine * 0.17;
      const ax = from.x + perpAX * offset;
      const az = from.z + perpAZ * offset;
      const bx = to.x + perpBX * offset;
      const bz = to.z + perpBZ * offset;
      if (!inDryLandscape(ax, az, -0.38) || !inDryLandscape(bx, bz, -0.38)) continue;
      if (nearRock((ax + bx) * 0.5, (az + bz) * 0.5, 0.22)) continue;
      addGrooveSegment(trailGrooves, trailWrite, map, ax, az, bx, bz, 0.052);
      trailWrite = (trailWrite + 1) % TRAIL_GROOVE_CAPACITY;
      trailSegments = Math.min(TRAIL_GROOVE_CAPACITY, trailSegments + 1);
    }
    trailGrooves.count = trailSegments;
    trailGrooves.instanceMatrix.needsUpdate = true;
  };

  return {
    group,
    update(_dt, _time, player, mode) {
      if (disposed) return;
      distanceToRake = Math.hypot(player.x - RAKE_RACK.x, player.z - RAKE_RACK.z);
      insideSand = inDryLandscape(player.x, player.z, -0.55);
      if (!held) {
        if (mode === "walk" && distanceToRake <= PICKUP_RANGE + 1.2 && !promptVisible) {
          options.notify?.("E — pick up the little garden rake", 2.1);
          promptVisible = true;
        } else if (distanceToRake > PICKUP_RANGE + 1.8) {
          promptVisible = false;
        }
        return;
      }
      if (mode !== "walk" || Math.hypot(player.x - DRY_LANDSCAPE_CENTER.x, player.z - DRY_LANDSCAPE_CENTER.z) > RETURN_RANGE) {
        setHeld(false, "The rake has returned to its garden stand.");
        return;
      }
      if (!previousPlayer) {
        previousPlayer = { x: player.x, z: player.z };
        return;
      }
      const moveX = player.x - previousPlayer.x;
      const moveZ = player.z - previousPlayer.z;
      const moved = Math.hypot(moveX, moveZ);
      previousPlayer = { x: player.x, z: player.z };
      if (!insideSand || moved < 0.025) {
        setRaking(false);
        previousTrail = null;
        return;
      }
      const dx = moveX / moved;
      const dz = moveZ / moved;
      const current = { x: player.x - dx * 0.92, z: player.z - dz * 0.92, dx, dz };
      if (!previousTrail) {
        previousTrail = current;
        setRaking(true);
        return;
      }
      const trailDistance = Math.hypot(current.x - previousTrail.x, current.z - previousTrail.z);
      if (trailDistance < TRAIL_SPACING) return;
      const steps = Math.min(8, Math.floor(trailDistance / TRAIL_SPACING));
      let from = previousTrail;
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const to = {
          x: THREE.MathUtils.lerp(previousTrail.x, current.x, t),
          z: THREE.MathUtils.lerp(previousTrail.z, current.z, t),
          dx: THREE.MathUtils.lerp(previousTrail.dx, current.dx, t),
          dz: THREE.MathUtils.lerp(previousTrail.dz, current.dz, t)
        };
        const directionLength = Math.hypot(to.dx, to.dz) || 1;
        to.dx /= directionLength;
        to.dz /= directionLength;
        writeTrail(from, to);
        from = to;
      }
      previousTrail = current;
      setRaking(true);
    },
    interact(player, mode) {
      if (disposed) return false;
      if (held) {
        setHeld(false, "Rake returned. Your sand trails will remain awhile.");
        return true;
      }
      if (mode !== "walk" || Math.hypot(player.x - RAKE_RACK.x, player.z - RAKE_RACK.z) > PICKUP_RANGE) return false;
      setHeld(true, "Rake in hand — walk across the sand to draw five gentle trails. E sets it down.");
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (held) setHeld(false);
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        geometries.add(mesh.geometry);
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) materials.add(material);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      grain.dispose();
      group.removeFromParent();
    },
    debugState() {
      return { held, raking, insideSand, distanceToRake, trailSegments, trailCapacity: TRAIL_GROOVE_CAPACITY };
    }
  };
}
