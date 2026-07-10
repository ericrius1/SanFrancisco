import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import { avatarFromSeed } from "../../player/avatar";
import { buildRig, poseIdle, type Rig } from "../../player/rig";
import type { WorldMap } from "../heightmap";
import {
  CORONA_DOG_GATE,
  CORONA_DOG_PARK,
  CORONA_HEIGHTS_SUMMIT,
  CORONA_TRAILS,
  type CoronaTrail,
  type CoronaXZ
} from "./layout";

const DETAIL_RANGE = 1450;
const ACTIVITY_RANGE = 700;
const HILL_RX = 118;
const HILL_RZ = 126;
const HILL_STEP = 4;
const DOG_SURFACE_LIFT = 0.18;
const CORONA_GROUND_LIFT = 0.38;
const preparedMaps = new WeakSet<WorldMap>();

type FencePiece = { ax: number; az: number; bx: number; bz: number };
type TrailSample = { x: number; z: number; tx: number; tz: number };
type OwnerAction = "watch" | "ball" | "frisbee";

type ParkOwner = {
  action: OwnerAction;
  rig: Rig;
  x: number;
  z: number;
  facing: number;
};

type DogStyle = {
  name: string;
  coat: number;
  accent: number;
  collar: number;
  scale: number;
  longBody?: boolean;
  floppy?: boolean;
};

type ParkDog = {
  style: DogStyle;
  group: THREE.Group;
  legs: THREE.Group[];
  head: THREE.Group;
  tail: THREE.Group;
  x: number;
  z: number;
  heading: number;
  stride: number;
  speed: number;
};

export type CoronaHeightsStats = {
  dogs: number;
  owners: number;
  summit: typeof CORONA_HEIGHTS_SUMMIT;
};

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function smooth01(v: number) {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function fract(v: number) {
  return v - Math.floor(v);
}

function hash2(x: number, z: number, salt = 0) {
  return fract(Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453123);
}

function valueNoise(x: number, z: number, cell: number, salt: number) {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const ax = smooth01(fx - ix);
  const az = smooth01(fz - iz);
  const a = lerp(hash2(ix, iz, salt), hash2(ix + 1, iz, salt), ax);
  const b = lerp(hash2(ix, iz + 1, salt), hash2(ix + 1, iz + 1, salt), ax);
  return lerp(a, b, az);
}

/**
 * The shipped Corona Heights lawn is a constrained-Delaunay overlay while
 * WorldMap queries are bilinear. On the hill's sharp folds those two surfaces
 * can differ by almost 30 cm, enough for either the lawn or the player to poke
 * through an authored detail skin. Raise the query carpet beneath the authored
 * hill, then feather it outside the visible skin. This is deliberately called
 * immediately after WorldMap.load(), before physics and world props are built.
 */
export function prepareCoronaHeightsGround(map: WorldMap) {
  if (preparedMaps.has(map)) return;
  preparedMaps.add(map);
  const { cellSize, width, height, minX, minZ } = map.meta.grid;
  const cx = CORONA_HEIGHTS_SUMMIT.x;
  const cz = CORONA_HEIGHTS_SUMMIT.z + 8;
  const minGX = Math.max(0, Math.floor((cx - HILL_RX * 1.12 - minX) / cellSize));
  const maxGX = Math.min(width - 1, Math.ceil((cx + HILL_RX * 1.12 - minX) / cellSize));
  const minGZ = Math.max(0, Math.floor((cz - HILL_RZ * 1.12 - minZ) / cellSize));
  const maxGZ = Math.min(height - 1, Math.ceil((cz + HILL_RZ * 1.12 - minZ) / cellSize));
  for (let gz = minGZ; gz <= maxGZ; gz++) {
    const z = minZ + gz * cellSize;
    for (let gx = minGX; gx <= maxGX; gx++) {
      const x = minX + gx * cellSize;
      const q = ((x - cx) / HILL_RX) ** 2 + ((z - cz) / HILL_RZ) ** 2;
      if (q >= 1.12) continue;
      const feather = 1 - smooth01((q - 0.9) / 0.22);
      map.groundTops[gz * width + gx] += CORONA_GROUND_LIFT * feather;
    }
  }
}

function pointInPolygon(x: number, z: number, polygon: readonly CoronaXZ[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function pointSegmentDistance(x: number, z: number, a: CoronaXZ, b: CoronaXZ) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const ll = dx * dx + dz * dz;
  const t = ll > 1e-6 ? clamp01(((x - a[0]) * dx + (z - a[1]) * dz) / ll) : 0;
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

function distanceToTrails(x: number, z: number) {
  let best = Infinity;
  for (const trail of CORONA_TRAILS) {
    for (let i = 0; i < trail.points.length - 1; i++) {
      best = Math.min(best, pointSegmentDistance(x, z, trail.points[i], trail.points[i + 1]));
    }
  }
  return best;
}

function sampleTrail(points: readonly CoronaXZ[], spacing = 2.4): TrailSample[] {
  const positions: { x: number; z: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    const count = Math.max(1, Math.ceil(length / spacing));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      positions.push({ x: a[0] + dx * t, z: a[1] + dz * t });
    }
  }
  const last = points[points.length - 1];
  positions.push({ x: last[0], z: last[1] });
  return positions.map((p, i) => {
    const prev = positions[Math.max(0, i - 1)];
    const next = positions[Math.min(positions.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const inv = 1 / (Math.hypot(dx, dz) || 1);
    return { ...p, tx: dx * inv, tz: dz * inv };
  });
}

function makeHillSkin(map: WorldMap) {
  const cx = CORONA_HEIGHTS_SUMMIT.x;
  const cz = CORONA_HEIGHTS_SUMMIT.z + 8;
  const nx = Math.ceil((HILL_RX * 2) / HILL_STEP) + 1;
  const nz = Math.ceil((HILL_RZ * 2) / HILL_STEP) + 1;
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  const inside = new Uint8Array(nx * nz);
  const normal = new THREE.Vector3();
  const green = new THREE.Color(0x4f6d3d);
  const dry = new THREE.Color(0x8b833f);
  const ochre = new THREE.Color(0xa06d38);
  const chert = new THREE.Color(0x84443b);
  const darkChert = new THREE.Color(0x512d2d);
  const color = new THREE.Color();

  for (let gz = 0; gz < nz; gz++) {
    const z = cz - HILL_RZ + gz * HILL_STEP;
    for (let gx = 0; gx < nx; gx++) {
      const x = cx - HILL_RX + gx * HILL_STEP;
      const i = gz * nx + gx;
      const q = ((x - cx) / HILL_RX) ** 2 + ((z - cz) / HILL_RZ) ** 2;
      const edge = 1.08 + (hash2(gx, gz, 9) - 0.5) * 0.035;
      inside[i] = q < edge && !pointInPolygon(x, z, CORONA_DOG_PARK) ? 1 : 0;
      const y = map.groundTop(x, z) + 0.08;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      map.normal(x, z, normal, 4);
      const slope = 1 - normal.y;
      const ridge = clamp01((y - 124) / 27);
      const grain = valueNoise(x, z, 21, 21);
      const band = valueNoise(x + z * 0.22, z - x * 0.16, 37, 23);
      let rock = clamp01((slope - 0.035) / 0.2) * (0.32 + ridge * 0.78);
      rock = clamp01(rock + clamp01((y - 140) / 11) * 0.38) * (0.48 + grain * 0.52);
      const edgeBlend = smooth01((q - 0.7) / 0.36);
      color.copy(green).lerp(dry, 0.6 + ridge * 0.24).lerp(ochre, rock * 0.28);
      color.lerp(grain > 0.32 ? chert : darkChert, rock * (0.58 + band * 0.32));
      color.lerp(green, edgeBlend * 0.88);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
  }

  const indices: number[] = [];
  for (let gz = 0; gz < nz - 1; gz++) {
    for (let gx = 0; gx < nx - 1; gx++) {
      const a = gz * nx + gx;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      if (inside[a] && inside[b] && inside[c]) indices.push(a, c, b);
      if (inside[b] && inside[c] && inside[d]) indices.push(b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.98,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "corona_heights_hill_skin";
  mesh.receiveShadow = true;
  return mesh;
}

/** The old quarry/slickenside beside Peixotto Playground is the hill's other
 * defining face. The base bake paints every park cell green, so a dedicated
 * terrain-conforming skin restores its pale polished stone and rusty chert
 * seams without changing the collision heightfield underneath. */
function makeQuarryFace(map: WorldMap) {
  const cx = 578;
  const cz = 2725;
  const rx = 66;
  const rz = 92;
  const step = 4;
  const nx = Math.ceil((rx * 2) / step) + 1;
  const nz = Math.ceil((rz * 2) / step) + 1;
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  const inside = new Uint8Array(nx * nz);
  const normal = new THREE.Vector3();
  const pale = new THREE.Color(0xb8aa9a);
  const pink = new THREE.Color(0xa57e73);
  const rust = new THREE.Color(0x87483b);
  const shadow = new THREE.Color(0x57403c);
  const edgeGreen = new THREE.Color(0x526d3e);
  const color = new THREE.Color();
  for (let gz = 0; gz < nz; gz++) {
    const z = cz - rz + gz * step;
    for (let gx = 0; gx < nx; gx++) {
      const x = cx - rx + gx * step;
      const i = gz * nx + gx;
      const q = ((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2;
      map.normal(x, z, normal, 4);
      const slope = 1 - normal.y;
      inside[i] = q < 1 && slope > 0.018 ? 1 : 0;
      positions[i * 3] = x;
      positions[i * 3 + 1] = map.groundTop(x, z) + 0.11;
      positions[i * 3 + 2] = z;
      const grain = valueNoise(x, z, 15, 149);
      const seam = valueNoise(x + z * 0.35, z - x * 0.12, 24, 151);
      const shadowing = clamp01((slope - 0.08) / 0.24);
      const edge = smooth01((q - 0.7) / 0.27);
      color.copy(pale).lerp(pink, 0.2 + seam * 0.24 + grain * 0.12).lerp(rust, seam * shadowing * 0.62);
      color.lerp(shadow, shadowing * (1 - seam) * 0.32).lerp(edgeGreen, edge * 0.86);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
  }
  const indices: number[] = [];
  for (let gz = 0; gz < nz - 1; gz++) {
    for (let gx = 0; gx < nx - 1; gx++) {
      const a = gz * nx + gx;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      if (inside[a] && inside[b] && inside[c]) indices.push(a, c, b);
      if (inside[b] && inside[c] && inside[d]) indices.push(b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    })
  );
  mesh.name = "corona_heights_quarry_slickenside";
  mesh.receiveShadow = true;
  return mesh;
}

function makeTrailRibbon(map: WorldMap, trail: CoronaTrail, material: THREE.Material) {
  const samples = sampleTrail(trail.points);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const half = trail.width / 2;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const nx = -p.tz;
    const nz = p.tx;
    for (const side of [-1, 1]) {
      const x = p.x + nx * half * side;
      const z = p.z + nz * half * side;
      positions.push(x, map.groundTop(x, z) + 0.165, z);
      const shade = 0.86 + hash2(i, side, trail.name.length) * 0.18;
      colors.push(shade, shade, shade);
    }
    if (i < samples.length - 1) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `corona_trail_${trail.name.toLowerCase().replaceAll(" ", "_")}`;
  mesh.receiveShadow = true;
  return mesh;
}

function makeStepTies(map: WorldMap, trail: CoronaTrail, material: THREE.Material) {
  const samples = sampleTrail(trail.points, 1.5);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, samples.length);
  mesh.name = `corona_steps_${trail.name.toLowerCase().replaceAll(" ", "_")}`;
  const dummy = new THREE.Object3D();
  samples.forEach((p, i) => {
    const nx = -p.tz;
    const nz = p.tx;
    dummy.position.set(p.x, map.groundTop(p.x, p.z) + 0.19, p.z);
    dummy.rotation.set(0, Math.atan2(-nz, nx), 0);
    dummy.scale.set(trail.width + 0.25, 0.16, 0.24);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function makeTrails(map: WorldMap) {
  const group = new THREE.Group();
  group.name = "corona_heights_trails";
  const dirt = new THREE.MeshStandardMaterial({ color: 0xaa8b61, vertexColors: true, roughness: 1 });
  const compacted = new THREE.MeshStandardMaterial({ color: 0x88755e, vertexColors: true, roughness: 1 });
  const tie = new THREE.MeshStandardMaterial({ color: 0x5d4934, roughness: 0.98 });
  for (const trail of CORONA_TRAILS) {
    group.add(makeTrailRibbon(map, trail, trail.surface === "dirt" ? dirt : compacted));
    if (trail.surface === "steps") group.add(makeStepTies(map, trail, tie));
  }
  return group;
}

function makeRockField(map: WorldMap, physics: Physics) {
  const geometry = new THREE.DodecahedronGeometry(1, 0);
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const capacity = 118;
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = "corona_heights_chert_outcrops";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const normal = new THREE.Vector3();
  let count = 0;
  for (let i = 0; i < 720 && count < capacity; i++) {
    const a = hash2(i, 3, 11) * Math.PI * 2;
    const r = Math.sqrt(hash2(i, 7, 17));
    const x = CORONA_HEIGHTS_SUMMIT.x + Math.cos(a) * HILL_RX * r;
    const z = CORONA_HEIGHTS_SUMMIT.z + 8 + Math.sin(a) * HILL_RZ * r;
    const y = map.groundTop(x, z);
    map.normal(x, z, normal, 4);
    const steep = 1 - normal.y;
    if (y < 126 || (steep < 0.065 && y < 139) || hash2(i, 19, 23) < 0.38) continue;
    if (distanceToTrails(x, z) < 2.8 || pointInPolygon(x, z, CORONA_DOG_PARK)) continue;
    if (Math.hypot(x - CORONA_HEIGHTS_SUMMIT.x, z - CORONA_HEIGHTS_SUMMIT.z) < 5.2) continue;
    const size = 0.65 + hash2(i, 29, 31) * 1.8 + steep * 3.5;
    const sx = size * (1.15 + hash2(i, 47));
    const sy = size * (0.5 + steep * 1.5);
    const sz = size * (0.8 + hash2(i, 53));
    const yaw = hash2(i, 41) * Math.PI * 2;
    dummy.position.set(x, y - size * 0.34, z);
    dummy.rotation.set(hash2(i, 37) * 0.8, yaw, hash2(i, 43) * 0.55);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(count, dummy.matrix);
    color.setHex(hash2(i, 59) > 0.28 ? 0x87463d : 0x593235).offsetHSL((hash2(i, 61) - 0.5) * 0.035, 0, (hash2(i, 67) - 0.5) * 0.12);
    mesh.setColorAt(count, color);
    // Tiny fragments remain decorative, but the big chert blocks are real
    // obstacles for walkers, vehicles, paint rays and grab tools.
    if (size > 1.4) {
      const visibleHeight = Math.max(0.36, sy - size * 0.34);
      const cy = y + visibleHeight * 0.46;
      const hx = sx * 0.74;
      const hy = visibleHeight * 0.46;
      const hz = sz * 0.74;
      const body = physics.world.createBox({
        type: BodyType.Static,
        position: [x, cy, z],
        halfExtents: [hx, hy, hz],
        friction: 0.82
      });
      physics.world.setBodyTransform(body, [x, cy, z], [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
      physics.addQuerySolid(body, { x, y: cy, z, hx, hy, hz, yaw });
    }
    count++;
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function makeTuftGeometry() {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let q = 0; q < 3; q++) {
    const a = (q / 3) * Math.PI;
    const dx = Math.cos(a) * 0.5;
    const dz = Math.sin(a) * 0.5;
    const base = q * 5;
    positions.push(-dx, 0, -dz, dx, 0, dz, dx * 0.55, 0.72, dz * 0.55, 0, 1.05, 0, -dx * 0.55, 0.72, -dz * 0.55);
    for (let i = 0; i < 5; i++) normals.push(0, 1, 0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 4, base + 4, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function makeHillGrass(map: WorldMap) {
  const geometry = makeTuftGeometry();
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98, side: THREE.DoubleSide });
  const capacity = 960;
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = "corona_heights_grass_tufts";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const normal = new THREE.Vector3();
  let count = 0;
  for (let gz = -49; gz <= 49 && count < capacity; gz++) {
    for (let gx = -46; gx <= 46 && count < capacity; gx++) {
      const x = CORONA_HEIGHTS_SUMMIT.x + gx * 2.55 + (hash2(gx, gz, 3) - 0.5) * 2.1;
      const z = CORONA_HEIGHTS_SUMMIT.z + 8 + gz * 2.55 + (hash2(gx, gz, 5) - 0.5) * 2.1;
      const q = ((x - CORONA_HEIGHTS_SUMMIT.x) / HILL_RX) ** 2 + ((z - CORONA_HEIGHTS_SUMMIT.z - 8) / HILL_RZ) ** 2;
      if (q > 0.94 || hash2(gx, gz, 7) > 0.22) continue;
      if (pointInPolygon(x, z, CORONA_DOG_PARK) || distanceToTrails(x, z) < 2.7) continue;
      if (Math.hypot(x - CORONA_HEIGHTS_SUMMIT.x, z - CORONA_HEIGHTS_SUMMIT.z) < 5.5) continue;
      const y = map.groundTop(x, z);
      map.normal(x, z, normal, 2);
      if (normal.y < 0.86 || (y > 140 && hash2(gx, gz, 11) > 0.48)) continue;
      const s = 0.45 + hash2(gx, gz, 13) * 0.9;
      dummy.position.set(x, y + 0.045, z);
      dummy.rotation.set(0, hash2(gx, gz, 17) * Math.PI * 2, 0);
      dummy.scale.set(s * (0.72 + hash2(gx, gz, 19) * 0.5), s, s * (0.72 + hash2(gx, gz, 23) * 0.5));
      dummy.updateMatrix();
      mesh.setMatrixAt(count, dummy.matrix);
      color.setHex(hash2(gx, gz, 29) > 0.45 ? 0x7c7d34 : 0x536f35).offsetHSL((hash2(gx, gz, 31) - 0.5) * 0.05, 0, (hash2(gx, gz, 37) - 0.5) * 0.12);
      mesh.setColorAt(count, color);
      count++;
    }
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function makeWildflowers(map: WorldMap) {
  const group = new THREE.Group();
  group.name = "corona_heights_wildflowers";
  const capacity = 220;
  const stems = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.025, 0.035, 1, 5),
    new THREE.MeshStandardMaterial({ color: 0x45642d, roughness: 1 }),
    capacity
  );
  const blooms = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
    capacity
  );
  stems.name = "corona_flower_stems";
  blooms.name = "corona_flower_blooms";
  const stemDummy = new THREE.Object3D();
  const bloomDummy = new THREE.Object3D();
  const bloomColor = new THREE.Color();
  const palettes = [0xf0a134, 0xd9652f, 0x7c6ec8, 0xf2d457];
  let count = 0;
  for (let i = 0; i < 1800 && count < capacity; i++) {
    const a = hash2(i, 1, 71) * Math.PI * 2;
    const r = Math.sqrt(hash2(i, 2, 73));
    const x = CORONA_HEIGHTS_SUMMIT.x + Math.cos(a) * HILL_RX * r;
    const z = CORONA_HEIGHTS_SUMMIT.z + 8 + Math.sin(a) * HILL_RZ * r;
    if (hash2(i, 3, 79) > 0.18 || pointInPolygon(x, z, CORONA_DOG_PARK) || distanceToTrails(x, z) < 3.2) continue;
    const y = map.groundTop(x, z);
    if (y > 145 || Math.hypot(x - CORONA_HEIGHTS_SUMMIT.x, z - CORONA_HEIGHTS_SUMMIT.z) < 6) continue;
    const h = 0.28 + hash2(i, 5, 83) * 0.55;
    stemDummy.position.set(x, y + h / 2 + 0.04, z);
    stemDummy.scale.set(1, h, 1);
    stemDummy.updateMatrix();
    stems.setMatrixAt(count, stemDummy.matrix);
    bloomDummy.position.set(x, y + h + 0.05, z);
    bloomDummy.rotation.set(hash2(i, 7) * 0.4, hash2(i, 11) * Math.PI * 2, 0);
    bloomDummy.scale.setScalar(0.075 + hash2(i, 13) * 0.07);
    bloomDummy.updateMatrix();
    blooms.setMatrixAt(count, bloomDummy.matrix);
    bloomColor.setHex(palettes[Math.floor(hash2(i, 17) * palettes.length) % palettes.length]);
    blooms.setColorAt(count, bloomColor);
    count++;
  }
  stems.count = blooms.count = count;
  stems.instanceMatrix.needsUpdate = true;
  blooms.instanceMatrix.needsUpdate = true;
  if (blooms.instanceColor) blooms.instanceColor.needsUpdate = true;
  stems.frustumCulled = blooms.frustumCulled = false;
  group.add(stems, blooms);
  return group;
}

function makeShrubsAndTrees(map: WorldMap) {
  const group = new THREE.Group();
  group.name = "corona_heights_shrubs_and_trees";
  const shrubCapacity = 72;
  const shrubs = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98 }),
    shrubCapacity
  );
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  let shrubsCount = 0;
  for (let i = 0; i < 420 && shrubsCount < shrubCapacity; i++) {
    const a = hash2(i, 2, 91) * Math.PI * 2;
    const r = 0.72 + hash2(i, 3, 97) * 0.28;
    const x = CORONA_HEIGHTS_SUMMIT.x + Math.cos(a) * HILL_RX * r;
    const z = CORONA_HEIGHTS_SUMMIT.z + 8 + Math.sin(a) * HILL_RZ * r;
    if (hash2(i, 5, 101) > 0.27 || distanceToTrails(x, z) < 3 || pointInPolygon(x, z, CORONA_DOG_PARK)) continue;
    const s = 0.7 + hash2(i, 7, 103) * 1.35;
    dummy.position.set(x, map.groundTop(x, z) + s * 0.4, z);
    dummy.rotation.set(0, hash2(i, 11) * Math.PI * 2, 0);
    dummy.scale.set(s * 1.25, s * 0.7, s);
    dummy.updateMatrix();
    shrubs.setMatrixAt(shrubsCount, dummy.matrix);
    color.setHex(hash2(i, 13) > 0.3 ? 0x3f5e32 : 0x6b6a34).offsetHSL(0, 0, (hash2(i, 17) - 0.5) * 0.1);
    shrubs.setColorAt(shrubsCount, color);
    shrubsCount++;
  }
  shrubs.count = shrubsCount;
  shrubs.instanceMatrix.needsUpdate = true;
  if (shrubs.instanceColor) shrubs.instanceColor.needsUpdate = true;
  shrubs.castShadow = true;
  shrubs.receiveShadow = true;
  shrubs.frustumCulled = false;

  const treeSpots: readonly [number, number, number, number][] = [
    [331, 2675, 5.4, 0.62],
    [346, 2673, 6.6, 0.72],
    [365, 2670, 7.1, 0.78],
    [384, 2668, 6.2, 0.68],
    [404, 2668, 7.6, 0.82],
    [424, 2674, 5.8, 0.66],
    [462, 2719, 5.1, 0.58],
    [490, 2738, 6.4, 0.7],
    [505, 2774, 5.3, 0.62]
  ];
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(1, 1, 1, 7),
    new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 1 }),
    treeSpots.length
  );
  const crowns = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96 }),
    treeSpots.length
  );
  treeSpots.forEach(([x, z, h, spread], i) => {
    const y = map.groundTop(x, z);
    dummy.position.set(x, y + h * 0.43, z);
    dummy.rotation.set(0, hash2(i, 3, 107) * Math.PI * 2, 0);
    dummy.scale.set(spread * 0.28, h * 0.86, spread * 0.28);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x + spread * 0.55, y + h * 0.82, z);
    dummy.rotation.set(0, hash2(i, 5, 109) * Math.PI * 2, 0.08);
    dummy.scale.set(spread * 3.2, h * 0.48, spread * 2.2);
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);
    color.setHex(i % 3 === 0 ? 0x4b603a : 0x596b3c).offsetHSL(0, 0, (hash2(i, 7) - 0.5) * 0.08);
    crowns.setColorAt(i, color);
  });
  for (const mesh of [trunks, crowns]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
  }
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  group.add(shrubs, trunks, crowns);
  return group;
}

function polygonSurface(map: WorldMap, polygon: readonly CoronaXZ[]) {
  const minX = Math.floor(Math.min(...polygon.map((p) => p[0]))) - 1;
  const maxX = Math.ceil(Math.max(...polygon.map((p) => p[0]))) + 1;
  const minZ = Math.floor(Math.min(...polygon.map((p) => p[1]))) - 1;
  const maxZ = Math.ceil(Math.max(...polygon.map((p) => p[1]))) + 1;
  const step = 1.8;
  const nx = Math.ceil((maxX - minX) / step) + 1;
  const nz = Math.ceil((maxZ - minZ) / step) + 1;
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  for (let gz = 0; gz < nz; gz++) {
    const z = minZ + gz * step;
    for (let gx = 0; gx < nx; gx++) {
      const x = minX + gx * step;
      const i = gz * nx + gx;
      positions[i * 3] = x;
      positions[i * 3 + 1] = map.groundTop(x, z) + DOG_SURFACE_LIFT;
      positions[i * 3 + 2] = z;
      const shade = 0.84 + valueNoise(x, z, 8, 113) * 0.18;
      colors[i * 3] = shade;
      colors[i * 3 + 1] = shade * 0.97;
      colors[i * 3 + 2] = shade * 0.9;
    }
  }
  const indices: number[] = [];
  for (let gz = 0; gz < nz - 1; gz++) {
    for (let gx = 0; gx < nx - 1; gx++) {
      const a = gz * nx + gx;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      const centerX = minX + (gx + 0.5) * step;
      const centerZ = minZ + (gz + 0.5) * step;
      if (pointInPolygon(centerX, centerZ, polygon)) indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: 0x8a603d, vertexColors: true, roughness: 1 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "corona_dog_park_woodchip_surface";
  mesh.receiveShadow = true;
  return mesh;
}

function makeWoodchips(map: WorldMap) {
  const capacity = 340;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
    capacity
  );
  mesh.name = "corona_dog_park_woodchips";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  let count = 0;
  for (let i = 0; i < 1800 && count < capacity; i++) {
    const x = 325 + hash2(i, 3, 127) * 88;
    const z = 2677 + hash2(i, 5, 131) * 55;
    if (!pointInPolygon(x, z, CORONA_DOG_PARK)) continue;
    const length = 0.14 + hash2(i, 7, 137) * 0.34;
    dummy.position.set(x, map.groundTop(x, z) + DOG_SURFACE_LIFT + 0.04, z);
    dummy.rotation.set(0, hash2(i, 11, 139) * Math.PI * 2, (hash2(i, 13) - 0.5) * 0.2);
    dummy.scale.set(length, 0.025, 0.055 + hash2(i, 17) * 0.045);
    dummy.updateMatrix();
    mesh.setMatrixAt(count, dummy.matrix);
    color.setHex(hash2(i, 19) > 0.45 ? 0x6f492c : 0xa57a50).offsetHSL(0, 0, (hash2(i, 23) - 0.5) * 0.12);
    mesh.setColorAt(count, color);
    count++;
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function trimSegment(a: CoronaXZ, b: CoronaXZ, trimA: number, trimB: number): FencePiece | null {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  if (length <= trimA + trimB + 0.1) return null;
  const ux = dx / length;
  const uz = dz / length;
  return { ax: a[0] + ux * trimA, az: a[1] + uz * trimA, bx: b[0] - ux * trimB, bz: b[1] - uz * trimB };
}

function fencePieces() {
  const pieces: FencePiece[] = [];
  for (let i = 0; i < CORONA_DOG_PARK.length; i++) {
    const a = CORONA_DOG_PARK[i];
    const b = CORONA_DOG_PARK[(i + 1) % CORONA_DOG_PARK.length];
    const edge = trimSegment(a, b, i === 0 ? 1.1 : 0, i === CORONA_DOG_PARK.length - 1 ? 1.1 : 0);
    if (!edge) continue;
    const length = Math.hypot(edge.bx - edge.ax, edge.bz - edge.az);
    const count = Math.max(1, Math.ceil(length / 4.5));
    for (let k = 0; k < count; k++) {
      const t0 = k / count;
      const t1 = (k + 1) / count;
      pieces.push({
        ax: lerp(edge.ax, edge.bx, t0),
        az: lerp(edge.az, edge.bz, t0),
        bx: lerp(edge.ax, edge.bx, t1),
        bz: lerp(edge.az, edge.bz, t1)
      });
    }
  }
  return pieces;
}

type FenceFrame = {
  x: number;
  y: number;
  z: number;
  y0: number;
  y1: number;
  length: number;
  quat: readonly [number, number, number, number];
};

function fenceFrame(map: WorldMap, piece: FencePiece): FenceFrame {
  const dx = piece.bx - piece.ax;
  const dz = piece.bz - piece.az;
  const y0 = map.groundTop(piece.ax, piece.az);
  const y1 = map.groundTop(piece.bx, piece.bz);
  const xAxis = new THREE.Vector3(dx, y1 - y0, dz).normalize();
  const zAxis = new THREE.Vector3(-dz, 0, dx).normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  const rotation = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  const q = new THREE.Quaternion().setFromRotationMatrix(rotation);
  return {
    x: (piece.ax + piece.bx) / 2,
    y: (y0 + y1) / 2,
    z: (piece.az + piece.bz) / 2,
    y0,
    y1,
    length: Math.hypot(dx, y1 - y0, dz),
    quat: [q.x, q.y, q.z, q.w]
  };
}

function registerFenceCollider(physics: Physics, frame: FenceFrame) {
  const { x, z, length, quat } = frame;
  const y = frame.y + 0.72;
  const body = physics.world.createBox({
    type: BodyType.Static,
    position: [x, y, z],
    halfExtents: [length / 2, 0.72, 0.09],
    friction: 0.7
  });
  physics.world.setBodyTransform(body, [x, y, z], quat);
  physics.addQuerySolid(body, { x, y, z, hx: length / 2, hy: 0.72, hz: 0.09, quat });
}

function makeFence(map: WorldMap, physics: Physics) {
  const group = new THREE.Group();
  group.name = "corona_dog_park_fence";
  const pieces = fencePieces();
  const steel = new THREE.MeshStandardMaterial({ color: 0x889293, metalness: 0.58, roughness: 0.48 });
  const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.055, 0.065, 1.42, 8), steel, pieces.length + 2);
  const rails = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), steel, pieces.length * 2);
  posts.name = "corona_dog_park_fence_posts";
  rails.name = "corona_dog_park_fence_rails";
  const dummy = new THREE.Object3D();
  const postPoints: { x: number; z: number }[] = pieces.map((p) => ({ x: p.ax, z: p.az }));
  const final = pieces[pieces.length - 1];
  postPoints.push({ x: final.bx, z: final.bz });
  postPoints.push({ x: CORONA_DOG_GATE[0], z: CORONA_DOG_GATE[1] });
  postPoints.forEach((p, i) => {
    dummy.position.set(p.x, map.groundTop(p.x, p.z) + 0.71, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, i === postPoints.length - 1 ? 1.18 : 1, 1);
    dummy.updateMatrix();
    posts.setMatrixAt(i, dummy.matrix);
  });
  let railIndex = 0;
  const wirePositions: number[] = [];
  for (const piece of pieces) {
    const frame = fenceFrame(map, piece);
    for (const lift of [0.3, 1.15]) {
      dummy.position.set(frame.x, frame.y + lift, frame.z);
      dummy.quaternion.set(frame.quat[0], frame.quat[1], frame.quat[2], frame.quat[3]);
      dummy.scale.set(frame.length, 0.035, 0.035);
      dummy.updateMatrix();
      rails.setMatrixAt(railIndex++, dummy.matrix);
    }
    for (const lift of [0.52, 0.76, 0.98]) {
      wirePositions.push(piece.ax, frame.y0 + lift, piece.az, piece.bx, frame.y1 + lift, piece.bz);
    }
    wirePositions.push(piece.ax, frame.y0 + 0.28, piece.az, piece.bx, frame.y1 + 1.14, piece.bz);
    registerFenceCollider(physics, frame);
  }
  posts.instanceMatrix.needsUpdate = true;
  rails.instanceMatrix.needsUpdate = true;
  posts.castShadow = rails.castShadow = true;
  posts.receiveShadow = rails.receiveShadow = true;
  posts.frustumCulled = rails.frustumCulled = false;
  const wireGeometry = new THREE.BufferGeometry();
  wireGeometry.setAttribute("position", new THREE.Float32BufferAttribute(wirePositions, 3));
  const wire = new THREE.LineSegments(
    wireGeometry,
    new THREE.LineBasicMaterial({ color: 0x9ca5a5, transparent: true, opacity: 0.64 })
  );
  wire.name = "corona_dog_park_chainlink";
  group.add(posts, rails, wire);
  return group;
}

function addBox(
  parent: THREE.Object3D,
  material: THREE.Material,
  size: readonly [number, number, number],
  position: readonly [number, number, number]
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function makeBench(map: WorldMap, x: number, z: number, yaw: number, lift = 0) {
  const group = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x745139, roughness: 0.94 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x26312d, metalness: 0.42, roughness: 0.6 });
  addBox(group, wood, [2.35, 0.14, 0.55], [0, 0.72, 0]);
  addBox(group, wood, [2.35, 0.16, 0.18], [0, 1.12, 0.25]);
  addBox(group, wood, [2.35, 0.16, 0.18], [0, 1.42, 0.3]);
  for (const bx of [-0.82, 0.82]) {
    addBox(group, iron, [0.12, 0.72, 0.12], [bx, 0.36, -0.05]);
    addBox(group, iron, [0.12, 0.8, 0.12], [bx, 0.76, 0.28]).rotation.x = -0.12;
  }
  group.position.set(x, map.groundTop(x, z) + lift, z);
  group.rotation.y = yaw;
  return group;
}

function signTexture(title: string, subtitle: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 384;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#173b31";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#e6dfc9";
  ctx.lineWidth = 18;
  ctx.strokeRect(22, 22, canvas.width - 44, canvas.height - 44);
  ctx.fillStyle = "#f4edda";
  ctx.textAlign = "center";
  ctx.font = "700 70px system-ui, sans-serif";
  ctx.fillText(title, canvas.width / 2, 150);
  ctx.font = "600 48px system-ui, sans-serif";
  ctx.fillText(subtitle, canvas.width / 2, 235);
  ctx.font = "500 28px system-ui, sans-serif";
  ctx.fillText("OFF-LEASH · 5 AM–MIDNIGHT", canvas.width / 2, 305);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function makeDogParkSign(map: WorldMap) {
  const group = new THREE.Group();
  group.name = "corona_dog_park_sign";
  const post = new THREE.MeshStandardMaterial({ color: 0x4f493d, roughness: 0.95 });
  const board = new THREE.Mesh(new THREE.BoxGeometry(2.7, 1.35, 0.12), new THREE.MeshStandardMaterial({ color: 0x173b31, roughness: 0.82 }));
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(2.58, 1.23),
    new THREE.MeshBasicMaterial({ map: signTexture("CORONA HEIGHTS", "DOG PLAY AREA") })
  );
  addBox(group, post, [0.14, 2.2, 0.14], [-0.9, 1.1, 0]);
  addBox(group, post, [0.14, 2.2, 0.14], [0.9, 1.1, 0]);
  board.position.y = 1.65;
  board.castShadow = true;
  face.position.set(0, 1.65, -0.066);
  face.rotation.y = Math.PI;
  group.add(board, face);
  group.position.set(
    CORONA_DOG_GATE[0] - 0.8,
    map.groundTop(CORONA_DOG_GATE[0] - 0.8, CORONA_DOG_GATE[1] + 0.4) + DOG_SURFACE_LIFT,
    CORONA_DOG_GATE[1] + 0.4
  );
  group.rotation.y = -0.95;
  return group;
}

function makeDogPark(map: WorldMap, physics: Physics) {
  const group = new THREE.Group();
  group.name = "corona_heights_dog_park";
  group.add(polygonSurface(map, CORONA_DOG_PARK));
  group.add(makeWoodchips(map));
  group.add(makeFence(map, physics));
  group.add(makeDogParkSign(map));
  group.add(makeBench(map, 350.1, 2703.4, -0.68, DOG_SURFACE_LIFT));
  group.add(makeBench(map, 353.1, 2720.6, -1.02, DOG_SURFACE_LIFT));
  const bin = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.38, 0.9, 10),
    new THREE.MeshStandardMaterial({ color: 0x34443d, metalness: 0.35, roughness: 0.62 })
  );
  bin.position.set(331, map.groundTop(331, 2723) + DOG_SURFACE_LIFT + 0.45, 2723);
  bin.castShadow = true;
  group.add(bin);
  const fountainMat = new THREE.MeshStandardMaterial({ color: 0x65716b, metalness: 0.66, roughness: 0.42 });
  const fountain = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 0.92, 10), fountainMat);
  fountain.position.set(328.1, map.groundTop(328.1, 2730.2) + DOG_SURFACE_LIFT + 0.46, 2730.2);
  fountain.castShadow = true;
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.28, 0.1, 14), fountainMat);
  bowl.position.set(331.4, map.groundTop(331.4, 2722.2) + DOG_SURFACE_LIFT + 0.09, 2722.2);
  bowl.castShadow = true;
  group.add(fountain, bowl);
  return group;
}

function dogMesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function makeDog(style: DogStyle): ParkDog {
  const group = new THREE.Group();
  group.name = `corona_dog_${style.name}`;
  group.scale.setScalar(style.scale);
  const coat = new THREE.MeshLambertMaterial({ color: style.coat });
  const accent = new THREE.MeshLambertMaterial({ color: style.accent });
  const dark = new THREE.MeshLambertMaterial({ color: 0x171512 });
  const collar = new THREE.MeshStandardMaterial({ color: style.collar, roughness: 0.55, metalness: 0.25 });
  const body = dogMesh(group, new THREE.SphereGeometry(1, 11, 8), coat, 0, 0.72, 0);
  body.scale.set(0.38, 0.34, style.longBody ? 0.82 : 0.69);
  const chest = dogMesh(group, new THREE.SphereGeometry(1, 9, 7), accent, 0, 0.75, -0.42);
  chest.scale.set(0.31, 0.38, 0.3);
  const head = new THREE.Group();
  head.position.set(0, 0.93, -0.65);
  group.add(head);
  const skull = dogMesh(head, new THREE.SphereGeometry(1, 10, 8), coat, 0, 0, 0);
  skull.scale.set(0.32, 0.3, 0.32);
  const muzzle = dogMesh(head, new THREE.SphereGeometry(1, 8, 6), accent, 0, -0.08, -0.3);
  muzzle.scale.set(0.22, 0.16, 0.28);
  const nose = dogMesh(head, new THREE.SphereGeometry(1, 7, 5), dark, 0, -0.04, -0.53);
  nose.scale.set(0.1, 0.08, 0.08);
  for (const side of [-1, 1]) {
    const eye = dogMesh(head, new THREE.SphereGeometry(1, 6, 4), dark, side * 0.13, 0.08, -0.27);
    eye.scale.setScalar(0.045);
    const ear = dogMesh(head, new THREE.ConeGeometry(style.floppy ? 0.15 : 0.12, style.floppy ? 0.34 : 0.29, 5), coat, side * 0.23, 0.2, -0.02);
    ear.rotation.z = side * (style.floppy ? 1.05 : 0.2);
    ear.rotation.x = style.floppy ? -0.2 : Math.PI;
  }
  const collarMesh = dogMesh(head, new THREE.TorusGeometry(0.25, 0.035, 6, 14), collar, 0, -0.16, 0.11);
  collarMesh.rotation.x = Math.PI / 2;

  const legs: THREE.Group[] = [];
  for (const x of [-0.22, 0.22]) {
    for (const z of [-0.38, 0.4]) {
      const leg = new THREE.Group();
      leg.position.set(x, 0.61, z);
      const limb = dogMesh(leg, new THREE.BoxGeometry(0.13, 0.5, 0.14), z < 0 ? accent : coat, 0, -0.25, 0);
      limb.rotation.z = x * 0.04;
      const paw = dogMesh(leg, new THREE.BoxGeometry(0.16, 0.1, 0.23), accent, 0, -0.5, -0.04);
      paw.position.z = -0.05;
      group.add(leg);
      legs.push(leg);
    }
  }
  const tail = new THREE.Group();
  tail.position.set(0, 0.8, 0.63);
  const tailMesh = dogMesh(tail, new THREE.CylinderGeometry(0.055, 0.1, 0.62, 7), coat, 0, 0.27, 0);
  tailMesh.rotation.z = 0.08;
  tail.rotation.x = 0.9;
  group.add(tail);
  return { style, group, legs, head, tail, x: 370, z: 2702, heading: 0, stride: 0, speed: 0 };
}

function ownerFacing(x: number, z: number, tx: number, tz: number) {
  return Math.atan2(-(tx - x), -(tz - z));
}

function makeOwner(map: WorldMap, action: OwnerAction, x: number, z: number, tx: number, tz: number, seed: string) {
  const rig = buildRig(avatarFromSeed(seed));
  rig.group.name = `corona_owner_${action}`;
  rig.group.scale.setScalar(1.04);
  const facing = ownerFacing(x, z, tx, tz);
  rig.group.position.set(x, map.groundTop(x, z) + DOG_SURFACE_LIFT + 0.93, z);
  rig.group.rotation.y = facing;
  return { action, rig, x, z, facing } satisfies ParkOwner;
}

function throwArmPose(owner: ParkOwner, elapsed: number, phase: number) {
  poseIdle(owner.rig, elapsed);
  const windup = smooth01((phase - 0.02) / 0.1) * (1 - smooth01((phase - 0.12) / 0.08));
  const release = smooth01((phase - 0.12) / 0.07) * (1 - smooth01((phase - 0.24) / 0.12));
  owner.rig.armR.rotation.x += -0.9 * windup + 1.55 * release;
  owner.rig.foreR.rotation.x = 0.25 + 0.75 * windup - 0.36 * release;
  owner.rig.torso.rotation.y += 0.3 * windup - 0.42 * release;
  owner.rig.head.rotation.y -= 0.18 * release;
}

function placeOwner(map: WorldMap, owner: ParkOwner, elapsed: number, phase: number) {
  owner.rig.group.position.set(owner.x, map.groundTop(owner.x, owner.z) + DOG_SURFACE_LIFT + 0.93, owner.z);
  owner.rig.group.rotation.y = owner.facing;
  if (owner.action === "watch") {
    poseIdle(owner.rig, elapsed);
    owner.rig.head.rotation.y += Math.sin(elapsed * 0.42) * 0.28;
  } else {
    throwArmPose(owner, elapsed, phase);
  }
}

function moveDog(map: WorldMap, dog: ParkDog, tx: number, tz: number, dt: number) {
  const dx = tx - dog.x;
  const dz = tz - dog.z;
  const d = Math.hypot(dx, dz);
  const maxSpeed = 11.8 / dog.style.scale;
  const step = Math.min(d, maxSpeed * Math.min(dt, 0.08));
  let vx = 0;
  let vz = 0;
  if (d > 0.025) {
    vx = (dx / d) * step;
    vz = (dz / d) * step;
    dog.x += vx;
    dog.z += vz;
    dog.heading = Math.atan2(-vx, -vz);
  }
  dog.speed = dt > 1e-4 ? step / dt : 0;
  dog.stride += step * 4.6;
  dog.group.position.set(dog.x, map.groundTop(dog.x, dog.z) + DOG_SURFACE_LIFT + 0.04, dog.z);
  dog.group.rotation.y = dog.heading;
  dog.group.position.y += Math.abs(Math.sin(dog.stride * 0.5)) * Math.min(0.08, dog.speed * 0.012) * dog.style.scale;
  const swing = Math.sin(dog.stride) * Math.min(0.85, dog.speed * 0.15);
  dog.legs[0].rotation.x = swing;
  dog.legs[1].rotation.x = -swing;
  dog.legs[2].rotation.x = -swing;
  dog.legs[3].rotation.x = swing;
  dog.head.rotation.x = -0.05 + Math.sin(dog.stride * 2) * Math.min(0.08, dog.speed * 0.012);
  dog.tail.rotation.y = Math.sin(dog.stride * 0.72) * 0.72;
  dog.tail.rotation.x = 0.82 + Math.sin(dog.stride * 0.31) * 0.12;
}

function fetchTarget(phase: number, owner: CoronaXZ, landing: CoronaXZ, waiting: CoronaXZ) {
  if (phase < 0.12) return waiting;
  if (phase < 0.54) return landing;
  if (phase < 0.94) return owner;
  return waiting;
}

function dogMouth(dog: ParkDog, out: THREE.Vector3) {
  const scale = dog.style.scale;
  out.set(
    dog.x - Math.sin(dog.heading) * 0.84 * scale,
    dog.group.position.y + 0.82 * scale,
    dog.z - Math.cos(dog.heading) * 0.84 * scale
  );
  return out;
}

export class CoronaHeightsPark {
  readonly group = new THREE.Group();
  readonly activity = new THREE.Group();
  readonly foliage = new THREE.Group();
  readonly dogs: ParkDog[];
  readonly owners: ParkOwner[];
  readonly stats: CoronaHeightsStats;
  readonly summit = CORONA_HEIGHTS_SUMMIT;

  #map: WorldMap;
  #ball: THREE.Mesh;
  #frisbee: THREE.Mesh;
  #mouth = new THREE.Vector3();

  constructor(map: WorldMap, physics: Physics) {
    this.#map = map;
    this.group.name = "corona_heights_park";
    this.activity.name = "corona_heights_dog_activity";
    this.foliage.name = "corona_heights_foliage";

    this.group.add(makeHillSkin(map));
    this.group.add(makeQuarryFace(map));
    this.group.add(makeTrails(map));
    this.group.add(makeRockField(map, physics));
    this.foliage.add(makeHillGrass(map), makeWildflowers(map), makeShrubsAndTrees(map));
    this.group.add(this.foliage);
    this.group.add(makeDogPark(map, physics));
    this.group.add(makeBench(map, 430, 2751, Math.PI * 0.44));

    this.dogs = [
      makeDog({ name: "golden", coat: 0xb97835, accent: 0xe4bb72, collar: 0x2f86b6, scale: 1.12, floppy: true }),
      makeDog({ name: "border_collie", coat: 0x24201d, accent: 0xf0e8db, collar: 0xd84f43, scale: 1.0, longBody: true }),
      makeDog({ name: "terrier", coat: 0xb7a58d, accent: 0xeee1ce, collar: 0x48a96b, scale: 0.78 }),
      makeDog({ name: "corgi", coat: 0xb96429, accent: 0xf2e3cc, collar: 0x7f5ac9, scale: 0.82, longBody: true })
    ];
    const initial: readonly CoronaXZ[] = [[350, 2715], [394, 2698], [366, 2696], [380, 2707]];
    this.dogs.forEach((dog, i) => {
      dog.x = initial[i][0];
      dog.z = initial[i][1];
      dog.group.position.set(dog.x, map.groundTop(dog.x, dog.z) + DOG_SURFACE_LIFT + 0.04, dog.z);
      this.activity.add(dog.group);
    });

    this.owners = [
      makeOwner(map, "ball", 342, 2717, 366, 2708, "corona-ball-owner"),
      makeOwner(map, "frisbee", 399, 2687, 378, 2700, "corona-frisbee-owner"),
      makeOwner(map, "watch", 372, 2711, 372, 2700, "corona-watching-owner")
    ];
    for (const owner of this.owners) this.activity.add(owner.rig.group);

    this.#ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0xb9ef31, roughness: 0.62 })
    );
    this.#ball.name = "corona_tennis_ball";
    this.#ball.castShadow = true;
    this.#frisbee = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 0.055, 20),
      new THREE.MeshStandardMaterial({ color: 0xff654a, roughness: 0.68 })
    );
    this.#frisbee.name = "corona_frisbee";
    this.#frisbee.castShadow = true;
    this.activity.add(this.#ball, this.#frisbee);
    this.group.add(this.activity);
    this.stats = { dogs: this.dogs.length, owners: this.owners.length, summit: CORONA_HEIGHTS_SUMMIT };
  }

  setFoliageVisible(visible: boolean) {
    this.foliage.visible = visible;
  }

  update(dt: number, elapsed: number, viewPos: { x: number; z: number }) {
    const distance = Math.hypot(viewPos.x - CORONA_HEIGHTS_SUMMIT.x, viewPos.z - CORONA_HEIGHTS_SUMMIT.z);
    this.group.visible = distance < DETAIL_RANGE;
    if (!this.group.visible) return;
    this.activity.visible = distance < ACTIVITY_RANGE;
    if (!this.activity.visible) return;

    const ballPhase = ((elapsed + 0.35) % 6.2) / 6.2;
    const frisbeePhase = ((elapsed + 2.1) % 6.35) / 6.35;
    placeOwner(this.#map, this.owners[0], elapsed, ballPhase);
    placeOwner(this.#map, this.owners[1], elapsed, frisbeePhase);
    placeOwner(this.#map, this.owners[2], elapsed, 0);

    const ballOwner: CoronaXZ = [this.owners[0].x, this.owners[0].z];
    const frisbeeOwner: CoronaXZ = [this.owners[1].x, this.owners[1].z];
    const ballLanding: CoronaXZ = [366, 2708];
    const frisbeeLanding: CoronaXZ = [378, 2700];
    const ballTarget = fetchTarget(ballPhase, ballOwner, ballLanding, [349, 2714]);
    const frisbeeTarget = fetchTarget(frisbeePhase, frisbeeOwner, frisbeeLanding, [393, 2691]);
    moveDog(this.#map, this.dogs[0], ballTarget[0], ballTarget[1], dt);
    moveDog(this.#map, this.dogs[1], frisbeeTarget[0], frisbeeTarget[1], dt);
    moveDog(this.#map, this.dogs[2], 370 + Math.cos(elapsed * 0.72) * 17, 2701 + Math.sin(elapsed * 0.72) * 9, dt);
    moveDog(this.#map, this.dogs[3], 374 + Math.sin(elapsed * 0.88) * 15, 2701 + Math.sin(elapsed * 1.76) * 7.2, dt);

    this.#updateBall(ballPhase, ballOwner, ballLanding, this.dogs[0]);
    this.#updateFrisbee(frisbeePhase, frisbeeOwner, frisbeeLanding, this.dogs[1], elapsed);
  }

  #updateBall(phase: number, owner: CoronaXZ, landing: CoronaXZ, dog: ParkDog) {
    const ownerY = this.#map.groundTop(owner[0], owner[1]) + DOG_SURFACE_LIFT + 1.58;
    if (phase < 0.14) {
      this.#ball.position.set(owner[0] - 0.35, ownerY, owner[1] - 0.45);
    } else if (phase < 0.34) {
      const t = (phase - 0.14) / 0.2;
      this.#ball.position.set(
        lerp(owner[0], landing[0], t),
        lerp(ownerY, this.#map.groundTop(landing[0], landing[1]) + DOG_SURFACE_LIFT + 0.17, t) + Math.sin(t * Math.PI) * 5.2,
        lerp(owner[1], landing[1], t)
      );
    } else if (phase < 0.54) {
      this.#ball.position.set(landing[0], this.#map.groundTop(landing[0], landing[1]) + DOG_SURFACE_LIFT + 0.17, landing[1]);
    } else if (phase < 0.94) {
      this.#ball.position.copy(dogMouth(dog, this.#mouth));
    } else {
      this.#ball.position.set(owner[0] - 0.35, ownerY, owner[1] - 0.45);
    }
  }

  #updateFrisbee(phase: number, owner: CoronaXZ, landing: CoronaXZ, dog: ParkDog, elapsed: number) {
    const ownerY = this.#map.groundTop(owner[0], owner[1]) + DOG_SURFACE_LIFT + 1.64;
    if (phase < 0.13) {
      this.#frisbee.position.set(owner[0] + 0.35, ownerY, owner[1] + 0.3);
    } else if (phase < 0.34) {
      const t = (phase - 0.13) / 0.21;
      this.#frisbee.position.set(
        lerp(owner[0], landing[0], t),
        lerp(ownerY, this.#map.groundTop(landing[0], landing[1]) + DOG_SURFACE_LIFT + 0.28, t) + Math.sin(t * Math.PI) * 3.6,
        lerp(owner[1], landing[1], t)
      );
    } else if (phase < 0.54) {
      this.#frisbee.position.set(landing[0], this.#map.groundTop(landing[0], landing[1]) + DOG_SURFACE_LIFT + 0.24, landing[1]);
    } else if (phase < 0.94) {
      this.#frisbee.position.copy(dogMouth(dog, this.#mouth));
    } else {
      this.#frisbee.position.set(owner[0] + 0.35, ownerY, owner[1] + 0.3);
    }
    this.#frisbee.rotation.set(0.25 + Math.sin(elapsed * 2.7) * 0.1, elapsed * 9.5, 0.18);
  }
}
